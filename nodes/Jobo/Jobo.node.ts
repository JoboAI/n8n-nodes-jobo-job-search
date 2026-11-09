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

import { InsufficientCreditsError, toJobSearchBody, type JobFeedParams } from "@jobo-ai/connector-core";

import { joboClient } from "./transport";
import { listSearch, loadOptions } from "./methods";
import {
  V2_AND_LATER,
  companyFilter,
  feedExcludeOptions,
  feedFilterOptions,
  feedOutputOptions,
  occupationFilter,
  searchExcludeOptions,
  searchFilterOptions,
  searchOutputOptions,
} from "./descriptions";
import { buildFeedParams, buildSearchFilters, includeFields } from "./params";

const SEARCH = { resource: ["job"], operation: ["search"] };
const FEED = { resource: ["job"], operation: ["feed"] };
const SEARCH_OR_FEED = { resource: ["job"], operation: ["search", "feed"] };

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
    // Version 2 turns Filters > Skills from a free-text list into a picker.
    // Version 1 keeps the saved shape; every other addition (companies,
    // occupations, excludes, options) is additive and shows in both.
    version: [1, 2],
    defaultVersion: 2,
    subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
    description: "Search and sync live job listings from 200+ ATS platforms",
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
            description:
              "Search live jobs by keyword, location, company, occupation, skills and more. Billed per job returned: included plan jobs first, then the pay-as-you-go rate.",
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
              "Bulk cursor feed, up to 1000 per request. Billed like Search — included plan jobs first, then the pay-as-you-go rate; no per-job charge on Unlimited.",
            action: "Get many jobs",
          },
          {
            name: "Get Expired",
            value: "expired",
            description:
              "IDs of every job closed since Expired Since, for keeping a local copy in sync. Never consumes credits.",
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
        placeholder: "e.g. 3f2b8c1e-7d4a-4b9e-9c1f-2a6e5d8b0c47",
        description: "The job's Jobo ID (a GUID), as returned by Search or Get Many",
        displayOptions: { show: { resource: ["job"], operation: ["get"] } },
      },
      {
        displayName: "Query",
        name: "q",
        type: "string",
        default: "",
        placeholder: "e.g. senior rust engineer",
        description:
          'Free-text search across job title and, unless Search Descriptions is off, the summary and skills. Wrap a phrase in double quotes for an exact title match; prefix a word with "-" to exclude it (e.g. "data engineer -senior").',
        hint: "Billed per job returned beyond any included jobs — narrow filters to control usage.",
        displayOptions: { show: SEARCH },
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
        description:
          'Only jobs in this location: a city, region or country such as "Berlin, Germany", "California" or "United States". Leave empty to search everywhere.',
        displayOptions: { show: SEARCH },
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
        displayOptions: { show: SEARCH_OR_FEED },
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
      // Search and feed are different wire surfaces (singular filter keys vs
      // plural body keys), so each operation gets its own collections rather
      // than one collection whose fields are silently ignored by the other.
      {
        displayName: "Filters",
        name: "filters",
        type: "collection",
        placeholder: "Add Filter",
        default: {},
        displayOptions: { show: { ...SEARCH, "@version": [1] } },
        options: searchFilterOptions(1, false),
      },
      {
        displayName: "Filters",
        name: "filters",
        type: "collection",
        placeholder: "Add Filter",
        default: {},
        displayOptions: { show: { ...SEARCH, "@version": V2_AND_LATER } },
        options: searchFilterOptions(2, false),
      },
      {
        displayName: "Filters",
        name: "feedFilters",
        type: "collection",
        placeholder: "Add Filter",
        default: {},
        displayOptions: { show: FEED },
        options: feedFilterOptions(),
      },
      companyFilter(SEARCH_OR_FEED),
      occupationFilter(SEARCH_OR_FEED),
      {
        displayName: "Exclude",
        name: "exclude",
        type: "collection",
        placeholder: "Add Exclusion",
        default: {},
        description: "Leave out jobs matching any of these",
        displayOptions: { show: SEARCH },
        options: searchExcludeOptions(),
      },
      {
        displayName: "Exclude",
        name: "feedExclude",
        type: "collection",
        placeholder: "Add Exclusion",
        default: {},
        description: "Leave out jobs matching any of these",
        displayOptions: { show: FEED },
        options: feedExcludeOptions(),
      },
      {
        displayName: "Options",
        name: "options",
        type: "collection",
        placeholder: "Add Option",
        default: {},
        displayOptions: { show: SEARCH },
        options: searchOutputOptions(false),
      },
      {
        displayName: "Options",
        name: "options",
        type: "collection",
        placeholder: "Add Option",
        default: {},
        displayOptions: { show: FEED },
        options: feedOutputOptions(),
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
        placeholder: "e.g. 0d5f8b4e-1111-4c2a-9a55-2f6d1f0e7a10",
        description: "The company's Jobo ID (a GUID), as found on each job's company",
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
          const options = this.getNodeParameter("options", i, {}) as Record<string, unknown>;
          const filters = buildSearchFilters({
            q: this.getNodeParameter("q", i, ""),
            location: this.getNodeParameter("location", i, ""),
            filters: this.getNodeParameter("filters", i, {}) as Record<string, unknown>,
            exclude: this.getNodeParameter("exclude", i, {}) as Record<string, unknown>,
            companyFilter: this.getNodeParameter("companyFilter", i, {}),
            occupationFilter: this.getNodeParameter("occupationFilter", i, {}),
            options,
          });
          const fields = includeFields(options);

          // POST /api/jobs/search rather than GET /api/jobs: only the body
          // form takes companies and the exclude half of each filter.
          let page = 1;
          let collected = 0;
          for (;;) {
            const pageSize = Math.min(100, returnAll ? 100 : limit - collected);
            const { data } = await client.searchJobsAdvanced(
              toJobSearchBody(filters, {
                page,
                page_size: pageSize,
                include_facets: [],
                ...(fields ? { include_fields: fields } : {}),
              }),
            );
            if (page === 1) logWarnings(this, data.warnings);
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
          const params = buildFeedParams({
            feedFilters: this.getNodeParameter("feedFilters", i, {}) as Record<string, unknown>,
            feedExclude: this.getNodeParameter("feedExclude", i, {}) as Record<string, unknown>,
            companyFilter: this.getNodeParameter("companyFilter", i, {}),
            occupationFilter: this.getNodeParameter("occupationFilter", i, {}),
            options: this.getNodeParameter("options", i, {}) as Record<string, unknown>,
          });

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
          // Always reads every page. The endpoint covers closures across the
          // whole index, so a busy day overflows the first 1,000 ids, and a
          // truncated list leaves closed jobs live downstream. It is free, so
          // there is no bill to cap — and no Return All toggle, whose required
          // default of off would cut existing workflows to a 50-item Limit.
          const expiredSince = this.getNodeParameter("expiredSince", i, "") as string;
          let cursor: string | undefined;
          for (;;) {
            const { data } = await client.getExpiredJobIds({
              ...(expiredSince ? { expired_since: expiredSince } : {}),
              ...(cursor ? { cursor } : {}),
            });
            for (const id of data.job_ids) {
              out.push({ json: { id }, pairedItem: { item: i } });
            }
            if (!data.has_more || !data.next_cursor) break;
            cursor = data.next_cursor;
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

/**
 * Warnings the API attaches to a search, e.g. `companies_unmatched` when a
 * typed company name or domain matched nothing. The search still succeeds,
 * so the run log is where a user (or an agent's operator) learns why a
 * filter returned fewer jobs than expected.
 */
function logWarnings(ctx: IExecuteFunctions, warnings: Array<{ code: string; message: string }> | null | undefined) {
  for (const warning of warnings ?? []) {
    ctx.logger.warn(`Jobo: ${warning.code}: ${warning.message}`);
  }
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
        "The request was rejected before it ran because the wallet cannot cover it. Top up your wallet at https://enterprise.jobo.world/credits?src=n8n or narrow the filters so fewer jobs are returned.",
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
