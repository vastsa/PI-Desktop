import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const require = createRequire(import.meta.url);
const { build } = createRequire(new URL("../../../packages/agent-runtime/package.json", import.meta.url))("esbuild");

test("Main module paths resolve to the output root from inside Rollup chunks", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-main-module-path-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = join(root, "probe.mjs");
  await build({
    entryPoints: [fileURLToPath(new URL("../electron/main/module-path.ts", import.meta.url))],
    outfile: output,
    bundle: true,
    platform: "node",
    format: "esm",
  });
  const { getModuleDirectory } = await import(pathToFileURL(output).href);

  // The entry bundle itself (…/out/main/index.js).
  assert.equal(
    getModuleDirectory(pathToFileURL(join(root, "out/main/index.js")).href),
    join(root, "out/main"),
  );
  // A shared chunk (…/out/main/chunks/index-XXXX.js) — the layout that put the
  // window bootstrap, preload and plugin-host paths one level too deep.
  assert.equal(
    getModuleDirectory(pathToFileURL(join(root, "out/main/chunks/index-ABCD1234.js")).href),
    join(root, "out/main"),
  );
  // The relative runtime paths stay exactly what the call sites author.
  assert.equal(
    join(getModuleDirectory(pathToFileURL(join(root, "out/main/chunks/index-ABCD1234.js")).href), "../renderer/index.html"),
    join(root, "out/renderer/index.html"),
  );
  assert.equal(
    join(getModuleDirectory(pathToFileURL(join(root, "out/main/chunks/index-ABCD1234.js")).href), "plugin-host-process.js"),
    join(root, "out/main/plugin-host-process.js"),
  );
});
