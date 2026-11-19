import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { buildSync } from "esbuild";

test("workspace file index and search fall back at the Git deadline without a close event", { timeout: 5_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "pi-index-deadline-"));
  await writeFile(join(root, "note.txt"), "fixture");
  const require = createRequire(import.meta.url);
  const processModule = require("node:child_process");
  const originalSpawn = processModule.spawn;
  let spawned;
  const ready = new Promise(resolve => { spawned = resolve; });
  let killed = false;
  processModule.spawn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stdout.setEncoding = () => {};
    child.stdout.destroy = () => {};
    child.stderr = new EventEmitter();
    child.stderr.destroy = () => {};
    child.kill = () => { killed = true; return true; };
    spawned();
    return child;
  };
  try {
    const result = buildSync({ entryPoints: [fileURLToPath(new URL("../../../packages/host-runtime/src/fs-index.ts", import.meta.url))], bundle: true, write: false, platform: "node", format: "cjs" });
    const module = { exports: {} };
    new Function("require", "module", "exports", result.outputFiles[0].text)(require, module, module.exports);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const pending = module.exports.getWorkspaceFileIndex(root);
    await ready;
    t.mock.timers.tick(3_999);
    assert.equal(killed, false, "Git must remain running before its deadline");
    t.mock.timers.tick(1);
    assert.equal(killed, true);
    // The deadline starts fallback; real disk IO need not finish in a fixed number of event-loop turns.
    const listing = await pending;
    assert.ok(listing, "the file index must settle without Git close");
    assert.deepEqual(listing.entries, [{ path: "note.txt", kind: "file" }]);
    assert.deepEqual((await module.exports.searchWorkspaceFiles(root, "note")).entries, listing.entries);
  } finally {
    t.mock.timers.reset();
    processModule.spawn = originalSpawn;
    await rm(root, { recursive: true, force: true });
  }
});
