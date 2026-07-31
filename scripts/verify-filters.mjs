/**
 * Assert the built nodes' filter surface against the shared contract
 * (Jobo.Connectors/contracts/filters.json, generated from connector-core's
 * JOB_SEARCH_FILTERS). This is what makes the core's "a filter cannot exist
 * in one connector and quietly go missing from another" promise enforceable
 * for n8n.
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

function jobProperties(instance) {
  return instance.description.properties.filter(
    (p) => !p.displayOptions || !p.displayOptions.show?.resource || p.displayOptions.show.resource.includes("job"),
  );
}

function collectionOptionNames(properties, collectionName) {
  const collection = properties.find((p) => p.name === collectionName);
  return collection ? collection.options.map((o) => o.name) : [];
}

function enumValues(properties, collectionName, fieldName) {
  const collection = properties.find((p) => p.name === collectionName);
  const field = collection?.options.find((o) => o.name === fieldName);
  return (field?.options ?? []).map((o) => o.value);
}

console.log("n8n filter contract:\n");

const searchKeys = contract.search_filters.map((f) => f.key);
const enums = {
  work_model: contract.enums.work_models,
  employment_type: contract.enums.employment_types,
  experience_level: contract.enums.experience_levels,
};

// ── Action node ──────────────────────────────────────────────────────────────
const { Jobo } = require(join(root, "dist", "nodes", "Jobo", "Jobo.node.js"));
const action = jobProperties(new Jobo());
const actionTopLevel = action.map((p) => p.name);
const actionFilters = collectionOptionNames(action, "filters");

for (const key of searchKeys) {
  // q and location are promoted to top-level fields; the rest live in the
  // search filters collection.
  const present = actionFilters.includes(key) || actionTopLevel.includes(key);
  check(`search filter "${key}" exposed`, present);
}
for (const name of actionFilters) {
  check(`"${name}" is a contract search filter`, searchKeys.includes(name));
}
for (const [key, values] of Object.entries(enums)) {
  check(
    `search "${key}" options match canonical enums`,
    sameSet(enumValues(action, "filters", key), values),
  );
}

// ── Feed collection (plural keys are the feed wire contract) ─────────────────
const feedFilters = collectionOptionNames(action, "feedFilters");
for (const name of feedFilters) {
  check(`feed filter "${name}" is a contract feed key`, contract.feed_filter_keys.includes(name));
}
for (const [field, values] of [
  ["work_models", enums.work_model],
  ["employment_types", enums.employment_type],
  ["experience_levels", enums.experience_level],
]) {
  check(
    `feed "${field}" options match canonical enums`,
    sameSet(enumValues(action, "feedFilters", field), values),
  );
}

// ── Trigger node ─────────────────────────────────────────────────────────────
const { JoboTrigger } = require(join(root, "dist", "nodes", "Jobo", "JoboTrigger.node.js"));
const trigger = jobProperties(new JoboTrigger());
const triggerFilters = collectionOptionNames(trigger, "filters");

for (const name of triggerFilters) {
  check(`trigger filter "${name}" is a contract search filter`, searchKeys.includes(name));
}
check(
  "trigger does not expose the watermark fields",
  !triggerFilters.includes("discovered_after") && !triggerFilters.includes("discovered_before"),
);
for (const [key, values] of Object.entries(enums)) {
  check(
    `trigger "${key}" options match canonical enums`,
    sameSet(enumValues(trigger, "filters", key), values),
  );
}

console.log("");
if (failures.length > 0) {
  console.error(`${failures.length} filter-contract violation(s).`);
  process.exit(1);
}
console.log("Filter surface matches the shared contract.");
