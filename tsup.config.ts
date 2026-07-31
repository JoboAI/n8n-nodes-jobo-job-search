import { defineConfig } from "tsup";

// n8n verification forbids runtime `dependencies`, so @jobo-ai/connector-core is
// a devDependency and gets inlined here (`noExternal`). n8n-workflow stays
// external — it is a peer supplied by the host at runtime and must never be
// bundled, or the node would ship a second copy of n8n's own types/helpers.
//
// Output paths must match the `n8n.nodes` / `n8n.credentials` entries in
// package.json exactly; n8n loads those files and reads the exported class.
export default defineConfig({
  entry: {
    "credentials/JoboApi.credentials": "credentials/JoboApi.credentials.ts",
    "nodes/Jobo/Jobo.node": "nodes/Jobo/Jobo.node.ts",
    "nodes/Jobo/JoboTrigger.node": "nodes/Jobo/JoboTrigger.node.ts",
  },
  format: ["cjs"],
  target: "node20",
  dts: false,
  sourcemap: false,
  clean: true,
  splitting: false,
  treeshake: true,
  external: ["n8n-workflow"],
  noExternal: ["@jobo-ai/connector-core"],
});
