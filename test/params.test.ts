import { describe, expect, it } from "vitest";
import { toJobSearchBody } from "@jobo-ai/connector-core";

import { buildFeedParams, buildSearchFilters, includeFields } from "../nodes/Jobo/params";

const STRIPE_BOARDS = "0d5f8b4e-1111-4c2a-9a55-2f6d1f0e7a10,6a1b2c3d-2222-4c2a-9a55-2f6d1f0e7a11";

describe("search parameters", () => {
  it("maps a saved version 1 workflow onto the same filters it sent before", () => {
    // The exact parameter shape a 0.2.0 node saved: no new collections.
    const filters = buildSearchFilters({
      q: "rust engineer",
      location: { mode: "list", value: "Berlin, Germany" },
      filters: {
        work_model: ["remote"],
        skills: ["Rust", "Kubernetes"],
        industries: ["Software Development"],
        min_salary_usd: 0,
        max_salary_usd: 150000,
        search_description: false,
      },
    });

    expect(toJobSearchBody(filters)).toEqual({
      queries: ["rust engineer"],
      search_description: false,
      locations: ["Berlin, Germany"],
      work_models: ["remote"],
      skills: { include: ["Rust", "Kubernetes"] },
      industries: { include: ["Software Development"] },
      salary_usd: { max: 150000 },
    });
  });

  it("sends every board id of a picked company, and typed companies whole", () => {
    const filters = buildSearchFilters({
      companyFilter: {
        include: [
          { company: { mode: "list", value: STRIPE_BOARDS, cachedResultName: "Stripe (stripe.com)" } },
          { company: { mode: "name", value: "Acme, Inc." } },
        ],
        exclude: [{ company: { mode: "name", value: "staffing.example" } }, { company: { mode: "list", value: "" } }],
      },
    });

    expect(filters.companies).toEqual([...STRIPE_BOARDS.split(","), "Acme, Inc."]);
    expect(filters.exclude_companies).toEqual(["staffing.example"]);
  });

  it("maps the Exclude collection, occupations and options", () => {
    const filters = buildSearchFilters({
      exclude: {
        exclude_skills: ["PHP"],
        exclude_industries: ["Staffing and Recruiting"],
        exclude_company_categories: ["agency"],
        exclude_job_categories: ["Healthcare"],
        exclude_job_subcategories: ["Nursing"],
      },
      occupationFilter: {
        include: [{ occupation: { mode: "list", value: "jobo:backend-developer" } }],
        exclude: [{ occupation: { mode: "id", value: "esco:8d3e8aaa-791b-4c75-a465-f3f827028f50" } }],
      },
      options: { sort: "discovered_desc", description_format: "html" },
    });

    expect(toJobSearchBody(filters)).toEqual({
      skills: { exclude: ["PHP"] },
      industries: { exclude: ["Staffing and Recruiting"] },
      company_categories: { exclude: ["agency"] },
      job_categories: { exclude: ["Healthcare"] },
      job_subcategories: { exclude: ["Nursing"] },
      occupation_ids: {
        include: ["jobo:backend-developer"],
        exclude: ["esco:8d3e8aaa-791b-4c75-a465-f3f827028f50"],
      },
      sort: "discovered_desc",
      description_format: "html",
    });
  });

  it("splits a comma-separated string an AI agent passes for a list field", () => {
    const filters = buildSearchFilters({ filters: { skills: "python, go", language: "en,de" } });
    expect(filters.skills).toEqual(["python", "go"]);
    expect(filters.language).toEqual(["en", "de"]);
  });

  it("chooses include_fields from Fields to Include, then Simplify", () => {
    expect(includeFields({})).toBeUndefined();
    expect(includeFields({ simplify: true })).toEqual(["summary"]);
    expect(includeFields({ simplify: true, include_fields: ["description"] })).toEqual(["description"]);
  });
});

describe("feed parameters", () => {
  it("builds the feed body, include/exclude pairs and picked places", () => {
    const params = buildFeedParams({
      feedFilters: {
        locations: {
          location: [{ country: "Germany", region: "", city: "" }, { country: "", region: "", city: "" }],
          place: [{ place: { mode: "list", value: JSON.stringify({ city: "Austin", region: "Texas", country: "United States" }) } }],
        },
        sources: ["greenhouse"],
        work_models: ["remote"],
        languages: ["en"],
        industries: ["Software Development"],
        company_sizes: ["51-200"],
        company_is_agency: "false",
        include_reactivated: true,
        posted_after: "2026-11-01T00:00:00Z",
      },
      feedExclude: {
        exclude_sources: ["workday"],
        industries: ["Staffing and Recruiting"],
        company_revenues: ["under-1m"],
      },
      companyFilter: { include: [{ company: { mode: "list", value: STRIPE_BOARDS } }] },
      occupationFilter: { exclude: [{ occupation: { mode: "id", value: "jobo:recruiter" } }] },
      options: { description_format: "html" },
    });

    expect(params).toEqual({
      locations: [{ country: "Germany" }, { city: "Austin", region: "Texas", country: "United States" }],
      sources: ["greenhouse"],
      work_models: ["remote"],
      languages: ["en"],
      exclude_sources: ["workday"],
      companies: { include: STRIPE_BOARDS.split(",") },
      occupation_ids: { exclude: ["jobo:recruiter"] },
      industries: { include: ["Software Development"], exclude: ["Staffing and Recruiting"] },
      company_sizes: { include: ["51-200"] },
      company_revenues: { exclude: ["under-1m"] },
      company_is_agency: false,
      posted_after: "2026-11-01T00:00:00Z",
      include_reactivated: true,
      description_format: "html",
      stable_scan: true,
    });
  });

  it("keeps a saved version 1 feed body unchanged", () => {
    expect(
      buildFeedParams({
        feedFilters: {
          locations: { location: [{ country: "Germany", region: "Berlin", city: "Berlin" }] },
          employment_types: ["full-time"],
          updated_after: "2026-11-01T00:00:00Z",
        },
      }),
    ).toEqual({
      locations: [{ country: "Germany", region: "Berlin", city: "Berlin" }],
      employment_types: ["full-time"],
      updated_after: "2026-11-01T00:00:00Z",
      stable_scan: true,
    });
  });

  it("refuses a place that was not picked, rather than widening the feed", () => {
    expect(() =>
      buildFeedParams({ feedFilters: { locations: { place: [{ place: { mode: "list", value: "Berlin" } }] } } }),
    ).toThrow(/not a picked place/);
  });

  it("passes the enhanced description formats through and drops unknown ones", () => {
    expect(buildSearchFilters({ options: { description_format: "enhanced" } }).description_format).toBe("enhanced");
    expect(buildFeedParams({ options: { description_format: "enhanced_html" } }).description_format).toBe("enhanced_html");
    expect(buildSearchFilters({ options: { description_format: "markdown" } }).description_format).toBeUndefined();
    expect(buildFeedParams({ options: { description_format: "pdf" } }).description_format).toBeUndefined();
  });
});
