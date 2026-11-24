import {
  NodeApiError,
  NodeConnectionTypes,
  NodeOperationError,
  type INodeExecutionData,
  type INodeType,
  type INodeTypeDescription,
  type IPollFunctions,
  type JsonObject,
} from "n8n-workflow";

import {
  JoboApiError,
  JoboError,
  JoboTransportError,
  MIN_POLL_INTERVAL_SECONDS,
  SIGNAL_MAX_LIMIT,
  assertHasNarrowingSignalFilter,
  pollSignals,
  shouldSkipPoll,
  type HiringSignalFilters,
  type SignalPollState,
} from "@jobo-ai/connector-core";

import { joboClient } from "./transport";
import {
  DEFAULT_MIN_INTERVAL_MINUTES,
  MIN_INTERVAL_OPTIONS,
  NARROWING_SIGNAL_FILTER_LABELS,
  SIGNAL_COLLECTIONS,
  signalFilterCollections,
} from "./descriptions";
import { ParameterError, TRIGGER_SIGNAL_FILTER_KEYS, buildSignalFilters } from "./params";
import { signalApiError, signalItem } from "./signals";

/**
 * "Fetch Test Event" sample: the newest few signals stored in the last week.
 * Signals are detected once a day, so an hour, as the Jobo Trigger uses for
 * jobs, would usually be empty. Kept small because every signal is billed.
 */
const SAMPLE_LOOKBACK_DAYS = 7;
const SAMPLE_SIZE = 5;

/**
 * Max Signals per Poll. The ceiling is five full pages of 200: at most five
 * requests a tick, well inside the 20-a-minute limit without a subscription,
 * and one poll's bill bounded at the same 1,000 signals as Return All on the
 * Jobo node. What is left arrives on the next polls.
 */
const DEFAULT_MAX_SIGNALS = 50;
const MAX_PAGES_PER_POLL = 5;
const MAX_SIGNALS_CEILING = SIGNAL_MAX_LIMIT * MAX_PAGES_PER_POLL;

/** Static-data keys. The last-polled stamp is kept apart from the poll state: see `poll()`. */
const STATE_KEY = "joboSignalPollState";
const LAST_POLLED_AT_KEY = "joboLastPolledAt";

const NARROWING_LIST = NARROWING_SIGNAL_FILTER_LABELS.join(", ");

export class JoboHiringSignalTrigger implements INodeType {
  description: INodeTypeDescription = {
    displayName: "Jobo Hiring Signal Trigger",
    name: "joboHiringSignalTrigger",
    // The same themed pair as the Jobo nodes: SVG, because n8n's verification
    // lint rejects raster node icons, and two distinct files, because it
    // rejects a pair pointing at the same one.
    icon: { light: "file:jobo.svg", dark: "file:jobo-dark.svg" },
    group: ["trigger"],
    version: 1,
    subtitle: '={{"New hiring signal matching filters"}}',
    description:
      "Starts the workflow when Jobo detects a new hiring signal matching your filters: a hiring surge, a first job in a new country, a leadership search, a new technology, a slowdown",
    defaults: { name: "Jobo Hiring Signal Trigger" },
    polling: true,
    // No `usableAsTool`: the verification lint rejects it on trigger nodes.
    inputs: [],
    outputs: [NodeConnectionTypes.Main],
    credentials: [{ name: "joboApi", required: true }],
    properties: [
      {
        // Built from connector-core's narrowing flags, so the list cannot drift.
        displayName: `At least one narrowing filter is required: ${NARROWING_LIST}. Every signal delivered is billed at ten times the price of a job: your plan's included signals first, then your wallet, with no per-signal charge on Unlimited. Each signal is read, and billed, once: a poll asks only for signals stored after the last one it delivered, and a poll that finds nothing new costs nothing. Jobo checks at most once per Minimum Interval below, so setting Poll Times faster than that changes nothing.`,
        name: "costNotice",
        type: "notice",
        default: "",
      },
      {
        displayName: "Minimum Interval",
        name: "minIntervalMinutes",
        type: "options",
        options: [...MIN_INTERVAL_OPTIONS],
        default: DEFAULT_MIN_INTERVAL_MINUTES,
        description:
          "How often this trigger may actually call the Jobo API. n8n's own Poll Times setting above defaults to every minute; ticks that arrive sooner than this are skipped without a request. New signals are never missed: a poll returns everything stored since the previous one, however long ago that was.",
      },
      {
        displayName: "Max Signals per Poll",
        name: "maxSignalsPerPoll",
        type: "number",
        typeOptions: { minValue: 1, maxValue: MAX_SIGNALS_CEILING },
        default: DEFAULT_MAX_SIGNALS,
        description: `The most signals one poll delivers, and so the most it is billed for, up to ${MAX_SIGNALS_CEILING.toLocaleString("en-US")}. Signals arrive in the order Jobo stored them, oldest first; when more are new, the rest arrive on the next polls.`,
      },
      // created_after is deliberately absent: the poller owns it, and a
      // user-supplied value would fight the incremental sync.
      ...signalFilterCollections({}, TRIGGER_SIGNAL_FILTER_KEYS),
    ],
  };

  async poll(this: IPollFunctions): Promise<INodeExecutionData[][] | null> {
    // A 429 is not retried inside a tick: the state is untouched, so the next
    // tick reads the same window, and retrying only adds load to the limiter
    // that just said no.
    const client = await joboClient(this, { retry: { retryRateLimit: false } });

    let filters: HiringSignalFilters;
    try {
      filters = buildSignalFilters(
        SIGNAL_COLLECTIONS.map((c) => this.getNodeParameter(c.name, {}) as Record<string, unknown>),
        TRIGGER_SIGNAL_FILTER_KEYS,
      );
    } catch (error) {
      throw toSignalPollError(this, error);
    }

    // Workflow static data is the only durable store a trigger has; the
    // watermark must live here, or every poll would read, and bill, the same
    // signals again. It is the last signal's created_at as the API sent it:
    // n8n stores static data as JSON, so the string comes back unchanged.
    const staticData = this.getWorkflowStaticData("node") as {
      [STATE_KEY]?: SignalPollState;
      [LAST_POLLED_AT_KEY]?: string;
    };
    const state: SignalPollState = staticData[STATE_KEY] ?? { watermark: null };

    // Manual run: a small recent sample, so the editor shows real data. It is
    // billed, and it saves nothing: the watermark belongs to production polls.
    // It reads the default order, newest detection day first, because a
    // sample should be recent; production polls read the stored order.
    // The empty case is thrown after the try, because the verification lint
    // forbids re-throwing a caught error.
    if (this.getMode() === "manual") {
      let sample: INodeExecutionData[];
      try {
        assertHasNarrowingSignalFilter(filters as Record<string, unknown>);
        const since = new Date(Date.now() - SAMPLE_LOOKBACK_DAYS * 86_400_000).toISOString();
        const { data } = await client.listSignals({ ...filters, created_after: since }, { limit: SAMPLE_SIZE });
        sample = (data.signals ?? []).slice(0, SAMPLE_SIZE).map((signal) => ({ json: signalItem(signal) }));
      } catch (error) {
        throw toSignalPollError(this, error);
      }

      if (sample.length === 0) {
        throw new NodeOperationError(
          this.getNode(),
          `No hiring signals matching these filters were found in the last ${SAMPLE_LOOKBACK_DAYS} days`,
          {
            description:
              "The filters are valid; the sample window is simply empty. Broaden them to preview data here, or activate the workflow: a production poll returns every matching signal stored since the previous one.",
          },
        );
      }
      return [sample];
    }

    // The interval the user chose, since n8n's Poll Times defaults to every
    // minute. A skipped tick makes no request and touches no state.
    const minIntervalMinutes = this.getNodeParameter("minIntervalMinutes", DEFAULT_MIN_INTERVAL_MINUTES) as number;
    const minIntervalSeconds = Math.max(MIN_POLL_INTERVAL_SECONDS, minIntervalMinutes * 60);
    if (shouldSkipPoll(staticData[LAST_POLLED_AT_KEY], minIntervalSeconds, new Date())) {
      this.logger.debug(
        `Jobo: skipping this tick — the minimum interval of ${minIntervalMinutes} minute(s) has not elapsed`,
      );
      return null;
    }

    // Stamped before the request and outside the poll state, as on the Jobo
    // Trigger: the state is assigned only on success, but an erroring trigger
    // must still wait out its interval rather than call the API every minute.
    staticData[LAST_POLLED_AT_KEY] = new Date().toISOString();

    const requested = Number(this.getNodeParameter("maxSignalsPerPoll", DEFAULT_MAX_SIGNALS));
    const maxSignals = Math.min(MAX_SIGNALS_CEILING, Math.max(1, Math.floor(requested) || DEFAULT_MAX_SIGNALS));

    try {
      const result = await pollSignals(client, filters, state, {
        pageSize: Math.min(SIGNAL_MAX_LIMIT, maxSignals),
        maxSignals,
      });
      // Assigned only here, after a poll that succeeded. n8n writes static
      // data when the poll emits, so the state and the signals it delivers are
      // saved together; a failed poll leaves the previous state in place.
      staticData[STATE_KEY] = result.state;

      // Seeding run: records a starting point, reads nothing, and is exempt
      // from the interval, so the first real poll is not an hour away.
      if (result.seeded) {
        delete staticData[LAST_POLLED_AT_KEY];
        return null;
      }

      const spent = result.usage.reduce((sum, u) => sum + (u.creditsDeducted ?? 0), 0);
      if (result.signals.length > 0 || spent > 0) {
        const latestUsage = result.usage[result.usage.length - 1];
        const balance = latestUsage?.creditsBalance;
        const quotaRemaining = latestUsage?.quotaRemaining;
        const quotaLimit = latestUsage?.quotaLimit;
        this.logger.info(
          `Jobo: ${result.signals.length} new hiring signal(s) over ${result.requests} request(s); ${spent} credits spent` +
            (balance != null ? `, wallet ${balance} credits` : "") +
            (quotaRemaining != null
              ? `, included signals ${quotaRemaining}${quotaLimit != null ? `/${quotaLimit}` : ""} remaining`
              : "") +
            (result.backlog ? `; more stopped at Max Signals per Poll (${maxSignals}) and arrive on the next polls` : ""),
        );
      }

      if (result.signals.length === 0) return null;
      return [result.signals.map((signal) => ({ json: signalItem(signal) }))];
    } catch (error) {
      throw toSignalPollError(this, error);
    }
  }
}

/**
 * Map a poll failure onto an n8n error. Returns rather than throws, so callers
 * write `throw toSignalPollError(...)`: the verification lint rejects
 * re-throwing a caught error.
 */
function toSignalPollError(ctx: IPollFunctions, error: unknown) {
  const node = ctx.getNode();
  // Refused before any request: a filter value the API would not take.
  if (
    error instanceof ParameterError ||
    (error instanceof JoboError && !(error instanceof JoboApiError) && !(error instanceof JoboTransportError))
  ) {
    return new NodeOperationError(node, error.message, {
      description: "Nothing was sent to Jobo. Check the trigger's filters.",
    });
  }
  // connector-core raises the narrowing guard as a plain Error.
  if (error instanceof Error && !(error instanceof JoboError) && /narrowing filter/i.test(error.message)) {
    return new NodeOperationError(node, error.message, {
      description: `Add at least one of: ${NARROWING_LIST}. A strength or date bound alone does not count.`,
    });
  }
  const signalError = signalApiError(node, error);
  if (signalError) return signalError;
  return new NodeApiError(node, error as JsonObject);
}
