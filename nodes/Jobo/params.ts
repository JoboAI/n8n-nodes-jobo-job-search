import {
  toList,
  type IncludeExclude,
  type JobFeedParams,
  type JobSearchFilters,
} from "@jobo-ai/connector-core";

import { COMPANY_ID_SEPARATOR, resourceLocatorValue } from "./methods";

/**
 * Turn the nodes' raw parameter values into connector-core filter shapes.
 * Pure functions over plain objects, so both nodes (and the built-bundle
 * checks) share one mapping.
 */

type Raw = Record<string, unknown>;

/** Zero is the n8n default for an unset number field, so it must not be sent. */
function positive(value: unknown): number | undefined {
  return typeof value === "number" && value > 0 ? value : undefined;
}

/** A non-default `description_format`; Markdown is the API default and is not sent. */
function descriptionFormat(value: unknown): "html" | "enhanced" | "enhanced_html" | undefined {
  return value === "html" || value === "enhanced" || value === "enhanced_html" ? value : undefined;
}

function date(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** Rows of a include/exclude fixedCollection: `{ include: [{ <field>: rlc }], exclude: [...] }`. */
function locatorRows(collection: unknown, half: "include" | "exclude", field: string): unknown[] {
  const rows = (collection as Record<string, unknown> | undefined)?.[half];
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => (row as Raw | undefined)?.[field]);
}

/**
 * Company values from the Companies collection. A pick from the list carries
 * every board id of the company joined by commas, so a list value is split;
 * a typed value (ID, domain or whole name) is kept whole, since a company
 * name may itself contain a comma ("Acme, Inc.").
 */
export function companyValues(collection: unknown, half: "include" | "exclude"): string[] | undefined {
  const out: string[] = [];
  for (const locator of locatorRows(collection, half, "company")) {
    const value = resourceLocatorValue(locator);
    if (!value) continue;
    const mode = (locator as { mode?: unknown } | undefined)?.mode;
    if (mode === "list") out.push(...value.split(COMPANY_ID_SEPARATOR));
    else out.push(value);
  }
  return toList(out);
}

export function occupationValues(collection: unknown, half: "include" | "exclude"): string[] | undefined {
  const out: string[] = [];
  for (const locator of locatorRows(collection, half, "occupation")) {
    const value = resourceLocatorValue(locator);
    if (value) out.push(value);
  }
  return toList(out);
}

export interface SearchParameterValues {
  q?: unknown;
  location?: unknown;
  filters?: Raw;
  exclude?: Raw;
  companyFilter?: unknown;
  occupationFilter?: unknown;
  options?: Raw;
}

/** Search filters keyed by `JOB_SEARCH_FILTERS` keys. */
export function buildSearchFilters(values: SearchParameterValues): JobSearchFilters {
  const f = values.filters ?? {};
  const x = values.exclude ?? {};
  const o = values.options ?? {};

  return {
    q: typeof values.q === "string" && values.q.trim() !== "" ? values.q.trim() : undefined,
    location: resourceLocatorValue(values.location),
    sources: toList(f.sources),
    companies: companyValues(values.companyFilter, "include"),
    exclude_companies: companyValues(values.companyFilter, "exclude"),
    work_model: toList(f.work_model),
    employment_type: toList(f.employment_type),
    experience_level: toList(f.experience_level),
    language: toList(f.language),
    skills: toList(f.skills),
    exclude_skills: toList(x.exclude_skills),
    industries: toList(f.industries),
    exclude_industries: toList(x.exclude_industries),
    company_categories: toList(f.company_categories),
    exclude_company_categories: toList(x.exclude_company_categories),
    job_categories: toList(f.job_categories),
    exclude_job_categories: toList(x.exclude_job_categories),
    job_subcategories: toList(f.job_subcategories),
    exclude_job_subcategories: toList(x.exclude_job_subcategories),
    occupation_ids: occupationValues(values.occupationFilter, "include"),
    exclude_occupation_ids: occupationValues(values.occupationFilter, "exclude"),
    min_salary_usd: positive(f.min_salary_usd),
    max_salary_usd: positive(f.max_salary_usd),
    posted_after: date(f.posted_after),
    posted_before: date(f.posted_before),
    discovered_after: date(f.discovered_after),
    discovered_before: date(f.discovered_before),
    // true is the API default, so only the non-default is worth sending.
    search_description: f.search_description === false ? false : undefined,
    sort:
      o.sort === "discovered_asc" || o.sort === "discovered_desc" || o.sort === "relevance" ? o.sort : undefined,
    description_format: descriptionFormat(o.description_format),
  };
}

/**
 * `include_fields` for the Options collection: an explicit selection wins;
 * Simplify alone means the core fields plus the summary; neither means the
 * full job (undefined, so the API default applies).
 */
export function includeFields(options: Raw | undefined): string[] | undefined {
  const selected = toList(options?.include_fields);
  if (selected) return selected;
  if (options?.simplify === true) return ["summary"];
  return undefined;
}

function pair(include: string[] | undefined, exclude: string[] | undefined): IncludeExclude | undefined {
  if (!include && !exclude) return undefined;
  return { ...(include ? { include } : {}), ...(exclude ? { exclude } : {}) };
}

/**
 * The Locations collection: `{ location: [{country, region, city}], place:
 * [{place: rlc}] }`. Blank parts are dropped (the feed treats a missing part
 * as a wildcard); all-blank rows are discarded.
 */
export function feedLocations(value: unknown): JobFeedParams["locations"] {
  const collection = value as { location?: Array<Record<string, unknown>>; place?: Array<Record<string, unknown>> } | undefined;
  const rows: Array<Record<string, unknown>> = [...(collection?.location ?? [])];

  for (const row of collection?.place ?? []) {
    const raw = resourceLocatorValue(row?.place);
    if (!raw) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    if (!parsed || typeof parsed !== "object") {
      // Dropping it would silently widen the feed to every location.
      throw new Error(
        `Location place "${raw}" is not a picked place. Pick it from the list, or use a Location row with country, region and city.`,
      );
    }
    rows.push(parsed as Record<string, unknown>);
  }

  const part = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);
  const locations = rows
    .map((row) => ({ country: part(row.country), region: part(row.region), city: part(row.city) }))
    .filter((location) => location.country || location.region || location.city)
    .map((location) => ({
      ...(location.country ? { country: location.country } : {}),
      ...(location.region ? { region: location.region } : {}),
      ...(location.city ? { city: location.city } : {}),
    }));

  return locations.length > 0 ? locations : undefined;
}

export interface FeedParameterValues {
  feedFilters?: Raw;
  feedExclude?: Raw;
  companyFilter?: unknown;
  occupationFilter?: unknown;
  options?: Raw;
}

/** `POST /api/jobs/feed` body, without pagination. */
export function buildFeedParams(values: FeedParameterValues): JobFeedParams {
  const f = values.feedFilters ?? {};
  const x = values.feedExclude ?? {};
  const o = values.options ?? {};

  const params: JobFeedParams = {
    locations: feedLocations(f.locations),
    sources: toList(f.sources),
    work_models: toList(f.work_models),
    employment_types: toList(f.employment_types),
    experience_levels: toList(f.experience_levels),
    languages: toList(f.languages),
    exclude_sources: toList(x.exclude_sources),
    exclude_work_models: toList(x.exclude_work_models),
    exclude_employment_types: toList(x.exclude_employment_types),
    exclude_experience_levels: toList(x.exclude_experience_levels),
    exclude_languages: toList(x.exclude_languages),
    companies: pair(companyValues(values.companyFilter, "include"), companyValues(values.companyFilter, "exclude")),
    occupation_ids: pair(
      occupationValues(values.occupationFilter, "include"),
      occupationValues(values.occupationFilter, "exclude"),
    ),
    job_categories: pair(toList(f.job_categories), toList(x.job_categories)),
    job_subcategories: pair(toList(f.job_subcategories), toList(x.job_subcategories)),
    industries: pair(toList(f.industries), toList(x.industries)),
    company_primary_industries: pair(toList(f.company_primary_industries), toList(x.company_primary_industries)),
    company_categories: pair(toList(f.company_categories), toList(x.company_categories)),
    company_sizes: pair(toList(f.company_sizes), toList(x.company_sizes)),
    company_revenues: pair(toList(f.company_revenues), toList(x.company_revenues)),
    company_is_agency: f.company_is_agency === "true" ? true : f.company_is_agency === "false" ? false : undefined,
    posted_after: date(f.posted_after),
    include_reactivated: f.include_reactivated === true ? true : undefined,
    description_format: descriptionFormat(o.description_format),
    updated_after: date(f.updated_after),
    stable_scan: true,
  };

  // Absent rather than undefined-valued, so the JSON body carries only what was set.
  for (const key of Object.keys(params) as Array<keyof JobFeedParams>) {
    if (params[key] === undefined) delete params[key];
  }
  return params;
}
