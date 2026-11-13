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
 *
 * It then rewrites that state into what an older build persisted for the id
 * `e2e.foo!bar` (raw id in the registry row and installed manifest, sanitized
 * directory names), restarts the host, and tries to install and load the
 * valid id `e2e.foo_bar`. Both must be refused and the legacy plugin's
 * files, data, and registry must stay as they were.
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

async function expectRefused(host, path, lookAlike, reason) {
  for (const [method, params] of [
    ["plugins.installFromPath", { path, enable: true }],
    ["plugins.loadDev", { path }],
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

async function e2eIds(host) {
  const { plugins } = await host.call("plugins.list", {});
  return plugins.map((plugin) => plugin.id).filter((id) => id.startsWith("e2e."));
}

const attempts = [];
let host = new Host(hostBinary, dataDir, { quiet: true });
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
    await expectRefused(host, second, lookAlike, reason);
  }

  assert.match(await readFile(installedMain, "utf8"), /first plugin/, "first plugin's files stay its own");
  assert.equal(await readFile(dataMarker, "utf8"), "first plugin data", "first plugin's data stays its own");
  assert.deepEqual(await readdir(join(dataDir, "plugins/installed")), ["e2e.foo_bar"]);
  assert.deepEqual(await e2eIds(host), ["e2e.foo_bar"]);

  // Legacy state: an older build accepted `e2e.foo!bar` and stored it under
  // the sanitized name `e2e.foo_bar`.
  await host.stop();
  const registryPath = join(dataDir, "plugins/registry.json");
  const legacyId = (text) => text.replaceAll('"e2e.foo_bar"', '"e2e.foo!bar"');
  const registry = legacyId(await readFile(registryPath, "utf8"));
  await writeFile(registryPath, registry);
  const manifestPath = join(dataDir, "plugins/installed/e2e.foo_bar/manifest.json");
  await writeFile(manifestPath, legacyId(await readFile(manifestPath, "utf8")));
  await writeFile(dataMarker, "legacy plugin data");

  host = new Host(hostBinary, dataDir, { quiet: true });
  await host.start();
  assert.deepEqual(await e2eIds(host), ["e2e.foo!bar"]);
  const alias = join(scratch, "src-alias");
  await writePlugin(alias, "e2e.foo_bar", "alias plugin");
  await expectRefused(
    host,
    alias,
    "e2e.foo_bar",
    /PLUGIN_INVALID: id e2e\.foo_bar would share storage with installed plugin e2e\.foo!bar/,
  );
  assert.match(await readFile(installedMain, "utf8"), /first plugin/, "legacy plugin's files stay its own");
  assert.equal(await readFile(dataMarker, "utf8"), "legacy plugin data", "legacy plugin's data stays its own");
  assert.equal(await readFile(registryPath, "utf8"), registry, "legacy registry is unchanged");
  assert.deepEqual(await readdir(join(dataDir, "plugins/installed")), ["e2e.foo_bar"]);
  assert.deepEqual(await e2eIds(host), ["e2e.foo!bar"]);

  console.log("PASS: plugin ids that map onto another plugin's directory are refused");
} finally {
  await host.stop().catch(() => {});
  await rm(scratch, { recursive: true, force: true });
}
