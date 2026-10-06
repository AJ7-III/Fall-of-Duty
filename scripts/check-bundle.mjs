import assert from "node:assert/strict";
import { readdirSync, statSync, readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

const chunks = readdirSync("dist/assets")
  .filter((file) => file.endsWith(".js"))
  .map((file) => ({
    file,
    bytes: statSync(`dist/assets/${file}`).size,
  }));
assert.ok(chunks.length > 0, "No JavaScript chunks found; run a production build first");
const total = chunks.reduce((sum, chunk) => sum + chunk.bytes, 0);
const largest = chunks.reduce((a, b) => (a.bytes > b.bytes ? a : b));
const gzip = gzipSync(readFileSync(`dist/assets/${largest.file}`)).length;
assert.ok(total <= 4_000_000, `JavaScript exceeded the 4 MB budget: ${total} bytes`);
assert.ok(largest.bytes <= 1_600_000, `Chunk exceeded the 1.6 MB budget: ${largest.file}, ${largest.bytes} bytes`);
console.log(
  `Bundle budget passed: ${(total / 1e6).toFixed(2)} MB total JavaScript; largest chunk ${(largest.bytes / 1e6).toFixed(2)} MB (${(gzip / 1e3).toFixed(0)} kB gzip).`
);
