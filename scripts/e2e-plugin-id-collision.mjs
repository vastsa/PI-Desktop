#!/usr/bin/env node
/**
 * E2E-PLUGIN-id-cannot-collide — two plugins whose ids differ only in
 * characters the host maps to `_` must not share an install directory, data
 * directory, or browser session partition (issue #2297).
 *
 * Runs the real host-core binary against a scratch data directory: installs
 * `e2e.foo_bar`, then tries to install and to load as a development plugin
 * `e2e.foo!bar`, `e2e.Foo_Bar` and `e2e.foo_bar.`. Each must be refused with
 * PLUGIN_INVALID, and the first plugin's installed files, data directory,
 * and registry row must be untouched.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Host, resolveHostBinary } from "./e2e/host.mjs";

const hostBinary = resolveHostBinary();
const scratch = await realpath(await mkdtemp(join(tmpdir(), "pi-plugin-id-collision-")));
const dataDir = join(scratch, "data");

async function writePlugin(dir, id, marker) {
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "manifest.json"),
    JSON.stringify({ schemaVersion: 1, id, name: marker, version: "1.0.0", main: "main.js" }),
  );
  await writeFile(join(dir, "main.js"), `// ${marker}\nexport function onLoad() {}\n`);
}

const attempts = [];
const host = new Host(hostBinary, dataDir, { quiet: true });
try {
  await host.start();

  const first = join(scratch, "src-first");
  await writePlugin(first, "e2e.foo_bar", "first plugin");
  await host.call("plugins.installFromPath", { path: first, enable: true });
  const installedMain = join(dataDir, "plugins/installed/e2e.foo_bar/main.js");
  const dataMarker = join(dataDir, "plugins/data/e2e.foo_bar/owner.txt");
  assert.match(await readFile(installedMain, "utf8"), /first plugin/);
  await writeFile(dataMarker, "first plugin data");

  // Each look-alike id would resolve to the first plugin's directory: by
  // character replacement, by letter case on case-insensitive file systems
  // (macOS / Windows defaults), or by Windows dropping a trailing dot.
  for (const [lookAlike, reason] of [
    ["e2e.foo!bar", /PLUGIN_INVALID: id may only contain/],
    ["e2e.Foo_Bar", /PLUGIN_INVALID: id e2e\.Foo_Bar differs from installed plugin e2e\.foo_bar only in letter case/],
    ["e2e.foo_bar.", /PLUGIN_INVALID: id must not end with '\.'/],
  ]) {
    const second = join(scratch, `src-${attempts.length}`);
    attempts.push(lookAlike);
    await writePlugin(second, lookAlike, "second plugin");
    for (const [method, params] of [
      ["plugins.installFromPath", { path: second, enable: true }],
      ["plugins.loadDev", { path: second }],
    ]) {
      await assert.rejects(
        host.call(method, params),
        (error) => {
          assert.match(String(error.message), reason);
          return true;
        },
        `${method} must refuse ${lookAlike}, which maps onto another plugin's directory`,
      );
    }
  }

  assert.match(await readFile(installedMain, "utf8"), /first plugin/, "first plugin's files stay its own");
  assert.equal(await readFile(dataMarker, "utf8"), "first plugin data", "first plugin's data stays its own");
  assert.deepEqual(await readdir(join(dataDir, "plugins/installed")), ["e2e.foo_bar"]);
  const { plugins } = await host.call("plugins.list", {});
  const ids = plugins.map((plugin) => plugin.id).filter((id) => id.startsWith("e2e."));
  assert.deepEqual(ids, ["e2e.foo_bar"]);

  console.log("PASS: plugin ids that map onto another plugin's directory are refused");
} finally {
  await host.stop().catch(() => {});
  await rm(scratch, { recursive: true, force: true });
}
