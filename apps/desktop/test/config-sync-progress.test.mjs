/**
 * The sync card's progress reading: which fraction a report produces, and when
 * the card reports activity instead of a number.
 *
 * `configSync.syncNow` is one request, so the report is the only thing the card
 * draws while it runs. The rules live in a pure module so they can be asserted
 * here instead of through the page that owns the subscription.
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { CONFIG_SYNC_PHASE_KEYS, configSyncProgressView, formatBytes } =
  await import("../src/features/settings/config-sync-progress.ts");

const report = (phase, extra = {}) => ({
  phase,
  done: 0,
  total: 0,
  bytesDone: 0,
  bytesTotal: 0,
  ...extra,
});

test("every phase names a catalog key", () => {
  assert.deepEqual(Object.keys(CONFIG_SYNC_PHASE_KEYS).sort(), [
    "apply",
    "capture",
    "cleanup",
    "download",
    "merge",
    "upload",
  ]);
  for (const [phase, key] of Object.entries(CONFIG_SYNC_PHASE_KEYS)) {
    assert.equal(
      key,
      `settings.configSync.progress.phase.${phase}`,
      `${phase} must resolve to its own catalog entry`,
    );
  }
});

test("an announced byte total decides the reading", () => {
  const view = configSyncProgressView(
    report("upload", { done: 3, total: 12, bytesDone: 3_355_443, bytesTotal: 16_777_216 }),
  );

  assert.equal(view.determinate, true);
  assert.equal(view.percent, 20);
  assert.deepEqual(view.bytes, { done: "3.20 MB", total: "16.00 MB" });
  assert.deepEqual(view.objects, { done: 3, total: 12 });
  assert.equal(view.fraction, "3.20 MB / 16.00 MB");
});

test("a download without a byte total falls back to the object count", () => {
  // `download` reports bytesDone alone, so the phase's units are the only
  // fraction the card can honestly show.
  const view = configSyncProgressView(
    report("download", { done: 12, total: 45, bytesDone: 3_145_728 }),
  );

  assert.equal(view.determinate, true);
  assert.equal(view.percent, 27);
  assert.equal(view.bytes, null);
  assert.deepEqual(view.objects, { done: 12, total: 45 });
  assert.equal(view.fraction, "12 / 45");
});

test("a report with no announced total stays indeterminate", () => {
  // merge and cleanup are always counted per run, not per unit; so is a phase
  // whose total the host has not learned yet.
  const view = configSyncProgressView(report("merge", { done: 4, bytesDone: 512 }));

  assert.equal(view.determinate, false);
  assert.equal(view.percent, 0);
  assert.equal(view.fraction, null);
  assert.equal(view.bytes, null);
  assert.equal(view.objects, null);
  assert.equal(view.phaseKey, "settings.configSync.progress.phase.merge");
});

test("a fraction that overshoots its total stays a valid percentage", () => {
  const view = configSyncProgressView(
    report("capture", { done: 11, total: 10, bytesDone: 5, bytesTotal: 4 }),
  );

  assert.equal(view.percent, 100);
  assert.equal(configSyncProgressView(report("capture", { total: 10 })).percent, 0);
});

test("byte figures read at every scale and never invent a size", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(3_145_728), "3.00 MB");
  assert.equal(formatBytes(2_147_483_648), "2.00 GB");
  assert.equal(formatBytes(Number.NaN), "0 B");
  assert.equal(formatBytes(-1), "0 B");
});
