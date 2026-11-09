import {
  NodeOperationError,
  type ILoadOptionsFunctions,
  type INodeListSearchItems,
  type INodeListSearchResult,
  type INodePropertyOptions,
} from "n8n-workflow";

import {
  COMPANY_CATEGORIES,
  JoboApiError,
  type FilterOptionsFacet,
  type JobFacet,
  type JoboClient,
  type OccupationTaxonomyResponse,
} from "@jobo-ai/connector-core";

import { joboClient } from "./transport";

/**
 * Dynamic dropdown / typeahead methods shared by the Jobo and Jobo Trigger
 * nodes. All of these hit endpoints that never deduct credits
 * (`/api/connectors/*`, `/api/occupations`) — safe to call on every editor
 * interaction.
 */

/** "Python (12,345)": the live job count, when the API gives one. */
export function withCount(label: string, count: number | null | undefined): string {
  return typeof count === "number" ? `${label} (${count.toLocaleString("en-US")})` : label;
}

function loadError(ctx: ILoadOptionsFunctions, error: unknown): NodeOperationError {
  return new NodeOperationError(
    ctx.getNode(),
    "Could not load options from Jobo — check the credential and network",
    { description: (error as Error).message },
  );
}

const byName = (a: INodePropertyOptions, b: INodePropertyOptions) => a.name.localeCompare(b.name);

async function facetOptions(
  ctx: ILoadOptionsFunctions,
  facet: FilterOptionsFacet,
  value: (option: JobFacet) => string = (option) => option.key,
  label: (option: JobFacet) => string = (option) => option.name ?? option.key,
): Promise<INodePropertyOptions[]> {
  const client = await joboClient(ctx);
  const { data } = await client.filterOptions(facet, { limit: 250 });
  return data.options
    .map((option) => ({ name: withCount(label(option), option.count), value: value(option) }))
    .sort(byName);
}

/**
 * The occupation taxonomy, cached per API host for ten minutes: the list
 * search below runs on every keystroke and the taxonomy is one ~300 KB
 * response that changes with a release, not a minute.
 */
const TAXONOMY_TTL_MS = 10 * 60 * 1000;
const taxonomyCache = new Map<string, { at: number; data: OccupationTaxonomyResponse }>();

async function taxonomy(ctx: ILoadOptionsFunctions, client: JoboClient): Promise<OccupationTaxonomyResponse> {
  const credentials = await ctx.getCredentials("joboApi");
  const key = String(credentials.baseUrl || "https://connect.jobo.world");
  const cached = taxonomyCache.get(key);
  if (cached && Date.now() - cached.at < TAXONOMY_TTL_MS) return cached.data;

  const { data } = await client.occupations();
  taxonomyCache.set(key, { at: Date.now(), data });
  return data;
}

/** Occupation facets 404 until occupations are published; the taxonomy then 404s too. */
function isNotFound(error: unknown): boolean {
  return error instanceof JoboApiError && error.status === 404;
}

/**
 * Category or subcategory options with live job counts from the facet; the
 * plain taxonomy when the facet is unavailable. Values are the display names
 * ("Healthcare"), which the case-insensitive filter matches.
 */
async function occupationLevelOptions(
  ctx: ILoadOptionsFunctions,
  level: "job_categories" | "job_subcategories",
): Promise<INodePropertyOptions[]> {
  const client = await joboClient(ctx);
  try {
    const { data } = await client.filterOptions(level, { limit: 250 });
    if (data.options.length > 0) {
      return data.options
        .map((option) => {
          const name = option.name ?? option.key;
          const label = level === "job_subcategories" && option.parent ? `${name} · ${titleCase(option.parent)}` : name;
          return { name: withCount(label, option.count), value: name };
        })
        .sort(byName);
    }
  } catch (error) {
    // Unpublished facet (404) or an older API without it: the taxonomy still
    // lists every value, just without counts.
    if (!(error instanceof JoboApiError)) throw loadError(ctx, error);
  }

  const tree = await taxonomy(ctx, client);
  if (level === "job_categories") {
    return tree.categories.map((category) => ({ name: category.name, value: category.name })).sort(byName);
  }
  return tree.categories
    .flatMap((category) =>
      category.subcategories.map((sub) => ({ name: `${sub.name} · ${category.name}`, value: sub.name })),
    )
    .sort(byName);
}

function titleCase(value: string): string {
  return value.replace(/\b\p{L}/gu, (letter) => letter.toUpperCase());
}

export const loadOptions = {
  async getSources(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
    try {
      return await facetOptions(this, "sources");
    } catch (error) {
      throw loadError(this, error);
    }
  },

  async getIndustries(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
    try {
      return await facetOptions(this, "industries");
    } catch (error) {
      throw loadError(this, error);
    }
  },

  /** The 250 most-asked-for skills, with live job counts. */
  async getSkills(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
    try {
      return await facetOptions(this, "skills");
    } catch (error) {
      throw loadError(this, error);
    }
  },

  /** Business-model buckets with live counts; the canonical list if the facet is unavailable. */
  async getCompanyCategories(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
    try {
      const options = await facetOptions(this, "company_categories");
      if (options.length > 0) return options;
    } catch {
      // Fall through to the static vocabulary: the filter works without counts.
    }
    return COMPANY_CATEGORIES.map((category) => ({ name: category, value: category }));
  },

  async getJobCategories(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
    try {
      return await occupationLevelOptions(this, "job_categories");
    } catch (error) {
      throw loadError(this, error);
    }
  },

  async getJobSubcategories(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
    try {
      return await occupationLevelOptions(this, "job_subcategories");
    } catch (error) {
      throw loadError(this, error);
    }
  },
};

/** Separator inside a company value: a company is every one of its board ids. */
export const COMPANY_ID_SEPARATOR = ",";

export const listSearch = {
  /**
   * Location typeahead for the resourceLocator's list mode. Suggestions carry
   * the exact Photon-normalized labels the job index stores, so a picked value
   * always matches what search matches. The API returns nothing for queries
   * under 2 characters, so short input short-circuits without a request.
   */
  async searchLocations(this: ILoadOptionsFunctions, filter?: string): Promise<INodeListSearchResult> {
    const query = (filter ?? "").trim();
    if (query.length < 2) return { results: [] };

    const client = await joboClient(this);
    const { data } = await client.suggestLocations(query, 5);

    const results = data.suggestions
      .map((suggestion) => {
        const label =
          suggestion.display_name ??
          [suggestion.city, suggestion.region, suggestion.country].filter(Boolean).join(", ");
        return { name: label, value: label };
      })
      .filter((item) => item.name !== "");

    return { results };
  },

  /**
   * Structured location typeahead for the feed, whose `locations` filter takes
   * `{ city, region, country }`. The value is that object as JSON, so the
   * picked place reaches the feed with exactly the labels the index stores.
   */
  async searchFeedLocations(this: ILoadOptionsFunctions, filter?: string): Promise<INodeListSearchResult> {
    const query = (filter ?? "").trim();
    if (query.length < 2) return { results: [] };

    const client = await joboClient(this);
    const { data } = await client.suggestLocations(query, 5);

    const results: INodeListSearchItems[] = [];
    for (const suggestion of data.suggestions) {
      const place = {
        ...(suggestion.city ? { city: suggestion.city } : {}),
        ...(suggestion.region ? { region: suggestion.region } : {}),
        ...(suggestion.country ? { country: suggestion.country } : {}),
      };
      if (Object.keys(place).length === 0) continue;
      const label =
        suggestion.display_name ??
        [suggestion.city, suggestion.region, suggestion.country].filter(Boolean).join(", ");
      results.push({ name: label, value: JSON.stringify(place) });
    }
    return { results };
  },

  /**
   * Company typeahead. Each result is one real company — every catalog board
   * that shares its name and website — and its value is all of those board
   * ids, comma-separated: sending the name instead would also match every
   * other company called that. Companies with live jobs come first.
   */
  async searchCompanies(this: ILoadOptionsFunctions, filter?: string): Promise<INodeListSearchResult> {
    const query = (filter ?? "").trim();
    if (query.length < 2) return { results: [] };

    const client = await joboClient(this);
    const { data } = await client.suggestCompanies(query, 20);

    return {
      results: data.suggestions.map((company) => {
        const details = [company.domain, company.country].filter(Boolean).join(", ");
        const label = details ? `${company.name} (${details})` : company.name;
        return {
          name:
            typeof company.job_count === "number"
              ? `${label} · ${company.job_count.toLocaleString("en-US")} live jobs`
              : label,
          value: company.ids.join(COMPANY_ID_SEPARATOR),
          ...(company.domain ? { url: `https://${company.domain}` } : {}),
        };
      }),
    };
  },

  /**
   * Occupation typeahead over the taxonomy (`GET /api/occupations`): matches
   * the occupation, subcategory or category name and returns the occupation
   * id, which is what `occupation_ids` filters on.
   */
  async searchOccupations(this: ILoadOptionsFunctions, filter?: string): Promise<INodeListSearchResult> {
    const query = (filter ?? "").trim().toLowerCase();
    const client = await joboClient(this);

    let tree: OccupationTaxonomyResponse;
    try {
      tree = await taxonomy(this, client);
    } catch (error) {
      if (isNotFound(error)) return { results: [] };
      throw loadError(this, error);
    }

    // Rank: occupation name starts with the query, then contains it, then
    // only its subcategory or category does.
    const ranked: Array<{ rank: number; item: INodeListSearchItems }> = [];
    for (const category of tree.categories) {
      for (const sub of category.subcategories) {
        const parentMatch =
          sub.name.toLowerCase().includes(query) || category.name.toLowerCase().includes(query);
        for (const occupation of sub.occupations) {
          const name = occupation.name.toLowerCase();
          const rank = name.startsWith(query) ? 0 : name.includes(query) ? 1 : parentMatch ? 2 : -1;
          if (rank < 0) continue;
          ranked.push({
            rank,
            item: { name: `${occupation.name} (${category.name} › ${sub.name})`, value: occupation.id },
          });
        }
      }
    }

    ranked.sort((a, b) => a.rank - b.rank || a.item.name.localeCompare(b.item.name));
    // Capped so the dropdown stays usable on a one-letter query.
    return { results: ranked.slice(0, 100).map((entry) => entry.item) };
  },
};

/**
 * A resourceLocator parameter arrives as `{ mode, value }`; both of our modes
 * (list pick, free-text name) carry the final display string as the value.
 */
export function resourceLocatorValue(param: unknown): string | undefined {
  if (typeof param === "string") return param.trim() || undefined;
  const value = (param as { value?: unknown } | undefined)?.value;
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}
