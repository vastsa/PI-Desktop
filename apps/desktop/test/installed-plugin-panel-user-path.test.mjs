import assert from "node:assert/strict";
import test from "node:test";
import { runIsolatedRenderer } from "./helpers/isolated-renderer.mjs";

test("installed plugin cards open declared panels through the page API and preserve other controls", {
  timeout: 75_000,
  skip: process.platform === "linux" && !process.env.DISPLAY
    ? "Isolated Electron renderer requires a display"
    : false,
}, async () => {
  const result = await runIsolatedRenderer(
    "apps/desktop/test/e2e/installed-plugin-panel/fixture.tsx",
    "installedPluginPanelProbe",
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.locales, ["en", "zh-CN"]);
  assert.deepEqual(result.checks, [
    "panel-declaration-and-enabled-gates",
    "open-with-and-without-update",
    "settings-and-menu-controls",
    "disable-through-scope-control",
    "host-error-feedback",
  ]);
});
