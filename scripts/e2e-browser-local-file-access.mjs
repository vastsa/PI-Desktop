import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveElectronBinary } from "./e2e/boot.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dependencyRoot = process.env.E2E_DEPENDENCY_ROOT || root;
const require = createRequire(join(dependencyRoot, "packages/agent-runtime/package.json"));
const { build } = require("esbuild");
const { electronBinary } = resolveElectronBinary(dependencyRoot);
const artifacts = mkdtempSync(join(tmpdir(), "pi-browser-local-files-"));
const main = join(artifacts, "main.cjs");
await build({
  entryPoints: [join(root, "scripts/e2e/browser-local-file-access.ts")],
  outfile: main,
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["electron"],
});
const env = { ...process.env, BROWSER_LOCAL_FILE_ARTIFACT_DIR: artifacts };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electronBinary, [main], { env, stdio: ["ignore", "pipe", "pipe"] });
let output = "";
for (const stream of [child.stdout, child.stderr]) {
  stream.on("data", (data) => { output += data; });
}
const timeout = setTimeout(() => child.kill(), 30_000);
let code;
try {
  code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
} finally {
  clearTimeout(timeout);
}
console.log(`Browser local-file artifacts retained at ${artifacts}`);
console.log(output.trim());
assert.equal(code, 0, "native browser local-file access regression failed");
assert.match(output, /"ok":true/);
