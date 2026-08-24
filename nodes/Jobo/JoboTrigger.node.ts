import {
  NodeApiError,
  NodeConnectionTypes,
  NodeOperationError,
  type IDataObject,
  type INodeExecutionData,
  type INodeType,
  type INodeTypeDescription,
  type IPollFunctions,
  type JsonObject,
} from "n8n-workflow";

import {
  EMPLOYMENT_TYPES,
  EXPERIENCE_LEVELS,
  InsufficientCreditsError,
  MIN_POLL_INTERVAL_SECONDS,
  WORK_MODELS,
  WindowOverflowError,
  assertHasNarrowingFilter,
  poll,
  shouldSkipPoll,
  type JobSearchParams,
  type PollState,
} from "@jobo-ai/connector-core";

import { joboClient } from "./transport";
import { listSearch, loadOptions, resourceLocatorValue } from "./methods";

const optionsFrom = (values: readonly string[]) =>
  values.map((value) => ({ name: value.replace(/(^|-)([a-z])/g, (m) => m.toUpperCase()), value }));

/**
 * "Fetch Test Event" preview window. n8n discards workflow static data for
 * manual executions, so a manual run always starts at `watermark === null` and
 * can never advance past the seeding branch — erroring there would mean the
 * button never shows data, which is both a poor first impression and contrary
 * to how every core polling trigger behaves.
 */
const SAMPLE_LOOKBACK_SECONDS = 3600;
const SAMPLE_PAGE_SIZE = 25;

/**
 * The floor the node actually honours, as offered in the UI.
 *
 * n8n injects its own Poll Times property into every polling node with a
 * hard-coded "Every Minute" default, and a node cannot narrow that list or
 * change that default — so a trigger nobody configured fires 1,440 times a day.
 * Search is metered per job returned, so this costs nothing extra, but the
 * requests are real. This field is where the interval is genuinely settled; a
 * tick arriving early is skipped without making a request.
 *
 * The lowest option matches `MIN_POLL_INTERVAL_SECONDS`; connector-core clamps
 * anything below it regardless.
 */
const MIN_INTERVAL_OPTIONS = [
  { name: "Every 15 Minutes", value: 15 },
  { name: "Every 30 Minutes", value: 30 },
  { name: "Every Hour", value: 60 },
  { name: "Every 6 Hours", value: 360 },
  { name: "Every 24 Hours", value: 1440 },
] as const;

const DEFAULT_MIN_INTERVAL_MINUTES = 60;

/** Static-data key for the last *attempted* poll. See `poll()` for why it is separate. */
const LAST_POLLED_AT_KEY = "joboLastPolledAt";

export class JoboTrigger implements INodeType {
  description: INodeTypeDescription = {
    displayName: "Jobo Trigger",
    name: "joboTrigger",
    // SVG, not PNG: n8n's verification lint rejects raster node icons. The two
    // themed variants must be distinct files (the lint rejects a pair pointing
    // at the same one); jobo-dark.svg lifts the gradient's cool end and adds a
    // hairline so the squircle does not dissolve into a dark canvas.
    icon: { light: "file:jobo.svg", dark: "file:jobo-dark.svg" },
    group: ["trigger"],
    version: 1,
    subtitle: '={{"New job matching filters"}}',
    description: "Starts the workflow when a new job matching your filters is indexed",
    defaults: { name: "Jobo Trigger" },
    polling: true,
    // Inert on a trigger — n8n only exposes non-trigger nodes to agents — but
    // the property is `true | UsableAsToolDescription`, so `true` is the only
    // way to satisfy `@n8n/community-nodes/node-usable-as-tool`.
    usableAsTool: true,
    inputs: [],
    outputs: [NodeConnectionTypes.Main],
    credentials: [{ name: "joboApi", required: true }],
    properties: [
      {
        // The filter names here are exactly connector-core's
        // NARROWING_FILTER_KEYS — keep the two in sync.
        displayName:
          "At least one narrowing filter is required: q, location, sources, skills, or industries. Jobs use your plan's included jobs first, then the pay-as-you-go rate ($3.00 per 1,000 jobs); cost depends on matches, not poll frequency. Jobo checks at most once per Minimum Interval below, so setting Poll Times faster than that changes nothing.",
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
          "How often this trigger may actually call the Jobo API. n8n's own Poll Times setting above defaults to every minute; ticks that arrive sooner than this are skipped without a request. New jobs are never missed — a poll returns everything indexed since the previous one, however long ago that was.",
      },
      {
        displayName: "Query",
        name: "q",
        type: "string",
        default: "",
        placeholder: "e.g. senior rust engineer",
        description: "Free-text search across job title and description",
      },
      // Top-level rather than inside the Filters collection, matching the Jobo
      // node: a resourceLocator inside a `collection` renders inconsistently
      // across n8n versions.
      {
        displayName: "Location",
        name: "location",
        type: "resourceLocator",
        default: { mode: "list", value: "" },
        description: "Only jobs in this location. Leave empty to match everywhere.",
        modes: [
          {
            displayName: "From List",
            name: "list",
            type: "list",
            placeholder: "Search for a city or region…",
            typeOptions: { searchListMethod: "searchLocations", searchable: true },
          },
          {
            displayName: "By Name",
            name: "name",
            type: "string",
            placeholder: 'e.g. "Berlin, Germany" or "Remote"',
          },
        ],
      },
      // discovered_after / discovered_before are deliberately absent: the poll
      // watermark owns discovered_after, and a user-supplied value would fight
      // the incremental sync.
      {
        displayName: "Filters",
        name: "filters",
        type: "collection",
        placeholder: "Add Filter",
        default: {},
        options: [
          {
            displayName: "Employment Type",
            name: "employment_type",
            type: "multiOptions",
            options: optionsFrom(EMPLOYMENT_TYPES),
            default: [],
          },
          {
            displayName: "Experience Level",
            name: "experience_level",
            type: "multiOptions",
            options: optionsFrom(EXPERIENCE_LEVELS),
            default: [],
          },
          {
            displayName: "Industry Names or IDs",
            name: "industries",
            type: "multiOptions",
            typeOptions: { loadOptionsMethod: "getIndustries" },
            default: [],
            description:
              'Restrict to companies in specific industries. Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
          },
          {
            displayName: "Max Salary (USD)",
            name: "max_salary_usd",
            type: "number",
            default: 0,
            description: "Only matches jobs whose employer published a salary range",
          },
          {
            displayName: "Min Salary (USD)",
            name: "min_salary_usd",
            type: "number",
            default: 0,
            description: "Only matches jobs whose employer published a salary range",
          },
          {
            displayName: "Posted After",
            name: "posted_after",
            type: "dateTime",
            default: "",
            description: "Only jobs the employer posted on or after this time",
          },
          {
            displayName: "Search Descriptions",
            name: "search_description",
            type: "boolean",
            default: true,
            description:
              "Whether to match the query against full job descriptions as well as titles. Turn this off for title-only matching.",
          },
          {
            displayName: "Skills",
            name: "skills",
            type: "string",
            typeOptions: { multipleValues: true, multipleValueButtonText: "Add skill" },
            default: [],
            description: "Require one or more skills, e.g. Python, Kubernetes",
          },
          {
            displayName: "Source Names or IDs",
            name: "sources",
            type: "multiOptions",
            typeOptions: { loadOptionsMethod: "getSources" },
            default: [],
            description:
              'Restrict to specific ATS sources, e.g. greenhouse, lever_co, ashby. Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
          },
          {
            displayName: "Work Model",
            name: "work_model",
            type: "multiOptions",
            options: optionsFrom(WORK_MODELS),
            default: [],
          },
        ],
      },
    ],
  };

  methods = { loadOptions, listSearch };

  async poll(this: IPollFunctions): Promise<INodeExecutionData[][] | null> {
    // 429 is not worth retrying here. connector-core would spend three requests
    // to learn what the first already said, and the caller loses nothing by
    // stopping: the watermark is untouched, so the next tick re-queries the
    // same window. Retrying only adds load to the limiter that just said no.
    const client = await joboClient(this, { retry: { retryRateLimit: false } });

    const raw = this.getNodeParameter("filters", {}) as Record<string, unknown>;
    const filters: JobSearchParams = {
      q: (this.getNodeParameter("q", "") as string) || undefined,
      location: resourceLocatorValue(this.getNodeParameter("location", "")),
      sources: list(raw.sources),
      work_model: list(raw.work_model),
      employment_type: list(raw.employment_type),
      experience_level: list(raw.experience_level),
      skills: list(raw.skills),
      industries: list(raw.industries),
      min_salary_usd: positive(raw.min_salary_usd),
      max_salary_usd: positive(raw.max_salary_usd),
      posted_after: (raw.posted_after as string) || undefined,
      // true is the API default, so only the non-default is worth sending.
      search_description: raw.search_description === false ? false : undefined,
    };

    // Workflow static data is the only durable store a trigger has. The
    // watermark MUST live here rather than being recomputed as "now minus one
    // interval" — a window that never advances re-bills the same jobs on every
    // tick, and it looks correct while testing because the results are right.
    const staticData = this.getWorkflowStaticData("node") as {
      joboPollState?: PollState;
      [LAST_POLLED_AT_KEY]?: string;
    };
    const state: PollState = staticData.joboPollState ?? { watermark: null, seenIds: [] };

    // Manual run: return a bounded recent sample so the editor shows real data,
    // and persist nothing — the production watermark must stay owned by
    // production polls. Deliberately not routed through `poll()`: that would
    // seed, and a seeded state we then discard is just a wasted round trip.
    //
    // The empty-window case is thrown *after* the try, not inside it: the
    // verification lint forbids re-throwing a caught error, so a NodeOperationError
    // raised inside would have to survive the catch below to keep its description.
    if (this.getMode() === "manual") {
      let sample: INodeExecutionData[];

      try {
        assertHasNarrowingFilter(filters as Record<string, unknown>);

        const since = new Date(Date.now() - SAMPLE_LOOKBACK_SECONDS * 1000).toISOString();
        const { data } = await client.searchJobs({
          ...filters,
          discovered_after: since,
          page: 1,
          page_size: SAMPLE_PAGE_SIZE,
        });
        sample = data.jobs.map((job) => ({ json: job as unknown as IDataObject }));
      } catch (error) {
        throw toPollError(this, error);
      }

      if (sample.length === 0) {
        throw new NodeOperationError(
          this.getNode(),
          "No jobs matching these filters were indexed in the last hour",
          {
            description:
              "The filters are valid — the sample window is simply empty. Broaden them to preview data here, or activate the workflow: a production poll returns everything indexed since the previous run, however long ago that was.",
          },
        );
      }

      return [sample];
    }

    // Enforce the interval the user actually chose, since n8n's Poll Times
    // dropdown is injected by the host and defaults to every minute. A skipped
    // tick makes no HTTP call and touches no state.
    const minIntervalMinutes = this.getNodeParameter(
      "minIntervalMinutes",
      DEFAULT_MIN_INTERVAL_MINUTES,
    ) as number;
    const minIntervalSeconds = Math.max(
      MIN_POLL_INTERVAL_SECONDS,
      minIntervalMinutes * 60,
    );

    if (shouldSkipPoll(staticData[LAST_POLLED_AT_KEY], minIntervalSeconds, new Date())) {
      this.logger.debug(
        `Jobo: skipping this tick — the minimum interval of ${minIntervalMinutes} minute(s) has not elapsed`,
      );
      return null;
    }

    // Stamped before the request, and outside `joboPollState`, because the two
    // have opposite failure rules. Poll state is only assigned on success (see
    // the catch below), which protects the watermark — but a stamp carried
    // inside it would be dropped by every failure too, and a trigger that is
    // erroring would go straight back to calling the API once a minute, which
    // is exactly what this interval exists to prevent.
    //
    // This lives in the in-memory static data object, which is the level that
    // matters here: n8n holds one `workflow.staticData` per active workflow and
    // hands the same object to every tick, so the stamp survives from tick to
    // tick — including across a tick that throws, and across the far more
    // common tick that simply finds no new jobs. It reaches the database only
    // when a poll emits, because n8n calls `saveStaticData` from its emit path
    // and nowhere else. A restart therefore clears the stamp and the next tick
    // polls immediately, which is the behaviour we want: a restart should not
    // lock a trigger out for an hour.
    staticData[LAST_POLLED_AT_KEY] = new Date().toISOString();

    try {
      const result = await poll(client, filters, state);
      staticData.joboPollState = result.state;

      // Seeding run: record the watermark, emit nothing. n8n treats a trigger's
      // first run as a sample, and backfilling the whole index would be both
      // surprising and expensive.
      //
      // Seeding is also exempt from the interval: it makes no request, so it
      // has nothing to rate-limit, and charging it an interval would mean a
      // freshly activated workflow sat idle for an hour before its first real
      // poll. Clearing the stamp lets the next tick fetch for real.
      if (result.seeded) {
        delete staticData[LAST_POLLED_AT_KEY];
        return null;
      }

      if (result.jobs.length === 0) {
        return null;
      }

      const spent = result.usage.reduce((sum, u) => sum + (u.creditsDeducted ?? 0), 0);
      const latestUsage = result.usage[result.usage.length - 1];
      const balance = latestUsage?.creditsBalance;
      const quotaRemaining = latestUsage?.quotaRemaining;
      const quotaLimit = latestUsage?.quotaLimit;
      this.logger.info(
        `Jobo: ${result.jobs.length} new job(s) over ${result.pagesFetched} request(s); ${spent} credits spent` +
          (balance != null ? `, wallet ${balance} credits` : "") +
          (quotaRemaining != null
            ? `, included jobs ${quotaRemaining}${quotaLimit != null ? `/${quotaLimit}` : ""} remaining`
            : ""),
      );

      return [result.jobs.map((job) => ({ json: job as unknown as IDataObject }))];
    } catch (error) {
      // Do NOT persist state on failure — an advanced watermark plus a failed
      // emit would drop those jobs permanently.
      throw toPollError(this, error);
    }
  }
}

/**
 * Map a poll failure onto the error type n8n can attribute to this node.
 *
 * Returns rather than throws so callers use `throw toPollError(...)`: the
 * verification lint (`@n8n/community-nodes/require-node-api-error`) rejects
 * re-throwing a caught error, and a bare `throw error` would also lose the node
 * context n8n needs.
 */
function toPollError(ctx: IPollFunctions, error: unknown) {
  if (error instanceof WindowOverflowError) {
    return new NodeOperationError(ctx.getNode(), error.message, {
      description:
        "Add or tighten a filter so fewer jobs match per interval, or switch to a Jobo Outbound Feed. Search results are relevance-ordered with no sort option, so a partial page cannot be resumed safely — Jobo stops rather than silently skipping jobs. Shortening the Minimum Interval does not help below its floor.",
    });
  }
  if (error instanceof InsufficientCreditsError) {
    return new NodeApiError(ctx.getNode(), { message: error.message } as never, {
      httpCode: "402",
      message: "Jobo wallet balance too low",
      description:
        "Top up your wallet at https://enterprise.jobo.world/ or narrow the filters. Note the balance check prices the requested page size, so a retry fails the same way.",
    });
  }
  if (error instanceof Error && /narrowing filter/i.test(error.message)) {
    return new NodeOperationError(ctx.getNode(), error.message);
  }
  // Everything unclassified is an API/transport failure. NodeApiError keeps the
  // original message and status while attributing the failure to this node.
  return new NodeApiError(ctx.getNode(), error as JsonObject);
}

function list(value: unknown): string[] | undefined {
  if (Array.isArray(value) && value.length > 0) return value as string[];
  return undefined;
}

/** Zero is the n8n default for an unset number field, so it must not be sent. */
function positive(value: unknown): number | undefined {
  return typeof value === "number" && value > 0 ? value : undefined;
}
