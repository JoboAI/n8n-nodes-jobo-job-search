import {
  NodeApiError,
  NodeConnectionTypes,
  NodeOperationError,
  type IDataObject,
  type IExecuteFunctions,
  type INodeExecutionData,
  type INodeType,
  type INodeTypeDescription,
} from "n8n-workflow";

import {
  EMPLOYMENT_TYPES,
  EXPERIENCE_LEVELS,
  InsufficientCreditsError,
  WORK_MODELS,
  type JobFeedParams,
  type JobSearchParams,
} from "@jobo-ai/connector-core";

import { joboClient } from "./transport";
import { listSearch, loadOptions, resourceLocatorValue } from "./methods";

/** Build n8n dropdown options from connector-core's canonical value lists. */
const optionsFrom = (values: readonly string[]) =>
  values.map((value) => ({ name: value.replace(/(^|-)([a-z])/g, (m) => m.toUpperCase()), value }));

export class Jobo implements INodeType {
  description: INodeTypeDescription = {
    displayName: "Jobo",
    name: "jobo",
    // SVG, not PNG: n8n's verification lint rejects raster node icons. The two
    // themed variants must be distinct files (the lint rejects a pair pointing
    // at the same one); jobo-dark.svg lifts the gradient's cool end and adds a
    // hairline so the squircle does not dissolve into a dark canvas.
    icon: { light: "file:jobo.svg", dark: "file:jobo-dark.svg" },
    group: ["transform"],
    version: 1,
    subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
    description: "Search and sync live job listings from 100+ ATS platforms",
    defaults: { name: "Jobo" },
    // Every operation is a plain request/response over the Jobo API, so the
    // node is safe to expose to an AI agent as a tool.
    usableAsTool: true,
    // `NodeConnectionTypes` (the const object) is a runtime export from
    // n8n-workflow 1.83.0 onwards — 1.82 only had the `NodeConnectionType`
    // enum. That is the effective host floor for this node. The verification
    // lint demands the enum over the "main" literal AND `peerDependencies`
    // pinned to "*", so the floor cannot be expressed in the manifest.
    inputs: [NodeConnectionTypes.Main],
    outputs: [NodeConnectionTypes.Main],
    credentials: [{ name: "joboApi", required: true }],
    properties: [
      {
        displayName: "Resource",
        name: "resource",
        type: "options",
        noDataExpression: true,
        options: [
          { name: "Job", value: "job" },
          { name: "Company", value: "company" },
          { name: "Location", value: "location" },
        ],
        default: "job",
      },

      // ── Job ────────────────────────────────────────────────────────────
      {
        displayName: "Operation",
        name: "operation",
        type: "options",
        noDataExpression: true,
        displayOptions: { show: { resource: ["job"] } },
        options: [
          {
            name: "Search",
            value: "search",
            description: "Search jobs with filters. Included plan jobs first, then the pay-as-you-go rate.",
            action: "Search jobs",
          },
          {
            name: "Get",
            value: "get",
            description: "Get one job by ID. Does not consume credits.",
            action: "Get a job",
          },
          {
            name: "Get Many (Feed)",
            value: "feed",
            description:
              "Bulk cursor feed, up to 1000 per request. Billed like Search — included plan jobs first, then the pay-as-you-go rate; unlimited on Jobs Feed.",
            action: "Get many jobs",
          },
          {
            name: "Get Expired",
            value: "expired",
            description: "IDs of recently closed jobs, for keeping a local copy in sync. Never consumes credits.",
            action: "Get expired jobs",
          },
        ],
        default: "search",
      },
      {
        displayName: "Job ID",
        name: "jobId",
        type: "string",
        required: true,
        default: "",
        displayOptions: { show: { resource: ["job"], operation: ["get"] } },
      },
      {
        displayName: "Query",
        name: "q",
        type: "string",
        default: "",
        placeholder: "e.g. senior rust engineer",
        description: "Free-text search across job title and description",
        hint: "Billed per job returned beyond any included jobs — narrow filters to control usage.",
        displayOptions: { show: { resource: ["job"], operation: ["search"] } },
      },
      // Location lives OUTSIDE the Filters collection deliberately: a
      // resourceLocator rendered inside a `collection` displays inconsistently
      // across n8n versions (the locator's mode dropdown collides with the
      // collection chrome), so it is promoted to a top-level optional field
      // for the search operation instead.
      {
        displayName: "Location",
        name: "location",
        type: "resourceLocator",
        default: { mode: "list", value: "" },
        description: "Only jobs in this location. Leave empty to search everywhere.",
        displayOptions: { show: { resource: ["job"], operation: ["search"] } },
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
      {
        displayName: "Return All",
        name: "returnAll",
        type: "boolean",
        default: false,
        description: "Whether to return all results or only up to a given limit",
        hint: "Billed per job returned beyond any included jobs — narrow filters to control usage.",
        displayOptions: { show: { resource: ["job"], operation: ["search", "feed"] } },
      },
      {
        displayName: "Limit",
        name: "limit",
        type: "number",
        typeOptions: { minValue: 1 },
        default: 50,
        description: "Max number of results to return",
        displayOptions: {
          show: { resource: ["job"], operation: ["search", "feed"], returnAll: [false] },
        },
      },
      // Search and feed are different wire surfaces (singular query keys vs
      // plural body keys), so each operation gets its own collection rather
      // than one collection whose fields are silently ignored by the other.
      {
        displayName: "Filters",
        name: "filters",
        type: "collection",
        placeholder: "Add Filter",
        default: {},
        displayOptions: { show: { resource: ["job"], operation: ["search"] } },
        options: [
          {
            displayName: "Discovered After",
            name: "discovered_after",
            type: "dateTime",
            default: "",
            description: "Only jobs Jobo first indexed on or after this time",
          },
          {
            displayName: "Discovered Before",
            name: "discovered_before",
            type: "dateTime",
            default: "",
            description: "Only jobs Jobo first indexed on or before this time",
          },
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
          },
          {
            displayName: "Posted Before",
            name: "posted_before",
            type: "dateTime",
            default: "",
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
      {
        displayName: "Filters",
        name: "feedFilters",
        type: "collection",
        placeholder: "Add Filter",
        default: {},
        displayOptions: { show: { resource: ["job"], operation: ["feed"] } },
        options: [
          {
            displayName: "Employment Types",
            name: "employment_types",
            type: "multiOptions",
            options: optionsFrom(EMPLOYMENT_TYPES),
            default: [],
          },
          {
            displayName: "Experience Levels",
            name: "experience_levels",
            type: "multiOptions",
            options: optionsFrom(EXPERIENCE_LEVELS),
            default: [],
          },
          {
            displayName: "Locations",
            name: "locations",
            type: "fixedCollection",
            typeOptions: { multipleValues: true },
            placeholder: "Add Location",
            default: {},
            description: "Restrict to specific locations. Leave a part empty to match any value for it.",
            options: [
              {
                displayName: "Location",
                name: "location",
                values: [
                  {
                    displayName: "Country",
                    name: "country",
                    type: "string",
                    default: "",
                    placeholder: "e.g. Germany",
                  },
                  {
                    displayName: "Region",
                    name: "region",
                    type: "string",
                    default: "",
                    placeholder: "e.g. Berlin",
                  },
                  {
                    displayName: "City",
                    name: "city",
                    type: "string",
                    default: "",
                    placeholder: "e.g. Berlin",
                  },
                ],
              },
            ],
          },
          {
            displayName: "Posted After",
            name: "posted_after",
            type: "dateTime",
            default: "",
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
            displayName: "Updated After",
            name: "updated_after",
            type: "dateTime",
            default: "",
            description: "Only jobs created or modified on or after this time",
          },
          {
            displayName: "Work Models",
            name: "work_models",
            type: "multiOptions",
            options: optionsFrom(WORK_MODELS),
            default: [],
          },
        ],
      },
      {
        displayName: "Expired Since",
        name: "expiredSince",
        type: "dateTime",
        default: "",
        description: "Defaults to 24 hours ago. Cannot be more than 7 days in the past.",
        displayOptions: { show: { resource: ["job"], operation: ["expired"] } },
      },

      // ── Company ────────────────────────────────────────────────────────
      {
        displayName: "Operation",
        name: "operation",
        type: "options",
        noDataExpression: true,
        displayOptions: { show: { resource: ["company"] } },
        options: [
          { name: "Get", value: "get", description: "Get a company profile by ID", action: "Get a company" },
        ],
        default: "get",
      },
      {
        displayName: "Company ID",
        name: "companyId",
        type: "string",
        required: true,
        default: "",
        displayOptions: { show: { resource: ["company"] } },
      },

      // ── Location ───────────────────────────────────────────────────────
      {
        displayName: "Operation",
        name: "operation",
        type: "options",
        noDataExpression: true,
        displayOptions: { show: { resource: ["location"] } },
        options: [
          { name: "Geocode", value: "geocode", description: "Resolve a location string", action: "Geocode a location" },
        ],
        default: "geocode",
      },
      {
        displayName: "Location",
        name: "locationQuery",
        type: "string",
        required: true,
        default: "",
        displayOptions: { show: { resource: ["location"] } },
      },
    ],
  };

  methods = { loadOptions, listSearch };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    const out: INodeExecutionData[] = [];
    const client = await joboClient(this);

    for (let i = 0; i < items.length; i++) {
      try {
        const resource = this.getNodeParameter("resource", i) as string;
        const operation = this.getNodeParameter("operation", i) as string;

        if (resource === "job" && operation === "search") {
          const returnAll = this.getNodeParameter("returnAll", i) as boolean;
          const limit = returnAll ? Number.POSITIVE_INFINITY : (this.getNodeParameter("limit", i) as number);
          const filters = buildSearchFilters(this.getNodeParameter("filters", i, {}) as Record<string, unknown>);
          filters.q = (this.getNodeParameter("q", i, "") as string) || undefined;
          filters.location = resourceLocatorValue(this.getNodeParameter("location", i, ""));

          let page = 1;
          let collected = 0;
          for (;;) {
            const pageSize = Math.min(100, returnAll ? 100 : limit - collected);
            const { data } = await client.searchJobs({ ...filters, page, page_size: pageSize });
            for (const job of data.jobs) {
              out.push({ json: job as unknown as IDataObject, pairedItem: { item: i } });
              collected++;
            }
            if (page >= data.total_pages || data.jobs.length === 0 || collected >= limit) break;
            page++;
          }
        } else if (resource === "job" && operation === "get") {
          const { data } = await client.getJob(this.getNodeParameter("jobId", i) as string);
          out.push({ json: data as unknown as IDataObject, pairedItem: { item: i } });
        } else if (resource === "job" && operation === "feed") {
          const returnAll = this.getNodeParameter("returnAll", i) as boolean;
          const limit = returnAll ? Number.POSITIVE_INFINITY : (this.getNodeParameter("limit", i) as number);
          const params = buildFeedFilters(this.getNodeParameter("feedFilters", i, {}) as Record<string, unknown>);

          let cursor: string | undefined;
          let collected = 0;
          for (;;) {
            const batch: JobFeedParams = {
              ...params,
              batch_size: Math.min(1000, returnAll ? 1000 : limit - collected),
            };
            if (cursor) batch.cursor = cursor;

            const { data } = await client.feed(batch);
            for (const job of data.jobs) {
              out.push({ json: job as unknown as IDataObject, pairedItem: { item: i } });
              collected++;
            }
            if (!data.has_more || !data.next_cursor || collected >= limit) break;
            cursor = data.next_cursor;
          }
        } else if (resource === "job" && operation === "expired") {
          const expiredSince = this.getNodeParameter("expiredSince", i, "") as string;
          const { data } = await client.getExpiredJobIds(
            expiredSince ? { expired_since: expiredSince } : {},
          );
          for (const id of data.job_ids) {
            out.push({ json: { id }, pairedItem: { item: i } });
          }
        } else if (resource === "company") {
          const { data } = await client.getCompany(this.getNodeParameter("companyId", i) as string);
          out.push({ json: data as IDataObject, pairedItem: { item: i } });
        } else if (resource === "location") {
          const { data } = await client.geocode(this.getNodeParameter("locationQuery", i) as string);
          out.push({ json: data as IDataObject, pairedItem: { item: i } });
        } else {
          throw new NodeOperationError(this.getNode(), `Unsupported operation "${resource}.${operation}"`, {
            itemIndex: i,
          });
        }
      } catch (error) {
        if (this.continueOnFail()) {
          out.push({ json: { error: (error as Error).message }, pairedItem: { item: i } });
          continue;
        }
        throw toNodeError(this, error, i);
      }
    }

    return [out];
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

function buildSearchFilters(raw: Record<string, unknown>): JobSearchParams {
  return {
    sources: list(raw.sources),
    work_model: list(raw.work_model),
    employment_type: list(raw.employment_type),
    experience_level: list(raw.experience_level),
    skills: list(raw.skills),
    industries: list(raw.industries),
    min_salary_usd: positive(raw.min_salary_usd),
    max_salary_usd: positive(raw.max_salary_usd),
    posted_after: (raw.posted_after as string) || undefined,
    posted_before: (raw.posted_before as string) || undefined,
    discovered_after: (raw.discovered_after as string) || undefined,
    discovered_before: (raw.discovered_before as string) || undefined,
    // true is the API default, so only the non-default is worth sending.
    search_description: raw.search_description === false ? false : undefined,
  };
}

/**
 * The Locations fixedCollection arrives as `{ location: [{country, region,
 * city}, …] }`. Blank parts are dropped (the feed treats a missing part as
 * a wildcard) and all-blank rows are discarded entirely.
 */
function feedLocations(value: unknown): JobFeedParams["locations"] {
  const rows = (value as { location?: Array<Record<string, string>> } | undefined)?.location;
  if (!Array.isArray(rows)) return undefined;

  const locations = rows
    .map((row) => ({
      country: row.country?.trim() || undefined,
      region: row.region?.trim() || undefined,
      city: row.city?.trim() || undefined,
    }))
    .filter((location) => location.country || location.region || location.city);

  return locations.length > 0 ? locations : undefined;
}

function buildFeedFilters(raw: Record<string, unknown>): JobFeedParams {
  return {
    locations: feedLocations(raw.locations),
    sources: list(raw.sources),
    work_models: list(raw.work_models),
    employment_types: list(raw.employment_types),
    experience_levels: list(raw.experience_levels),
    posted_after: (raw.posted_after as string) || undefined,
    updated_after: (raw.updated_after as string) || undefined,
    stable_scan: true,
  };
}

/**
 * Surface API failures as n8n errors with the status attached, so the workflow
 * UI shows "402" rather than a bare message. Credit exhaustion gets its own
 * wording because "request failed" sends people looking in the wrong place.
 */
export function toNodeError(ctx: IExecuteFunctions | { getNode: () => never }, error: unknown, itemIndex?: number) {
  const node = (ctx as IExecuteFunctions).getNode();

  if (error instanceof InsufficientCreditsError) {
    return new NodeApiError(node, { message: error.message } as never, {
      httpCode: "402",
      message: "Jobo wallet balance too low",
      description:
        "The request was rejected before it ran because the wallet cannot cover it. Top up your wallet at https://enterprise.jobo.world/ or narrow the filters so fewer jobs are returned.",
      itemIndex,
    });
  }

  const status = (error as { status?: number }).status;
  return new NodeApiError(node, { message: (error as Error).message } as never, {
    httpCode: status ? String(status) : undefined,
    message: (error as Error).message,
    itemIndex,
  });
}
