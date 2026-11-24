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
  COMPANY_SIGNAL_FILTER_KEYS,
  InsufficientCreditsError,
  JoboApiError,
  JoboError,
  JoboTransportError,
  SIGNAL_MAX_LIMIT,
  toJobSearchBody,
  type HiringSignalListResponse,
  type JobFeedParams,
} from "@jobo-ai/connector-core";

import { joboClient } from "./transport";
import { listSearch, loadOptions } from "./methods";
import {
  SIGNAL_COLLECTIONS,
  V2_AND_LATER,
  companyFilter,
  feedExcludeOptions,
  feedFilterOptions,
  feedOutputOptions,
  occupationFilter,
  searchExcludeOptions,
  searchFilterOptions,
  searchOutputOptions,
  signalFilterCollections,
} from "./descriptions";
import {
  ParameterError,
  buildFeedParams,
  buildSearchFilters,
  buildSignalFilters,
  includeFields,
  signalCompanyId,
} from "./params";
import { SIGNAL_RETURN_ALL_MAX, signalApiError, signalItem } from "./signals";

/**
 * How deep Search pages: the API serves rows up to an offset of 100,000 and
 * answers any later page with the last page it allows, again. Without this
 * bound a Return All over a broad query fetched, and paid for, that same page
 * until `total_pages` ran out.
 */
export const SEARCH_MAX_DEPTH = 100_000;
const SEARCH_MAX_PAGE_SIZE = 100;

/** Ids per Get Expired page: the most the endpoint takes. */
const EXPIRED_BATCH_SIZE = 10_000;

/**
 * The next Search page to request, or null when there is nothing left to ask
 * for: `wanted` more jobs are needed and `offset` rows have been paged past.
 *
 * Search pages by number, so a page starts at `(page - 1) * page_size`, and
 * the page size must divide the offset or the page lands on rows already
 * returned (a Limit of 150 used to ask for page 2 of 50, which is rows 50-99
 * again). So it is the largest size up to 100 that divides the offset and
 * fits what is still wanted: a Limit of 130 reads 100, then 25, then 5,
 * rather than a whole page of 100 billed for 30 kept. Never reaches past
 * `SEARCH_MAX_DEPTH`.
 */
export function nextSearchPage(offset: number, wanted: number): { page: number; pageSize: number } | null {
  const remaining = Math.min(wanted, SEARCH_MAX_DEPTH - offset);
  if (!(remaining >= 1)) return null;
  let pageSize = Math.min(SEARCH_MAX_PAGE_SIZE, Math.floor(remaining));
  while (offset % pageSize !== 0) pageSize--;
  return { page: offset / pageSize + 1, pageSize };
}

const SEARCH = { resource: ["job"], operation: ["search"] };
const FEED = { resource: ["job"], operation: ["feed"] };
const SEARCH_OR_FEED = { resource: ["job"], operation: ["search", "feed"] };
const SIGNALS = { resource: ["hiringSignal"], operation: ["getAll"] };
const COMPANY_SIGNALS = { resource: ["hiringSignal"], operation: ["getAllForCompany"] };
const ANY_SIGNALS = { resource: ["hiringSignal"], operation: ["getAll", "getAllForCompany"] };

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
    description: "Search and sync live job listings from 200+ ATS platforms, and read companies' hiring signals",
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
          { name: "Hiring Signal", value: "hiringSignal" },
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
              "Search live jobs by keyword, location, company, occupation, skills and more. Billed per job returned: included plan jobs first, then the pay-as-you-go rate; no per-job charge on Unlimited.",
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
        // The description is fixed wording under n8n's lint, so the depth
        // limit goes in the hint.
        description: "Whether to return all results or only up to a given limit",
        hint: "Billed per job returned beyond any included jobs — narrow filters to control usage. Search reaches at most the first 100,000 matches; Get Many (Feed) has no such limit.",
        displayOptions: { show: SEARCH_OR_FEED },
      },
      {
        displayName: "Limit",
        name: "limit",
        type: "number",
        typeOptions: { minValue: 1 },
        default: 50,
        description: "Max number of results to return",
        hint: "Search reaches at most the first 100,000 matches.",
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

      // ── Hiring Signal ──────────────────────────────────────────────────
      {
        displayName: "Operation",
        name: "operation",
        type: "options",
        noDataExpression: true,
        displayOptions: { show: { resource: ["hiringSignal"] } },
        options: [
          {
            name: "Get Many",
            value: "getAll",
            description:
              "Hiring signals: events at companies detected from their job postings, such as a hiring surge, a first job in a new country, a leadership search, a new technology or a slowdown. Newest detection day first. Filter by company, signal type, function, role, technology, job location, strength and date. Each signal returned is billed at ten times the price of a job: included plan signals first, then the wallet; no per-signal charge on Unlimited.",
            action: "Get many hiring signals",
          },
          {
            name: "Get Many for Company",
            value: "getAllForCompany",
            description:
              "Hiring signals at one company, by its Jobo company ID (a GUID: the ID of a signal's or a job's company). Newest detection day first. Billed like Get Many: each signal returned costs ten times a job.",
            action: "Get many hiring signals for a company",
          },
        ],
        default: "getAll",
      },
      {
        displayName: "Company ID",
        name: "companyId",
        type: "string",
        required: true,
        default: "",
        placeholder: "e.g. 0d5f8b4e-1111-4c2a-9a55-2f6d1f0e7a10",
        description: "The company's Jobo ID (a GUID), as found on each signal's or job's company",
        displayOptions: { show: COMPANY_SIGNALS },
      },
      {
        displayName: "Return All",
        name: "returnAll",
        type: "boolean",
        default: false,
        description: "Whether to return all results or only up to a given limit",
        // The description is fixed wording under n8n's lint, so the bill and
        // the ceiling go in the hint.
        hint: `Every signal returned is billed, at ten times the price of a job, and a signal read again is billed again. Return All stops at ${SIGNAL_RETURN_ALL_MAX.toLocaleString("en-US")} signals.`,
        displayOptions: { show: ANY_SIGNALS },
      },
      {
        displayName: "Limit",
        name: "limit",
        type: "number",
        typeOptions: { minValue: 1 },
        default: 50,
        description: "Max number of results to return",
        hint: "Every signal returned is billed, at ten times the price of a job.",
        displayOptions: { show: { ...ANY_SIGNALS, returnAll: [false] } },
      },
      {
        displayName: "Sort",
        name: "signalSort",
        type: "options",
        options: [
          {
            name: "Detected (Newest Day First)",
            value: "detected_desc",
            description: "The most recent detection day first",
          },
          {
            name: "Stored (Oldest First)",
            value: "created_asc",
            description:
              "The order Jobo stored the signals in. With Created After set to the Created At of the last signal you read, the next run continues exactly where that one stopped.",
          },
        ],
        default: "detected_desc",
        description: "The order the signals come back in",
        displayOptions: { show: ANY_SIGNALS },
      },
      ...signalFilterCollections(SIGNALS),
      ...signalFilterCollections(COMPANY_SIGNALS, COMPANY_SIGNAL_FILTER_KEYS),

      // ── Location ───────────────────────────────────────────────────────
      {
        displayName: "Operation",
        name: "operation",
        type: "options",
        noDataExpression: true,
        displayOptions: { show: { resource: ["location"] } },
        options: [
          {
            name: "Geocode",
            value: "geocode",
            description:
              "Resolve a location string to a city, region and country. Each successful lookup is billed.",
            action: "Geocode a location",
          },
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
      // Outside the try, so the catch can word a signals failure as one.
      let resource = "";
      try {
        resource = this.getNodeParameter("resource", i) as string;
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
          //
          // `offset` counts the rows the walk has paged past, `collected` the
          // jobs emitted; they differ only if a page comes back short.
          let offset = 0;
          let collected = 0;
          let total = 0;
          let clamped = false;
          for (;;) {
            const next = nextSearchPage(offset, limit - collected);
            if (!next) break;
            const { data } = await client.searchJobsAdvanced(
              toJobSearchBody(filters, {
                page: next.page,
                page_size: next.pageSize,
                include_facets: [],
                ...(fields ? { include_fields: fields } : {}),
              }),
            );
            if (offset === 0) logWarnings(this, data.warnings);
            total = data.total;
            // Past its depth limit the API serves the last page it allows
            // again, numbered as that page. Those jobs were already emitted
            // (and billed once more by this request), so stop here.
            if (typeof data.page === "number" && data.page < next.page) {
              clamped = true;
              break;
            }
            for (const job of data.jobs) {
              out.push({ json: job as unknown as IDataObject, pairedItem: { item: i } });
              collected++;
            }
            offset += next.pageSize;
            if (next.page >= data.total_pages || data.jobs.length === 0 || collected >= limit) break;
          }
          if ((clamped || offset >= SEARCH_MAX_DEPTH) && collected < limit && total > offset) {
            this.logger.warn(
              `Jobo: Search stopped after the first ${offset.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} matching jobs, the deepest the API pages. ` +
                "Narrow the filters, or use Job → Get Many (Feed), which has no such limit, to read every match.",
            );
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
          // whole index, so a busy day overflows the first page of ids, and a
          // truncated list leaves closed jobs live downstream. It is free, so
          // there is no bill to cap — and no Return All toggle, whose required
          // default of off would cut existing workflows to a 50-item Limit.
          const expiredSince = this.getNodeParameter("expiredSince", i, "") as string;
          let cursor: string | undefined;
          for (;;) {
            // The largest page the endpoint allows: it is free of credits but
            // each request counts toward the feed's request limit.
            const { data } = await client.getExpiredJobIds({
              ...(expiredSince ? { expired_since: expiredSince } : {}),
              ...(cursor ? { cursor } : {}),
              batch_size: EXPIRED_BATCH_SIZE,
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
        } else if (resource === "hiringSignal" && (operation === "getAll" || operation === "getAllForCompany")) {
          const forCompany = operation === "getAllForCompany";
          const returnAll = this.getNodeParameter("returnAll", i) as boolean;
          const limit = returnAll
            ? SIGNAL_RETURN_ALL_MAX
            : Math.max(1, Math.floor(Number(this.getNodeParameter("limit", i)) || 1));
          // Both checked before any request: the fix is in this item's parameters.
          const companyId = forCompany ? signalCompanyId(this.getNodeParameter("companyId", i, "")) : undefined;
          const filters = buildSignalFilters(
            SIGNAL_COLLECTIONS.map((c) => this.getNodeParameter(c.name, i, {}) as Record<string, unknown>),
            forCompany ? COMPANY_SIGNAL_FILTER_KEYS : undefined,
          );

          // A cursor continues the order it was issued under, so every page
          // of one read carries the same sort.
          const sort = this.getNodeParameter("signalSort", i, "detected_desc") as "detected_desc" | "created_asc";

          // Every signal returned is billed, so each page asks for no more
          // than is still wanted, up to the API's 200.
          let cursor: string | undefined;
          let collected = 0;
          let more = false;
          for (;;) {
            const paging = {
              limit: Math.min(SIGNAL_MAX_LIMIT, limit - collected),
              sort,
              ...(cursor ? { cursor } : {}),
            };
            const { data }: { data: HiringSignalListResponse } = companyId
              ? await client.listCompanySignals(companyId, filters, paging)
              : await client.listSignals(filters, paging);
            for (const signal of data.signals ?? []) {
              out.push({ json: signalItem(signal), pairedItem: { item: i } });
              collected++;
            }
            more = data.has_more === true && !!data.next_cursor;
            if (!more || collected >= limit) break;
            cursor = data.next_cursor as string;
          }
          if (returnAll && more) {
            this.logger.warn(
              `Jobo: Hiring Signals stopped at ${SIGNAL_RETURN_ALL_MAX.toLocaleString("en-US")} signals, the most Return All reads; more matched. ` +
                "Each signal is billed, so narrow the filters (a later Detected On or After, a Minimum Strength, fewer types), or turn off Return All and set Limit to read more on purpose.",
            );
          }
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
        throw toNodeError(this, error, i, resource);
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
export function toNodeError(
  ctx: IExecuteFunctions | { getNode: () => never },
  error: unknown,
  itemIndex?: number,
  resource?: string,
) {
  const node = (ctx as IExecuteFunctions).getNode();

  // Refused before any request: a parameter the node can tell is wrong (a
  // feed location with no country) or one connector-core will not send (an
  // empty job or company id). The fix is in this item's parameters, so it is
  // an operation error, not an API one.
  if (
    error instanceof ParameterError ||
    (error instanceof JoboError && !(error instanceof JoboApiError) && !(error instanceof JoboTransportError))
  ) {
    return new NodeOperationError(node, error.message, {
      itemIndex,
      description:
        "Nothing was sent to Jobo. Check this item's parameters: an expression may have resolved to an empty value.",
    });
  }

  // Signals have their own included allowance, need an account key, and are
  // closed to sandbox keys: each of those failures says so in its own words.
  if (resource === "hiringSignal") {
    const signalError = signalApiError(node, error, itemIndex);
    if (signalError) return signalError;
  }

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
