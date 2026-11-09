/**
 * Assert the built nodes' filter surface against the shared contract
 * (Jobo.Connectors/contracts/filters.json, generated from connector-core's
 * JOB_SEARCH_FILTERS / JOB_FEED_FILTER_KEYS). This is what makes the core's
 * "a filter cannot exist in one connector and quietly go missing from
 * another" promise enforceable for n8n — in both directions: every contract
 * filter must be exposed, and every exposed filter must be a contract key.
 *
 * Runs against the BUILT bundle like verify-constraints.mjs — the shipped
 * property schema is the artifact users see, not the TypeScript.
 *
 * The public one-way mirror of n8n/ does not contain ../contracts/, so the
 * script exits 0 with a notice when the contract is absent; monorepo CI is
 * where it bites.
 */
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const contractPath = join(root, "..", "contracts", "filters.json");

if (!existsSync(contractPath)) {
  console.log("filters contract not present (public mirror build) — skipping filter drift checks");
  process.exit(0);
}

const contract = JSON.parse(readFileSync(contractPath, "utf8"));
const require = createRequire(import.meta.url);

const failures = [];
const check = (label, ok, detail = "") => {
  if (ok) {
    console.log(`  ok    ${label}`);
  } else {
    failures.push(detail || label);
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
};

const sameSet = (a, b) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

const searchKeys = contract.search_filters.map((f) => f.key);
const feedKeys = contract.feed_filter_keys;
const { enums } = contract;

/**
 * Filters that live outside the collections: top-level fields and the
 * include / exclude fixedCollections of resource locators.
 */
const TOP_LEVEL_SEARCH = {
  q: "q",
  location: "location",
  companyFilter: ["companies", "exclude_companies"],
  occupationFilter: ["occupation_ids", "exclude_occupation_ids"],
};
const TOP_LEVEL_FEED = { companyFilter: ["companies"], occupationFilter: ["occupation_ids"] };
/** Output options that are not filters. */
const NON_FILTER_OPTIONS = ["include_fields", "simplify"];

/** The properties a node shows for a version / resource / operation. */
function visible(instance, version, show) {
  return instance.description.properties.filter((p) => {
    const conditions = p.displayOptions?.show ?? {};
    for (const [key, values] of Object.entries(conditions)) {
      if (key === "@version") {
        const ok = values.some((v) =>
          typeof v === "object" && v?._cnd ? version >= (v._cnd.gte ?? -Infinity) : v === version,
        );
        if (!ok) return false;
      } else if (show[key] !== undefined && !values.includes(show[key])) {
        return false;
      }
    }
    return true;
  });
}

function collectionOptions(properties, name) {
  const collection = properties.find((p) => p.name === name && p.type === "collection");
  return collection ? collection.options : [];
}

function optionValues(options, name) {
  const field = options.find((o) => o.name === name);
  return (field?.options ?? []).map((o) => o.value);
}

function exposedSearchKeys(properties) {
  const keys = new Set();
  for (const p of properties) {
    const mapped = TOP_LEVEL_SEARCH[p.name];
    if (typeof mapped === "string") keys.add(mapped);
    else if (Array.isArray(mapped)) mapped.forEach((k) => keys.add(k));
  }
  for (const name of ["filters", "exclude", "options"]) {
    for (const option of collectionOptions(properties, name)) keys.add(option.name);
  }
  return keys;
}

function checkSearchSurface(label, properties, { trigger }) {
  const exposed = exposedSearchKeys(properties);
  const filters = collectionOptions(properties, "filters");
  const exclude = collectionOptions(properties, "exclude");
  const options = collectionOptions(properties, "options");

  // Fields a trigger leaves out on purpose: the poll owns the watermark and
  // the order, and posted_before has no use on a forward-moving sync.
  const triggerGaps = ["discovered_after", "discovered_before", "sort", "posted_before"];

  for (const key of searchKeys) {
    if (trigger && triggerGaps.includes(key)) {
      check(`${label}: "${key}" deliberately not exposed`, !exposed.has(key));
      continue;
    }
    check(`${label}: search filter "${key}" exposed`, exposed.has(key));
  }
  for (const option of [...filters, ...exclude]) {
    check(`${label}: "${option.name}" is a contract search filter`, searchKeys.includes(option.name));
  }
  for (const option of options) {
    check(
      `${label}: option "${option.name}" is a contract key or output option`,
      searchKeys.includes(option.name) || NON_FILTER_OPTIONS.includes(option.name),
    );
  }

  for (const [field, values] of [
    ["work_model", enums.work_models],
    ["employment_type", enums.employment_types],
    ["experience_level", enums.experience_levels],
    ["language", enums.languages],
  ]) {
    check(`${label}: "${field}" options match canonical enums`, sameSet(optionValues(filters, field), values));
  }
  if (!trigger) {
    check(`${label}: "sort" options match canonical enums`, sameSet(optionValues(options, "sort"), enums.search_sorts));
  }
  check(
    `${label}: "description_format" options match canonical enums`,
    sameSet(optionValues(options, "description_format"), enums.description_formats),
  );
}

console.log("n8n filter contract:\n");

// ── Action node ──────────────────────────────────────────────────────────────
const { Jobo } = require(join(root, "dist", "nodes", "Jobo", "Jobo.node.js"));
const action = new Jobo();
const versions = [].concat(action.description.version);

for (const version of versions) {
  const search = visible(action, version, { resource: "job", operation: "search" });
  checkSearchSurface(`v${version} search`, search, { trigger: false });

  const skills = collectionOptions(search, "filters").find((o) => o.name === "skills");
  check(
    `v${version} search: skills is ${version === 1 ? "a free-text list (saved v1 shape)" : "a picker"}`,
    version === 1 ? skills?.type === "string" && skills?.typeOptions?.multipleValues : skills?.type === "multiOptions",
  );

  // ── Feed (plural keys are the feed wire contract) ──────────────────────────
  const feed = visible(action, version, { resource: "job", operation: "feed" });
  const feedFilters = collectionOptions(feed, "feedFilters");
  const feedExclude = collectionOptions(feed, "feedExclude");
  const feedOptions = collectionOptions(feed, "options");
  const feedExposed = new Set([...feedFilters, ...feedExclude, ...feedOptions].map((o) => o.name));
  for (const p of feed) for (const k of TOP_LEVEL_FEED[p.name] ?? []) feedExposed.add(k);

  for (const key of feedKeys) {
    check(`v${version} feed: feed key "${key}" exposed`, feedExposed.has(key));
  }
  for (const option of [...feedFilters, ...feedExclude, ...feedOptions]) {
    check(`v${version} feed: "${option.name}" is a contract feed key`, feedKeys.includes(option.name));
  }
  for (const [field, values] of [
    ["work_models", enums.work_models],
    ["employment_types", enums.employment_types],
    ["experience_levels", enums.experience_levels],
    ["languages", enums.languages],
    ["company_sizes", enums.company_sizes],
    ["company_revenues", enums.company_revenues],
  ]) {
    check(`v${version} feed: "${field}" options match canonical enums`, sameSet(optionValues(feedFilters, field), values));
  }
  for (const [field, values] of [
    ["exclude_work_models", enums.work_models],
    ["exclude_employment_types", enums.employment_types],
    ["exclude_experience_levels", enums.experience_levels],
    ["exclude_languages", enums.languages],
  ]) {
    check(`v${version} feed: "${field}" options match canonical enums`, sameSet(optionValues(feedExclude, field), values));
  }
}

// ── Trigger node ─────────────────────────────────────────────────────────────
const { JoboTrigger } = require(join(root, "dist", "nodes", "Jobo", "JoboTrigger.node.js"));
const trigger = new JoboTrigger();
for (const version of [].concat(trigger.description.version)) {
  checkSearchSurface(`trigger v${version}`, visible(trigger, version, {}), { trigger: true });
}

console.log("");
if (failures.length > 0) {
  console.error(`${failures.length} filter-contract violation(s).`);
  process.exit(1);
}
console.log("Filter surface matches the shared contract.");
