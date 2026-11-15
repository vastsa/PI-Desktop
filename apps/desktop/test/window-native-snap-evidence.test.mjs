import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const evidence = new URL("../../../docs/project/windows-native-snap-evidence/38c5a5bd77ef/", import.meta.url);
const json = async (name) => JSON.parse(await readFile(new URL(name, evidence), "utf8"));

test("activation replay artifacts retain their exact source revision and bytes", async () => {
  const root = new URL("../2b52999879a6/", evidence);
  const manifest = JSON.parse(await readFile(new URL("manifest.json", root), "utf8"));
  assert.equal(manifest.sourceRevision, "2b52999879a65d35ce7c29dc0dcf29047ee3a02d");
  for (const [name, expected] of Object.entries(manifest.files)) {
    assert.equal(createHash("sha256").update(await readFile(new URL(name, root))).digest("hex"), expected, name);
  }
  const summary = JSON.parse(await readFile(new URL("summary.json", root), "utf8"));
  assert.equal(summary.source.revision, manifest.sourceRevision);
  assert.equal(summary.source.clean, true);
  assert.equal(summary.hostSha256, manifest.hostSha256);
  assert.equal(summary.ok, true);
  assert.deepEqual(summary.cases.map(({ name, passed }) => [name, passed]), [["baseline", true], ["candidate", true]]);
});

test("preserved native evidence verifies after checkout without changing stream bytes", async () => {
  const manifest = await json("manifest.json");
  assert.equal(manifest.sourceRevision, "38c5a5bd77ef910849ce3c1bc5f5d8577dad1a71");
  for (const [name, expected] of Object.entries(manifest.files)) {
    const bytes = await readFile(new URL(name, evidence));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), expected, name);
  }
});

test("preserved baseline and candidate describe the same native snap regression", async () => {
  const baseline = await json("baseline.json");
  const candidate = await json("candidate.json");
  assert.equal(baseline.ok, false);
  assert.match(baseline.error, /Win\+Left did not snap to the work-area half/);
  assert.deepEqual(baseline.left, baseline.before);
  assert.equal(candidate.ok, true);
  assert.ok(candidate.checks >= 121);
  assert.equal(candidate.environment.electronVersion, baseline.environment.electronVersion);
  assert.deepEqual(candidate.environment.workArea, baseline.environment.workArea);
  const area = candidate.environment.workArea;
  for (const state of ["keyboardMaximized", "maximized", "restoredMaximized"]) {
    const bounds = candidate[state];
    assert.deepEqual([bounds.clientX, bounds.clientY, bounds.clientWidth, bounds.clientHeight],
      [area.x, area.y, area.width, area.height]);
    assert.deepEqual([bounds.visibleX, bounds.visibleY, bounds.visibleWidth, bounds.visibleHeight],
      [area.x, area.y, area.width, area.height]);
  }
});
