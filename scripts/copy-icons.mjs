// n8n resolves a node's `icon: 'file:jobo.png'` and its codex sidecar
// (`<Node>.node.json`, which carries the search aliases) relative to the
// compiled node file, so both must sit beside the JS in dist/. tsup only emits code, and
// the usual n8n template pulls in gulp purely for this copy — not worth a
// dependency for one file.
import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const from = join(root, "nodes", "Jobo");
const to = join(root, "dist", "nodes", "Jobo");

mkdirSync(to, { recursive: true });

const icons = readdirSync(from).filter((file) => file.endsWith(".svg") || file.endsWith(".png") || file.endsWith(".node.json"));
for (const icon of icons) {
  copyFileSync(join(from, icon), join(to, icon));
}

console.log(`copied ${icons.length} sidecar file(s) to dist/nodes/Jobo`);
