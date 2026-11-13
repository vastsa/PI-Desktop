import assert from "node:assert/strict";
import test from "node:test";
import { runIsolatedRenderer } from "./helpers/isolated-renderer.mjs";

test("explicit interface refresh preserves live drafts and restores presentation without executing agents", { timeout: 80_000 }, async () => {
  const result = await runIsolatedRenderer("apps/desktop/test/e2e/renderer-refresh/fixture.tsx", "runRendererRefreshProbe");
  assert.equal(result.reloads, 1);
  assert.equal(result.checks.length, 6);
});

test("a cancelled renderer reload exposes retry, preserves drafts and cleans up its deadline", { timeout: 80_000 }, async () => {
  const result = await runIsolatedRenderer("apps/desktop/test/e2e/renderer-refresh/fixture.tsx", "runRendererRefreshRetryProbe");
  assert.deepEqual(result, { reloads: 2, retryable: true, preserved: true });
});
