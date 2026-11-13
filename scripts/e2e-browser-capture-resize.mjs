import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveElectronBinary } from "./e2e/boot.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Reuse compatible installed dependencies without importing their app source.
const dependencyRoot = process.env.E2E_DEPENDENCY_ROOT || root;
const require = createRequire(join(dependencyRoot, "packages/agent-runtime/package.json"));
const { build } = require("esbuild");
const { electronBinary } = resolveElectronBinary(dependencyRoot);
const artifacts = mkdtempSync(join(tmpdir(), "pi-browser-capture-resize-"));
const main = join(artifacts, "main.cjs");
await build({
  entryPoints: [join(root, "scripts/e2e/browser-capture-resize.ts")],
  outfile: main, bundle: true, platform: "node", format: "cjs", external: ["electron"],
});
const env = { ...process.env, BROWSER_CAPTURE_ARTIFACT_DIR: artifacts };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electronBinary, [main], { env, stdio: ["ignore", "pipe", "pipe"] });
let output = "";
for (const stream of [child.stdout, child.stderr]) {
  stream.on("data", (data) => { output += data; });
}
const timeout = setTimeout(() => child.kill(), 45_000);
let code;
try {
  code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
} finally { clearTimeout(timeout); }
console.log(`Browser capture artifacts retained at ${artifacts}`);
if (code !== 0) {
  try { console.error(readFileSync(join(artifacts, "progress.log"), "utf8")); }
  catch (error) { console.error("Could not read capture progress:", error.message); }
}
console.log(output.trim());
assert.equal(code, 0, "native browser capture/resize regression failed");
assert.match(output, /BROWSER_CAPTURE_RESIZE {"ok":true/);
