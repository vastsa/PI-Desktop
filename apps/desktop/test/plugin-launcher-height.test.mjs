import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { readMainModuleSync } from "./helpers/source-contracts.mjs";
import { resolveLauncherContentHeight } from "../src/lib/launcher-height.ts";
import {
  PLUGIN_LAUNCHER_MAX_HEIGHT,
  PLUGIN_LAUNCHER_MIN_CONTENT_HEIGHT,
  clampLauncherContentHeight,
} from "../electron/main/plugin-launcher-state.ts";

test("the window height is the sum of the parts the panel renders", () => {
  const height = resolveLauncherContentHeight({
    searchRowHeight: 58,
    resultsHeight: 200,
    footerHeight: 38,
    chromeHeight: 22,
  });

  assert.equal(height, 318);
});

test("a fractional measurement rounds up so no scrollbar is left behind", () => {
  const height = resolveLauncherContentHeight({
    searchRowHeight: 57.5,
    resultsHeight: 120.25,
    footerHeight: 38,
    chromeHeight: 22,
  });

  assert.equal(height, 238);
});

test("a collapsed layout asks for no window at all", () => {
  const empty = {
    searchRowHeight: 0,
    resultsHeight: 0,
    footerHeight: 0,
    chromeHeight: 0,
  };

  assert.equal(resolveLauncherContentHeight(empty), 0);
  assert.equal(
    resolveLauncherContentHeight({ ...empty, resultsHeight: -40 }),
    0,
  );
  assert.equal(
    resolveLauncherContentHeight({ ...empty, resultsHeight: Number.NaN }),
    0,
  );
});

test("the height floor is small enough for a one-row panel", () => {
  assert.equal(PLUGIN_LAUNCHER_MIN_CONTENT_HEIGHT, 120);
  assert.ok(PLUGIN_LAUNCHER_MIN_CONTENT_HEIGHT < 380);
});

test("a measured height is clamped into the supported range", () => {
  assert.equal(clampLauncherContentHeight(320), 320);
  assert.equal(clampLauncherContentHeight(58), PLUGIN_LAUNCHER_MIN_CONTENT_HEIGHT);
  assert.equal(clampLauncherContentHeight(4_000), PLUGIN_LAUNCHER_MAX_HEIGHT);
  assert.equal(clampLauncherContentHeight(320.4), 320);
});

test("anything that is not a finite positive number is refused", () => {
  for (const value of [undefined, null, "320", Number.NaN, Infinity, -20, 0]) {
    assert.equal(clampLauncherContentHeight(value), null, String(value));
  }
});

test("the launcher window only sets the height, never the width", () => {
  const ipc = readMainModuleSync("ipc/plugin-launcher-ipc.ts");

  assert.match(ipc, /IPC\.invoke\.pluginLauncherContentHeight/);
  assert.match(ipc, /assertLauncherSender\(getPluginLauncherWindow, event\.sender\.id\)/);
  // The width keeps whatever the user dragged it to.
  assert.match(ipc, /const \[width\] = window\.getContentSize\(\);/);
  assert.match(ipc, /window\.setContentSize\(width, height, false\)/);
});

test("the panel reports its measured height instead of a remembered one", async () => {
  const launcher = await readFile(
    new URL("../src/components/PluginLauncher.tsx", import.meta.url),
    "utf8",
  );

  assert.match(launcher, /api\.launcherSetContentHeight\(/);
  assert.match(launcher, /resolveLauncherContentHeight\(/);
  assert.match(launcher, /new ResizeObserver\(/);
  // Typing narrows matches, so the window may only ever grow to the cap.
  assert.match(launcher, /plugin-launcher-results-content/);
});
