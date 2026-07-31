// n8n resolves a node's `icon: 'file:jobo.svg'` and its codex sidecar
// (`<Node>.node.json`, which carries the search aliases) relative to the
// compiled node file, so both must sit beside the JS in dist/. The credential
// class carries the same `file:` icon and compiles to dist/credentials/, so the
// SVG is copied there too — a credential icon that cannot be resolved from its
// own compiled location renders broken in the credential picker, and n8n's
// verification lint reports it as a missing icon file.
//
// The icon therefore exists twice in source (nodes/Jobo/ and credentials/),
// because the lint resolves `file:` paths relative to the *source* file that
// declares them. The equality check below is what stops the two copies
// drifting: edit one and the build fails until the other matches.
//
// tsup only emits code, and the usual n8n template pulls in gulp purely for
// this copy — not worth a dependency for two directories.
import { copyFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const nodesFrom = join(root, "nodes", "Jobo");
const credentialsFrom = join(root, "credentials");
const nodesTo = join(root, "dist", "nodes", "Jobo");
const credentialsTo = join(root, "dist", "credentials");

mkdirSync(nodesTo, { recursive: true });
mkdirSync(credentialsTo, { recursive: true });

const isSidecar = (file) =>
  file.endsWith(".svg") || file.endsWith(".png") || file.endsWith(".node.json");

const nodeSidecars = readdirSync(nodesFrom).filter(isSidecar);
const credentialSidecars = readdirSync(credentialsFrom).filter(isSidecar);

for (const [name, a, b] of credentialSidecars
  .filter((file) => nodeSidecars.includes(file))
  .map((file) => [file, join(nodesFrom, file), join(credentialsFrom, file)])) {
  if (!readFileSync(a).equals(readFileSync(b))) {
    console.error(
      `${name} differs between nodes/Jobo/ and credentials/. ` +
        `They must stay byte-identical — copy the updated one over the other.`,
    );
    process.exit(1);
  }
}

for (const file of nodeSidecars) {
  copyFileSync(join(nodesFrom, file), join(nodesTo, file));
}
for (const file of credentialSidecars) {
  copyFileSync(join(credentialsFrom, file), join(credentialsTo, file));
}

console.log(
  `copied ${nodeSidecars.length} sidecar file(s) to dist/nodes/Jobo and ` +
    `${credentialSidecars.length} to dist/credentials`,
);
