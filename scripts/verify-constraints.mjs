/**
 * Assert the n8n verified-community-node constraints locally.
 *
 * `npx @n8n/scan-community-package` resolves packages by name from the npm
 * registry, so it cannot run against a working tree — by the time it can tell
 * you something is wrong, you have already published. These checks cover the
 * documented rules so a violation fails in CI instead.
 *
 * Checks run against the BUILT output as well as the manifest, because
 * connector-core is inlined at build time: a banned API reaching the bundle
 * through a dependency is exactly what a source-only check would miss.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const failures = [];
const check = (label, ok, detail = "") => {
  if (ok) {
    console.log(`  ok    ${label}`);
  } else {
    failures.push(detail || label);
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
};

console.log("n8n verified-node constraints:\n");

// 1. Zero runtime dependencies — the rule the whole build strategy exists for.
const deps = Object.keys(pkg.dependencies ?? {});
check("no runtime dependencies", deps.length === 0, deps.length ? `found: ${deps.join(", ")}` : "");

// 2. `overrides` is banned outright.
check("no overrides field", pkg.overrides === undefined);

// 3. MIT licence.
check("MIT licence", pkg.license === "MIT", `found: ${pkg.license}`);

// 4. Discovery keyword.
check(
  "n8n-community-node-package keyword",
  Array.isArray(pkg.keywords) && pkg.keywords.includes("n8n-community-node-package"),
);

// 5. Public repository, matching the npm package.
const repoUrl = pkg.repository?.url ?? "";
check("public git repository declared", /github\.com/.test(repoUrl), `found: ${repoUrl || "none"}`);

// 6. n8n manifest present and pointing at real files.
check("n8nNodesApiVersion set", pkg.n8n?.n8nNodesApiVersion === 1);

const declared = [...(pkg.n8n?.nodes ?? []), ...(pkg.n8n?.credentials ?? [])];
check("n8n manifest lists nodes and credentials", declared.length > 0);
for (const rel of declared) {
  let exists = false;
  try {
    exists = statSync(join(root, rel)).isFile();
  } catch {
    exists = false;
  }
  check(`built file exists: ${rel}`, exists, exists ? "" : "run npm run build first");
}

// 7. Banned runtime APIs, checked against the bundle.
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith(".js")) out.push(full);
  }
  return out;
}

let bundles = [];
try {
  bundles = walk(join(root, "dist"));
} catch {
  check("dist/ exists", false, "run npm run build first");
}

const banned = [
  { name: "filesystem access", pattern: /require\(["'](node:)?fs["']\)|from ["'](node:)?fs["']/ },
  { name: "child process", pattern: /require\(["'](node:)?child_process["']\)|from ["'](node:)?child_process["']/ },
  { name: "environment variables", pattern: /process\.env/ },
];

for (const { name, pattern } of banned) {
  const hits = bundles.filter((file) => pattern.test(readFileSync(file, "utf8")));
  check(
    `no ${name} in the bundle`,
    hits.length === 0,
    hits.length ? `in ${hits.map((h) => h.replace(root + "/", "")).join(", ")}` : "",
  );
}

// 8. n8n-workflow must stay external — bundling it would ship a second copy of
//    the host's own runtime.
const nodeBundles = bundles.filter((f) => f.includes("nodes/"));
const externalised = nodeBundles.every((file) => /require\(["']n8n-workflow["']\)/.test(readFileSync(file, "utf8")));
check("n8n-workflow required externally, not bundled", nodeBundles.length > 0 && externalised);

console.log("");
if (failures.length > 0) {
  console.error(`${failures.length} constraint violation(s). This package would fail n8n verification.`);
  process.exit(1);
}
console.log("All n8n verified-node constraints satisfied.");
