import {
  NodeOperationError,
  type ILoadOptionsFunctions,
  type INodeListSearchResult,
  type INodePropertyOptions,
} from "n8n-workflow";

import { joboClient } from "./transport";

/**
 * Dynamic dropdown / typeahead methods shared by the Jobo and Jobo Trigger
 * nodes. All of these hit the free connector endpoints (`/api/connectors/*`),
 * which never deduct credits — safe to call on every editor interaction.
 */

async function facetOptions(
  ctx: ILoadOptionsFunctions,
  facet: "sources" | "industries",
): Promise<INodePropertyOptions[]> {
  try {
    const client = await joboClient(ctx);
    const { data } = await client.filterOptions(facet, { limit: 250 });
    return data.options
      .map((option) => ({ name: option.key, value: option.key }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (error) {
    throw new NodeOperationError(
      ctx.getNode(),
      "Could not load options from Jobo — check the credential and network",
      { description: (error as Error).message },
    );
  }
}

export const loadOptions = {
  async getSources(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
    return facetOptions(this, "sources");
  },

  async getIndustries(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
    return facetOptions(this, "industries");
  },
};

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
