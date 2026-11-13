import assert from "node:assert/strict";
import test from "node:test";
import { runIsolatedRenderer } from "./helpers/isolated-renderer.mjs";

test("project creation, editing and app-owned Markdown preserve capability choices", { timeout: 75_000 }, async () => {
  const result = await runIsolatedRenderer("apps/desktop/test/e2e/project-settings/fixture.tsx", "projectSettingsProbe", { width: 900, height: 720 });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.checks, ["create-through-store", "edit-round-trip-and-byte-limit", "app-owned-instructions",
    "existing-project-preservation", "catalog-race-retry-unavailable"]);
  assert.equal(result.writes, 3);
});

for (const width of [900, 660, 420]) {
  test(`project capability descriptions never overlap and remain selectable at ${width}px`, { timeout: 75_000 }, async () => {
    const result = await runIsolatedRenderer("apps/desktop/test/e2e/project-settings/fixture.tsx", "projectSettingsLayoutProbe", { width, height: 720 });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.checks, ["en-create-long-catalog", "en-edit-long-catalog", "zh-CN-create-long-catalog", "zh-CN-edit-long-catalog"]);
  });
}
