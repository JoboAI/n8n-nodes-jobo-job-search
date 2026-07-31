/**
 * Local mirror of the ESLint config `@n8n/scan-community-package` runs.
 *
 * The official scanner resolves a package BY NAME from the npm registry and
 * lints the provenance-attested source plus the published tarball, so it can
 * only tell you about a violation after you have shipped it — which is exactly
 * how 0.1.1 reached the verification queue with 38 errors. This config is a
 * copy of `buildScanConfig()` from that package (scanner/scanner.mjs), pinned
 * to the same plugin versions, so the same rules run on `npm test`.
 *
 * Keep the three rule blocks and their `off` overrides identical to upstream.
 *
 * File selection mirrors the scanner's two legs:
 *   source  → `package.json` + `{nodes,credentials}/**\/*.{js,ts,json}`
 *   tarball → `**\/*.js` + `package.json`, i.e. `dist/**\/*.js` and `index.js`
 * The dist leg matters: connector-core is inlined at build time, so a banned
 * global can enter the bundle through a dependency without appearing in any
 * source file.
 */
import { defineConfig } from "eslint/config";
import { n8nCommunityNodesPlugin } from "@n8n/eslint-plugin-community-nodes";
import n8nNodesPlugin from "eslint-plugin-n8n-nodes-base";
import * as tsParser from "@typescript-eslint/parser";

const parser = tsParser.default ?? tsParser;

export default defineConfig(
  {
    // Everything the scanner never sees. `scripts/` and the tsup/eslint configs
    // are build tooling: not published, not part of either scan leg.
    ignores: ["scripts/**", "tsup.config.ts", "eslint.config.mjs", "node_modules/**"],
  },
  n8nCommunityNodesPlugin.configs.recommended,
  {
    rules: { "no-console": "error" },
  },
  { plugins: { "n8n-nodes-base": n8nNodesPlugin } },
  {
    files: ["package.json"],
    rules: { ...n8nNodesPlugin.configs.community.rules },
  },
  {
    files: ["**/credentials/**/*.ts"],
    rules: {
      ...n8nNodesPlugin.configs.credentials.rules,
      // Not valid for community nodes
      "n8n-nodes-base/cred-class-field-documentation-url-miscased": "off",
      // @n8n/eslint-plugin-community-nodes credential-password-field rule is more accurate
      "n8n-nodes-base/cred-class-field-type-options-password-missing": "off",
    },
  },
  {
    files: ["**/nodes/**/*.ts"],
    rules: {
      ...n8nNodesPlugin.configs.nodes.rules,
      // Inputs and outputs can be enum instead of string "main"
      "n8n-nodes-base/node-class-description-inputs-wrong-regular-node": "off",
      "n8n-nodes-base/node-class-description-outputs-wrong": "off",
      // Sometimes the 3rd party API does have a maximum limit, so maxValue is valid
      "n8n-nodes-base/node-param-type-options-max-value-present": "off",
    },
  },
  {
    files: ["**/*.json"],
    languageOptions: { parser },
  },
  {
    files: ["**/*.ts"],
    languageOptions: { parser },
  },
);
