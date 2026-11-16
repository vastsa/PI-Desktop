import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("Git timeout releases file listing and preview even when child pipes never close", async t => {
  const root = await mkdtemp(join(tmpdir(), "fm-git-timeout-"));
  await writeFile(join(root, "note.txt"), "preview bytes");
  const require = createRequire(import.meta.url);
  const processModule = require("node:child_process");
  const originalSpawn = processModule.spawn;
  const previousPi = globalThis.pi;
  const entry = require.resolve("../resources/plugins/pi.file-manager/main.js");
  let spawned;
  const ready = new Promise(resolve => { spawned = resolve; });
  let killed = false;
  processModule.spawn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => { killed = true; return true; };
    spawned();
    return child;
  };
  globalThis.pi = { workspace: { get: async () => ({ path: root }) }, plugin: { getDataPath: async () => null, getSettings: async () => ({}) } };
  delete require.cache[entry];
  const plugin = require(entry);
  try {
    await plugin.onLoad();
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let listing, preview;
    const list = plugin.onPanelInvoke("fm.list", {}).then(value => { listing = value; });
    const read = plugin.onPanelInvoke("fm.read", { path: "note.txt" }).then(value => { preview = value; });
    await ready;
    t.mock.timers.tick(plugin.internals.GIT_TIMEOUT_MS);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(killed, true);
    assert.equal(listing?.ok, true, "listing must not wait for close after the deadline");
    assert.deepEqual(listing.entries.map(item => item.name), ["note.txt"]);
    assert.equal(listing.git.available, false);
    await read;
    assert.equal(preview.ok, true);
    assert.equal(preview.text, "preview bytes");
    await list;
  } finally {
    t.mock.timers.reset();
    await plugin.onUnload();
    processModule.spawn = originalSpawn;
    globalThis.pi = previousPi;
    delete require.cache[entry];
    await rm(root, { recursive: true, force: true });
  }
});
