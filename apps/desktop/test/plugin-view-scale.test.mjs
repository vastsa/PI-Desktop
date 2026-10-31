import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { DEFAULT_PLUGIN_VIEW_SCALE, normalizePluginViewScale, pluginViewZoom } =
  await import("../electron/main/plugin-view-scale.ts");

/**
 * A docked plugin view is its own web page, so the app's `--font-scale` and the
 * window zoom never reach it as CSS. The host republishes both as that page's
 * zoom instead; these are the rules it composes them with (D343 / ADR 0180).
 */

test("the default factor leaves a plugin page at its author size", () => {
  assert.equal(DEFAULT_PLUGIN_VIEW_SCALE, 1);
  assert.equal(pluginViewZoom(1, 1), 1);
  // Nothing to apply: a view opened at 100% keeps painting 12px/13px chrome.
  assert.equal(normalizePluginViewScale(1), 1);
});

test("the Appearance type scale and the window zoom compose", () => {
  assert.equal(pluginViewZoom(1.25, 1), 1.25);
  assert.equal(pluginViewZoom(1, 1.1), 1.1);
  // Both are painted into one window, so a 125% type scale inside a 90% window
  // needs the same product a CSS pixel in the app sees.
  assert.equal(pluginViewZoom(1.25, 0.9), 1.125);
  assert.equal(pluginViewZoom(0.85, 1.1), 0.935);
});

test("the composed factor is stable for an unchanged pair", () => {
  // A settled scale must not re-apply a zoom that only differs in float noise.
  assert.equal(pluginViewZoom(1.15, 1.1), pluginViewZoom(1.15, 1.1));
  assert.equal(pluginViewZoom(1.15, 1.1), 1.265);
});

test("an unusable factor falls back instead of poisoning the page zoom", () => {
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "1.25", null, undefined]) {
    assert.equal(normalizePluginViewScale(bad), 1);
  }
  assert.equal(pluginViewZoom(Number.NaN, 1), 1);
  assert.equal(pluginViewZoom(1.25, 0), 1.25);
});