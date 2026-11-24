import type { INodeProperties, INodePropertyOptions } from "n8n-workflow";

import {
  COMPANY_REVENUES,
  COMPANY_SIZES,
  EMPLOYMENT_TYPES,
  EXPERIENCE_LEVELS,
  HIRING_SIGNAL_FILTERS,
  INCLUDE_FIELDS,
  LANGUAGES,
  SIGNAL_MAX_LIST_VALUES,
  WORK_MODELS,
  signalTypeLabel,
  type HiringSignalFilters,
  type SignalFilterDescriptor,
} from "@jobo-ai/connector-core";

/**
 * Parameter definitions shared by the Jobo and Jobo Trigger nodes. Option
 * `name`s inside the filter collections are connector-core filter keys
 * (`JOB_SEARCH_FILTERS`, `JOB_FEED_FILTER_KEYS`); scripts/verify-filters.mjs
 * checks the built nodes against contracts/filters.json.
 *
 * Descriptions are written for two readers: a person in the editor, and an
 * AI agent using the node as a tool, which sees only these strings. So each
 * one states the accepted values and their format.
 */

/** Build n8n dropdown options from connector-core's canonical value lists. */
export const optionsFrom = (values: readonly string[]): INodePropertyOptions[] =>
  values.map((value) => ({ name: value.replace(/(^|-)([a-z])/g, (m) => m.toUpperCase()), value }));

const languageOptions: INodePropertyOptions[] = [...LANGUAGES]
  .sort((a, b) => a.name.localeCompare(b.name))
  .map((language) => ({ name: `${language.name} (${language.code})`, value: language.code }));

type Show = NonNullable<NonNullable<INodeProperties["displayOptions"]>["show"]>;

/** Version 2 and later. */
export const V2_AND_LATER = [{ _cnd: { gte: 2 } }];

// ── Field builders ───────────────────────────────────────────────────────────

const companyCategories = (name: string): INodeProperties => ({
  displayName: "Company Category Names or IDs",
  name,
  type: "multiOptions",
  typeOptions: { loadOptionsMethod: "getCompanyCategories" },
  default: [],
  description:
    'Company business models: b2b, b2c, b2b2c, b2g, saas, marketplace, e-commerce, service-provider, hardware, agency, nonprofit, government, education. Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
});

const industries = (name: string): INodeProperties => ({
  displayName: "Industry Names or IDs",
  name,
  type: "multiOptions",
  typeOptions: { loadOptionsMethod: "getIndustries" },
  default: [],
  description:
    'Company industries, by exact name (e.g. "Software Development"); a job matches when its company has any of them. Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
});

const jobCategories = (name: string): INodeProperties => ({
  displayName: "Job Category Names or IDs",
  name,
  type: "multiOptions",
  typeOptions: { loadOptionsMethod: "getJobCategories" },
  default: [],
  description:
    'Occupation categories, by name (e.g. "Healthcare", "Technology"; case-insensitive). Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
});

const jobSubcategories = (name: string): INodeProperties => ({
  displayName: "Job Subcategory Names or IDs",
  name,
  type: "multiOptions",
  typeOptions: { loadOptionsMethod: "getJobSubcategories" },
  default: [],
  description:
    'Occupation subcategories, by name (e.g. "Nursing"; case-insensitive). Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
});

const skillPicker = (name: string): INodeProperties => ({
  displayName: "Skill Names or IDs",
  name,
  type: "multiOptions",
  typeOptions: { loadOptionsMethod: "getSkills" },
  default: [],
  description:
    'Skills by name (e.g. "Python", "Kubernetes"); a job matches when it asks for any of them. The list shows the most-requested skills with live job counts. Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
});

const sources = (name: string): INodeProperties => ({
  displayName: "Source Names or IDs",
  name,
  type: "multiOptions",
  typeOptions: { loadOptionsMethod: "getSources" },
  default: [],
  description:
    'ATS sources, by source ID (e.g. greenhouse, lever_co, ashby, workday). Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
});

const language = (name: string, verb: string): INodeProperties => ({
  displayName: "Languages",
  name,
  type: "multiOptions",
  options: languageOptions,
  default: [],
  description: `${verb} jobs whose description is in these languages, as ISO 639-1 codes (e.g. en, de). Other codes work through an expression.`,
});

const companySizes = (name: string, verb: string): INodeProperties => ({
  displayName: "Company Size",
  name,
  type: "multiOptions",
  options: COMPANY_SIZES.map((size) => ({ name: `${size} employees`, value: size })),
  default: [],
  description: `${verb} companies with these headcount bands: ${COMPANY_SIZES.join(", ")}. Companies of unknown size never match an include list.`,
});

const companyRevenues = (name: string, verb: string): INodeProperties => ({
  displayName: "Company Revenue",
  name,
  type: "multiOptions",
  options: COMPANY_REVENUES.map((band) => ({ name: band, value: band })),
  default: [],
  description: `${verb} companies with these annual revenue bands (USD): ${COMPANY_REVENUES.join(", ")}`,
});

const primaryIndustries = (name: string, verb: string): INodeProperties => ({
  displayName: "Company Primary Industries",
  name,
  type: "string",
  typeOptions: { multipleValues: true, multipleValueButtonText: "Add industry" },
  default: [],
  description: `${verb} companies whose primary industry is one of these, by exact name (case-insensitive), e.g. "Software Development"`,
});

// ── Search (Jobo › Job › Search, and the trigger) ────────────────────────────

/**
 * The search Filters collection. Version 1 keeps Skills a free-text list —
 * its saved shape — while version 2 makes it a picker. Everything else is
 * the same in both, and additions here are additive for saved workflows.
 */
export function searchFilterOptions(version: 1 | 2, trigger: boolean): INodeProperties[] {
  const options: INodeProperties[] = [
    companyCategories("company_categories"),
    ...(trigger
      ? []
      : [
          {
            displayName: "Discovered After",
            name: "discovered_after",
            type: "dateTime",
            default: "",
            description: "Only jobs Jobo first indexed on or after this time (ISO 8601)",
          } satisfies INodeProperties,
          {
            displayName: "Discovered Before",
            name: "discovered_before",
            type: "dateTime",
            default: "",
            description: "Only jobs Jobo first indexed on or before this time (ISO 8601)",
          } satisfies INodeProperties,
        ]),
    {
      displayName: "Employment Type",
      name: "employment_type",
      type: "multiOptions",
      options: optionsFrom(EMPLOYMENT_TYPES),
      default: [],
      description: `One or more of: ${EMPLOYMENT_TYPES.join(", ")}`,
    },
    {
      displayName: "Experience Level",
      name: "experience_level",
      type: "multiOptions",
      options: optionsFrom(EXPERIENCE_LEVELS),
      default: [],
      description: `One or more of: ${EXPERIENCE_LEVELS.join(", ")}`,
    },
    industries("industries"),
    jobCategories("job_categories"),
    jobSubcategories("job_subcategories"),
    language("language", "Only"),
    {
      displayName: "Max Salary (USD)",
      name: "max_salary_usd",
      type: "number",
      default: 0,
      description:
        "Only jobs whose published salary range is at or below this yearly USD amount. Only matches jobs whose employer published a salary range. 0 means no limit.",
    },
    {
      displayName: "Min Salary (USD)",
      name: "min_salary_usd",
      type: "number",
      default: 0,
      description:
        "Only jobs whose published salary range reaches this yearly USD amount. Only matches jobs whose employer published a salary range. 0 means no limit.",
    },
    {
      displayName: "Posted After",
      name: "posted_after",
      type: "dateTime",
      default: "",
      description: "Only jobs the employer posted on or after this time (ISO 8601)",
    },
    ...(trigger
      ? []
      : [
          {
            displayName: "Posted Before",
            name: "posted_before",
            type: "dateTime",
            default: "",
            description: "Only jobs the employer posted on or before this time (ISO 8601)",
          } satisfies INodeProperties,
        ]),
    {
      displayName: "Search Descriptions",
      name: "search_description",
      type: "boolean",
      default: true,
      description:
        "Whether to match the query against full job descriptions as well as titles. Turn this off for title-only matching.",
    },
    version === 1
      ? {
          displayName: "Skills",
          name: "skills",
          type: "string",
          typeOptions: { multipleValues: true, multipleValueButtonText: "Add skill" },
          default: [],
          description: "Require one or more skills, e.g. Python, Kubernetes",
        }
      : skillPicker("skills"),
    sources("sources"),
    {
      displayName: "Work Model",
      name: "work_model",
      type: "multiOptions",
      options: optionsFrom(WORK_MODELS),
      default: [],
      description: `One or more of: ${WORK_MODELS.join(", ")}`,
    },
  ];
  return options;
}

/** The search Exclude collection: the exclude half of every include/exclude filter. */
export function searchExcludeOptions(): INodeProperties[] {
  return [
    companyCategories("exclude_company_categories"),
    industries("exclude_industries"),
    jobCategories("exclude_job_categories"),
    jobSubcategories("exclude_job_subcategories"),
    skillPicker("exclude_skills"),
  ];
}

/**
 * Companies, as include / exclude rows. Each row is a resource locator: pick
 * from the typeahead (which sends every board id of that company) or type a
 * name, website domain or ID. Top-level rather than inside a collection: a
 * resource locator directly in a `collection` renders inconsistently across
 * n8n versions, while inside a `fixedCollection` it is the core pattern
 * (Jira's custom fields).
 */
export function companyFilter(show: Show): INodeProperties {
  const company: INodeProperties = {
    displayName: "Company",
    name: "company",
    type: "resourceLocator",
    default: { mode: "list", value: "" },
    description:
      'A company. From the list sends its Jobo company IDs; By Name or Domain takes a Jobo company ID (GUID), a website domain such as "stripe.com", or an exact company name such as "Stripe" (a name also matches other companies of that name).',
    modes: [
      {
        displayName: "From List",
        name: "list",
        type: "list",
        placeholder: "Search for a company…",
        typeOptions: { searchListMethod: "searchCompanies", searchable: true },
      },
      {
        displayName: "By Name or Domain",
        name: "name",
        type: "string",
        placeholder: "e.g. stripe.com",
      },
    ],
  };
  return {
    displayName: "Companies",
    name: "companyFilter",
    type: "fixedCollection",
    typeOptions: { multipleValues: true },
    placeholder: "Add Company",
    default: {},
    description: "Only jobs at these companies, or leave out jobs at these companies",
    displayOptions: { show },
    options: [
      { name: "include", displayName: "Only Jobs At", values: [company] },
      { name: "exclude", displayName: "Exclude Jobs At", values: [company] },
    ],
  };
}

/** Occupations, as include / exclude rows of occupation IDs. */
export function occupationFilter(show: Show): INodeProperties {
  const occupation: INodeProperties = {
    displayName: "Occupation",
    name: "occupation",
    type: "resourceLocator",
    default: { mode: "list", value: "" },
    description:
      'An occupation ID: "esco:" plus a UUID (e.g. "esco:8d3e8aaa-791b-4c75-a465-f3f827028f50") or "jobo:" plus a slug (e.g. "jobo:backend-developer"). Search the list by occupation, subcategory or category name.',
    modes: [
      {
        displayName: "From List",
        name: "list",
        type: "list",
        placeholder: "Search occupations…",
        typeOptions: { searchListMethod: "searchOccupations", searchable: true },
      },
      {
        displayName: "By ID",
        name: "id",
        type: "string",
        placeholder: "e.g. jobo:backend-developer",
      },
    ],
  };
  return {
    displayName: "Occupations",
    name: "occupationFilter",
    type: "fixedCollection",
    typeOptions: { multipleValues: true },
    placeholder: "Add Occupation",
    default: {},
    description: "Only jobs classified as these occupations, or leave them out",
    displayOptions: { show },
    options: [
      { name: "include", displayName: "Only Occupation", values: [occupation] },
      { name: "exclude", displayName: "Exclude Occupation", values: [occupation] },
    ],
  };
}

const descriptionFormat: INodeProperties = {
  displayName: "Description Format",
  name: "description_format",
  type: "options",
  options: [
    { name: "Markdown", value: "markdown" },
    { name: "HTML", value: "html" },
    { name: "Enhanced Markdown (Beta)", value: "enhanced" },
    { name: "Enhanced HTML (Beta)", value: "enhanced_html" },
  ],
  default: "markdown",
  description:
    "Format of each job's description: Markdown (as stored) or HTML. The enhanced formats (beta) return the same words with consistent headings, lists and key facts; a job without an enhanced description returns its standard one.",
};

/** Output options for search (`sort` is search only) and the trigger. */
export function searchOutputOptions(trigger: boolean): INodeProperties[] {
  return [
    descriptionFormat,
    {
      displayName: "Fields to Include",
      name: "include_fields",
      type: "multiOptions",
      options: optionsFrom(INCLUDE_FIELDS),
      default: [],
      description:
        "Heavy job fields to return alongside the core fields (ID, title, company, locations, compensation, dates, URLs). Empty returns every field, unless Simplify is on.",
    },
    {
      displayName: "Simplify",
      name: "simplify",
      type: "boolean",
      default: false,
      description:
        "Whether to return the core job fields plus the short summary only, leaving out the full description, qualifications, responsibilities and benefits. Recommended for AI agents.",
    },
    ...(trigger
      ? []
      : [
          {
            displayName: "Sort",
            name: "sort",
            type: "options",
            options: [
              { name: "Relevance", value: "relevance", description: "Best match first; newest updated first without a query" },
              { name: "Discovered (Oldest First)", value: "discovered_asc", description: "Stable while paging" },
              { name: "Discovered (Newest First)", value: "discovered_desc" },
            ],
            default: "relevance",
            description: "Result order: relevance, discovered_asc or discovered_desc (by when Jobo first indexed the job)",
          } satisfies INodeProperties,
        ]),
  ];
}

// ── Feed (Jobo › Job › Get Many) ─────────────────────────────────────────────

/** Feed Filters: option names are `JOB_FEED_FILTER_KEYS`. */
export function feedFilterOptions(): INodeProperties[] {
  return [
    {
      displayName: "Agency Jobs",
      name: "company_is_agency",
      type: "options",
      options: [
        { name: "Include", value: "" },
        { name: "Exclude", value: "false", description: "Leave out jobs recruitment and staffing agencies post" },
        { name: "Only", value: "true", description: "Only jobs recruitment and staffing agencies post" },
      ],
      default: "",
      description: "Whether to keep, leave out, or only return jobs posted by staffing agencies",
    },
    companyCategories("company_categories"),
    primaryIndustries("company_primary_industries", "Only"),
    companyRevenues("company_revenues", "Only"),
    companySizes("company_sizes", "Only"),
    {
      displayName: "Employment Types",
      name: "employment_types",
      type: "multiOptions",
      options: optionsFrom(EMPLOYMENT_TYPES),
      default: [],
      description: `One or more of: ${EMPLOYMENT_TYPES.join(", ")}`,
    },
    {
      displayName: "Experience Levels",
      name: "experience_levels",
      type: "multiOptions",
      options: optionsFrom(EXPERIENCE_LEVELS),
      default: [],
      description: `One or more of: ${EXPERIENCE_LEVELS.join(", ")}`,
    },
    {
      displayName: "Include Reactivated",
      name: "include_reactivated",
      type: "boolean",
      default: false,
      description:
        "Whether Posted After also returns jobs that expired and were re-listed since then. Has no effect without Posted After.",
    },
    industries("industries"),
    jobCategories("job_categories"),
    jobSubcategories("job_subcategories"),
    language("languages", "Only"),
    {
      displayName: "Locations",
      name: "locations",
      type: "fixedCollection",
      typeOptions: { multipleValues: true },
      placeholder: "Add Location",
      default: {},
      description:
        "Only jobs in any of these locations. Search for a place, or enter its parts. Country is required whenever Region or City is set; leave Region and City empty to match the whole country.",
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
              description:
                'Country name or ISO code, e.g. "Germany", "DE", "United States". Required when Region or City is set.',
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
        {
          displayName: "Place",
          name: "place",
          values: [
            {
              displayName: "Place",
              name: "place",
              type: "resourceLocator",
              default: { mode: "list", value: "" },
              description: "A city, region or country, as the job index names it",
              modes: [
                {
                  displayName: "From List",
                  name: "list",
                  type: "list",
                  placeholder: "Search for a city, region or country…",
                  typeOptions: { searchListMethod: "searchFeedLocations", searchable: true },
                },
              ],
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
      description: "Only jobs the employer posted on or after this time (ISO 8601)",
    },
    sources("sources"),
    {
      displayName: "Updated After",
      name: "updated_after",
      type: "dateTime",
      default: "",
      description: "Only jobs created or modified on or after this time (ISO 8601). The recommended sync watermark.",
    },
    {
      displayName: "Work Models",
      name: "work_models",
      type: "multiOptions",
      options: optionsFrom(WORK_MODELS),
      default: [],
      description: `One or more of: ${WORK_MODELS.join(", ")}`,
    },
  ];
}

/**
 * Feed Exclude. The five plain lists use their `exclude_*` body keys; the
 * include/exclude filters reuse the include key, since on the wire they are
 * one `{ include, exclude }` object.
 */
export function feedExcludeOptions(): INodeProperties[] {
  return [
    companyCategories("company_categories"),
    primaryIndustries("company_primary_industries", "Leave out"),
    companyRevenues("company_revenues", "Leave out"),
    companySizes("company_sizes", "Leave out"),
    {
      displayName: "Employment Types",
      name: "exclude_employment_types",
      type: "multiOptions",
      options: optionsFrom(EMPLOYMENT_TYPES),
      default: [],
      description: `Leave out these employment types: ${EMPLOYMENT_TYPES.join(", ")}. Jobs whose type is unknown are kept.`,
    },
    {
      displayName: "Experience Levels",
      name: "exclude_experience_levels",
      type: "multiOptions",
      options: optionsFrom(EXPERIENCE_LEVELS),
      default: [],
      description: `Leave out these levels: ${EXPERIENCE_LEVELS.join(", ")}. Jobs whose level is unknown are kept.`,
    },
    industries("industries"),
    jobCategories("job_categories"),
    jobSubcategories("job_subcategories"),
    language("exclude_languages", "Leave out"),
    sources("exclude_sources"),
    {
      displayName: "Work Models",
      name: "exclude_work_models",
      type: "multiOptions",
      options: optionsFrom(WORK_MODELS),
      default: [],
      description: `Leave out these work models: ${WORK_MODELS.join(", ")}. Jobs whose work model is unknown are kept.`,
    },
  ];
}

export function feedOutputOptions(): INodeProperties[] {
  return [descriptionFormat];
}

// ── Polling (both triggers) ──────────────────────────────────────────────────

/**
 * The floor a trigger actually honours, as offered in the UI.
 *
 * n8n injects its own Poll Times property into every polling node with a
 * hard-coded "Every Minute" default, and a node cannot narrow that list or
 * change that default — so a trigger nobody configured fires 1,440 times a day.
 * Jobs and signals are metered per item returned and a quiet poll returns
 * none, so this costs nothing extra, but the requests are real. This field is
 * where the interval is genuinely settled; a tick arriving early is skipped
 * without making a request.
 *
 * The lowest option matches `MIN_POLL_INTERVAL_SECONDS`; connector-core clamps
 * anything below it regardless.
 */
export const MIN_INTERVAL_OPTIONS = [
  { name: "Every 15 Minutes", value: 15 },
  { name: "Every 30 Minutes", value: 30 },
  { name: "Every Hour", value: 60 },
  { name: "Every 6 Hours", value: 360 },
  { name: "Every 24 Hours", value: 1440 },
] as const;

export const DEFAULT_MIN_INTERVAL_MINUTES = 60;

// ── Hiring Signals (Jobo › Hiring Signal, and the signal trigger) ────────────

/**
 * Which collection each signal filter sits in: which companies, what the
 * signal is about, and the thresholds and dates.
 *
 * A record over every key of connector-core's `HiringSignalFilters`, so a
 * filter the core adds fails the typecheck here until it is given a place;
 * `scripts/verify-filters.mjs` then checks the built nodes against
 * contracts/signals.json.
 */
export const SIGNAL_FILTER_GROUPS: Record<keyof HiringSignalFilters, SignalFilterGroup> = {
  domains: "company",
  company_ids: "company",
  exclude_domains: "company",
  countries: "company",
  company_sizes: "company",
  industries: "company",
  categories: "company",
  funding_stages: "company",
  founded_after: "company",
  exclude_agencies: "company",
  types: "focus",
  functions: "focus",
  roles: "focus",
  seniority: "focus",
  technologies: "focus",
  skills: "focus",
  technology_categories: "focus",
  job_countries: "focus",
  job_regions: "focus",
  job_cities: "focus",
  min_strength: "threshold",
  min_new_jobs: "threshold",
  min_days_open: "threshold",
  reposted_only: "threshold",
  detected_after: "threshold",
  detected_before: "threshold",
  created_after: "threshold",
};

export type SignalFilterGroup = "company" | "focus" | "threshold";

/** The three signal filter collections. Their `name`s are what the nodes read. */
export const SIGNAL_COLLECTIONS: ReadonlyArray<{
  // Not `group`: n8n's lint reads an object with `group` and `displayName`
  // as a node description and demands a file of its own for it.
  filterGroup: SignalFilterGroup;
  name: string;
  displayName: string;
  placeholder: string;
  description: string;
}> = [
  {
    filterGroup: "company",
    name: "signalCompanyFilters",
    displayName: "Company Filters",
    placeholder: "Add Company Filter",
    description: "Which companies the signals are about: by domain, ID, headquarters country, size, industry or funding",
  },
  {
    filterGroup: "focus",
    name: "signalFocusFilters",
    displayName: "Signal Filters",
    placeholder: "Add Signal Filter",
    description:
      "What the signals are about: the kind of signal, and the function, role, seniority, technology or job location behind it",
  },
  {
    filterGroup: "threshold",
    name: "signalThresholds",
    displayName: "Thresholds and Dates",
    placeholder: "Add Threshold or Date",
    description: "How strong or large a signal must be, and when it was detected",
  },
];

/** Readable names for the enum values whose words do not title-case well. */
const SIGNAL_VALUE_NAMES: Readonly<Record<string, string>> = { vp: "VP", c_level: "C-Level" };

function signalOptionName(filter: SignalFilterDescriptor, value: string): string {
  if (filter.key === "types") return signalTypeLabel(value);
  if (filter.key === "company_sizes") return `${value} employees`;
  const known = SIGNAL_VALUE_NAMES[value];
  if (known) return known;
  return value.replace(/_/g, " ").replace(/(^|\s)([a-z])/g, (m) => m.toUpperCase());
}

/**
 * One signal filter as an n8n field. The option `name` is the query
 * parameter, and the description says what the API accepts, for the person
 * in the editor and for an AI agent that sees only this text.
 */
function signalField(filter: SignalFilterDescriptor): INodeProperties {
  const base = { displayName: filter.label, name: filter.key };
  switch (filter.kind) {
    case "enumList": {
      const values = filter.options ?? [];
      const options = values.map((value) => ({ name: signalOptionName(filter, value), value }));
      // Types read best alphabetically; sizes and seniority keep their order, lowest first.
      if (filter.key === "types") options.sort((a, b) => a.name.localeCompare(b.name));
      return {
        ...base,
        type: "multiOptions",
        options,
        default: [],
        description: `${filter.description} One or more of: ${values.join(", ")}.`,
      };
    }
    case "stringList":
      return {
        ...base,
        type: "string",
        typeOptions: {
          multipleValues: true,
          multipleValueButtonText: `Add ${filter.label.replace(/ies$/, "y").replace(/s$/, "")}`,
        },
        default: [],
        description: /comma/.test(filter.description)
          ? `${filter.description} At most ${SIGNAL_MAX_LIST_VALUES} values.`
          : `${filter.description} A value cannot contain a comma.`,
      };
    case "number":
      return {
        ...base,
        type: "number",
        typeOptions: { minValue: 0, ...(filter.max !== undefined ? { maxValue: filter.max } : {}) },
        default: 0,
        description: `${filter.description} From ${filter.min ?? 1} to ${filter.max ?? "any"}; 0 means no filter.`,
      };
    case "boolean":
      return {
        ...base,
        type: "boolean",
        default: false,
        // n8n's lint wants a boolean's description to start with "Whether".
        description: filter.description.startsWith("Only ")
          ? `Whether to return only ${filter.description.slice("Only ".length)}`
          : `Whether to ${filter.description.charAt(0).toLowerCase()}${filter.description.slice(1)}`,
      };
    case "date":
      return {
        ...base,
        type: "dateTime",
        default: "",
        description: `${filter.description} Only the day of the chosen date is sent.`,
      };
    case "dateTime":
      return { ...base, type: "dateTime", default: "", description: filter.description };
  }
}

/**
 * The signal filter collections for one operation or trigger, built from
 * connector-core's `HIRING_SIGNAL_FILTERS` so a filter cannot exist in the
 * core and go missing here. `keys` keeps only some filters: the per-company
 * endpoint takes a few, and the trigger leaves `created_after` to the poller.
 * A collection left with nothing is not shown.
 */
export function signalFilterCollections(show: Show, keys?: readonly string[]): INodeProperties[] {
  const out: INodeProperties[] = [];
  for (const collection of SIGNAL_COLLECTIONS) {
    const options = HIRING_SIGNAL_FILTERS.filter(
      (filter) => SIGNAL_FILTER_GROUPS[filter.key] === collection.filterGroup && (!keys || keys.includes(filter.key)),
    )
      .map(signalField)
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
    if (options.length === 0) continue;
    out.push({
      displayName: collection.displayName,
      name: collection.name,
      type: "collection",
      placeholder: collection.placeholder,
      default: {},
      description: collection.description,
      ...(Object.keys(show).length > 0 ? { displayOptions: { show } } : {}),
      options,
    });
  }
  return out;
}

/** Labels of the filters that count as narrowing, for the trigger's notice and errors. */
export const NARROWING_SIGNAL_FILTER_LABELS: readonly string[] = HIRING_SIGNAL_FILTERS.filter(
  (filter) => filter.narrowing,
).map((filter) => filter.label);
