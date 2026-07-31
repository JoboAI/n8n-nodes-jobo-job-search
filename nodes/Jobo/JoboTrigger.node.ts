import {
  NodeApiError,
  NodeOperationError,
  type IDataObject,
  type INodeExecutionData,
  type INodeType,
  type INodeTypeDescription,
  type IPollFunctions,
} from "n8n-workflow";

import {
  EMPLOYMENT_TYPES,
  EXPERIENCE_LEVELS,
  InsufficientCreditsError,
  WORK_MODELS,
  WindowOverflowError,
  poll,
  type JobSearchParams,
  type PollState,
} from "@jobo-ai/connector-core";

import { joboClient } from "./transport";
import { listSearch, loadOptions, resourceLocatorValue } from "./methods";

const optionsFrom = (values: readonly string[]) =>
  values.map((value) => ({ name: value.replace(/(^|-)([a-z])/g, (m) => m.toUpperCase()), value }));

export class JoboTrigger implements INodeType {
  description: INodeTypeDescription = {
    displayName: "Jobo Trigger",
    name: "joboTrigger",
    icon: "file:jobo.png",
    group: ["trigger"],
    version: 1,
    subtitle: '={{"New job matching filters"}}',
    description: "Starts the workflow when a new job matching your filters is indexed",
    defaults: { name: "Jobo Trigger" },
    polling: true,
    inputs: [],
    outputs: ["main"],
    credentials: [{ name: "joboApi", required: true }],
    properties: [
      {
        // The filter names here are exactly connector-core's
        // NARROWING_FILTER_KEYS — keep the two in sync.
        displayName:
          "At least one narrowing filter is required: q (the query), location, sources, skills or industries. Cost is about $3 per 1,000 jobs returned and does not depend on how often this polls, so filter breadth is what drives the bill. For high volume or real-time delivery, use a Jobo Outbound Feed webhook instead: flat subscription, no per-job credits.",
        name: "costNotice",
        type: "notice",
        default: "",
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
        description: "Only jobs in this location. Leave empty to match everywhere",
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
            displayName: "Industries",
            name: "industries",
            type: "multiOptions",
            typeOptions: { loadOptionsMethod: "getIndustries" },
            default: [],
            description: "Restrict to companies in specific industries",
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
            description: "Match the query against full descriptions as well as titles. Turn off for title-only matching.",
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
            displayName: "Sources",
            name: "sources",
            type: "multiOptions",
            typeOptions: { loadOptionsMethod: "getSources" },
            default: [],
            description: "Restrict to specific ATS sources, e.g. greenhouse, lever_co, ashby",
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
    const client = await joboClient(this);

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
    const staticData = this.getWorkflowStaticData("node") as { joboPollState?: PollState };
    const state: PollState = staticData.joboPollState ?? { watermark: null, seenIds: [] };

    try {
      const result = await poll(client, filters, state);
      staticData.joboPollState = result.state;

      // Seeding run: record the watermark, emit nothing. n8n treats a trigger's
      // first run as a sample, and backfilling the whole index would be both
      // surprising and expensive.
      if (result.seeded || result.jobs.length === 0) {
        if (this.getMode() === "manual") {
          throw new NodeOperationError(
            this.getNode(),
            result.seeded
              ? "Trigger armed. No jobs are returned on the first run by design — it records a starting point, and the next poll returns jobs indexed after now."
              : "No new jobs since the last check.",
          );
        }
        return null;
      }

      const spent = result.usage.reduce((sum, u) => sum + (u.creditsDeducted ?? 0), 0);
      const balance = result.usage[result.usage.length - 1]?.creditsBalance;
      this.logger.info(
        `Jobo: ${result.jobs.length} new job(s) over ${result.pagesFetched} request(s); ${spent} credits spent` +
          (balance != null ? `, ${balance} remaining` : ""),
      );

      return [result.jobs.map((job) => ({ json: job as unknown as IDataObject }))];
    } catch (error) {
      // Do NOT persist state on failure — an advanced watermark plus a failed
      // emit would drop those jobs permanently.
      if (error instanceof WindowOverflowError) {
        throw new NodeOperationError(this.getNode(), error.message, {
          description:
            "Add or tighten a filter so fewer jobs match per interval. Search results are relevance-ordered with no sort option, so a partial page cannot be resumed safely — Jobo stops rather than silently skipping jobs.",
        });
      }
      if (error instanceof InsufficientCreditsError) {
        throw new NodeApiError(this.getNode(), { message: error.message } as never, {
          httpCode: "402",
          message: "Jobo credit balance too low",
          description:
            "Top up at https://enterprise.jobo.world/ or narrow the filters. Note the balance check prices the requested page size, so a retry fails the same way.",
        });
      }
      if (error instanceof Error && /narrowing filter/i.test(error.message)) {
        throw new NodeOperationError(this.getNode(), error.message);
      }
      throw error;
    }
  }
}

function list(value: unknown): string[] | undefined {
  if (Array.isArray(value) && value.length > 0) return value as string[];
  return undefined;
}

/** Zero is the n8n default for an unset number field, so it must not be sent. */
function positive(value: unknown): number | undefined {
  return typeof value === "number" && value > 0 ? value : undefined;
}
