import { accessSync, copyFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = join(root, "dist");
accessSync(join(output, "index.html"));
mkdirSync(join(output, "LICENSES"), { recursive: true });

const notices = [
  ["LICENSE", "LICENSE"],
  ["THIRD_PARTY_NOTICES.md", "THIRD_PARTY_NOTICES.md"],
  ["node_modules/@babylonjs/core/license.md", "LICENSES/babylon-core-LICENSE.md"],
  ["node_modules/@babylonjs/core/NOTICE.md", "LICENSES/babylon-core-NOTICE.md"],
  ["node_modules/@babylonjs/loaders/license.md", "LICENSES/babylon-loaders-LICENSE.md"],
];

for (const [source, destination] of notices) {
  copyFileSync(join(root, source), join(output, destination));
}
console.log("Copied project license, asset notices and Babylon.js licenses/attributions into dist.");
