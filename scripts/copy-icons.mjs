// n8n resolves a node's `icon: 'file:jobo.png'` relative to the compiled node
// file, so the icon has to sit beside the JS in dist/. tsup only emits code, and
// the usual n8n template pulls in gulp purely for this copy — not worth a
// dependency for one file.
import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const from = join(root, "nodes", "Jobo");
const to = join(root, "dist", "nodes", "Jobo");

mkdirSync(to, { recursive: true });

const icons = readdirSync(from).filter((file) => file.endsWith(".svg") || file.endsWith(".png"));
for (const icon of icons) {
  copyFileSync(join(from, icon), join(to, icon));
}

console.log(`copied ${icons.length} icon(s) to dist/nodes/Jobo`);
