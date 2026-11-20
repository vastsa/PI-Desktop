import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  CONTEXT_WINDOW_PRESETS,
  MAX_OUTPUT_PRESETS,
  matchPresetIndex,
} from "../src/lib/model-limit-presets.ts";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("preset ladders carry the requested token values in ascending order", () => {
  assert.deepEqual(
    CONTEXT_WINDOW_PRESETS.map((preset) => preset.tokens),
    [128_000, 256_000, 312_000, 500_000, 1_000_000],
  );
  assert.deepEqual(
    CONTEXT_WINDOW_PRESETS.map((preset) => preset.label),
    ["128k", "256k", "312k", "500k", "1M"],
  );
  assert.deepEqual(
    MAX_OUTPUT_PRESETS.map((preset) => preset.tokens),
    [4_000, 8_000, 16_000, 32_000, 128_000],
  );
  assert.deepEqual(
    MAX_OUTPUT_PRESETS.map((preset) => preset.label),
    ["4k", "8k", "16k", "32k", "128k"],
  );
});

test("preset labels stay language-neutral tokens", () => {
  for (const preset of [...CONTEXT_WINDOW_PRESETS, ...MAX_OUTPUT_PRESETS]) {
    assert.match(preset.label, /^\d+(k|M)$/);
  }
});

test("matchPresetIndex highlights only an exact token count", () => {
  assert.equal(matchPresetIndex(CONTEXT_WINDOW_PRESETS, 128_000), 0);
  assert.equal(matchPresetIndex(CONTEXT_WINDOW_PRESETS, 1_000_000), 4);
  assert.equal(matchPresetIndex(MAX_OUTPUT_PRESETS, 8_000), 1);
  // Free-form defaults (131,072 context / 8,192 output) and hand-typed
  // values keep every chip unhighlighted.
  assert.equal(matchPresetIndex(CONTEXT_WINDOW_PRESETS, 131_072), -1);
  assert.equal(matchPresetIndex(MAX_OUTPUT_PRESETS, 8_192), -1);
  assert.equal(matchPresetIndex(CONTEXT_WINDOW_PRESETS, 0), -1);
  assert.equal(matchPresetIndex(CONTEXT_WINDOW_PRESETS, null), -1);
  assert.equal(matchPresetIndex(CONTEXT_WINDOW_PRESETS, undefined), -1);
});

test("both limit fields wire a preset ladder above their numeric input", async () => {
  const pane = await read("../src/components/settings/ModelAdvancedSettings.tsx");
  // One shared limit field renders the ladder; both limits use it.
  assert.equal(pane.split("<TokenLimitField").length - 1, 2);
  assert.match(pane, /className="provider-limit-presets"/);
  assert.match(pane, /presets=\{CONTEXT_WINDOW_PRESETS\}\s*value=\{binding\.contextWindow\}/);
  assert.match(pane, /presets=\{MAX_OUTPUT_PRESETS\}\s*value=\{binding\.maxTokens\}/);
  assert.match(pane, /contextWindow: tokens,\s*contextWindowSource: "user"/);
  assert.match(pane, /maxTokens: tokens,\s*maxTokensSource: "user"/);
  assert.match(pane, /onClick=\{\(\) => onChange\(preset\.tokens\)\}/);
  // The current value highlights (aria-pressed) via the shared match helper.
  assert.match(pane, /matchPresetIndex\(presets, value\)/);
  // Chips reuse the thinking controls' segmented-track style.
  assert.match(pane, /"provider-thinking-chip",\s*on && "selected"/);
});

test("the preset track styles reuse the segmented-track tokens", async () => {
  const css = await read("../src/styles/model-config.css");
  assert.match(css, /\.provider-limit-presets \{/);
  assert.match(css, /grid-template-columns: repeat\(5, minmax\(0, 1fr\)\)/);
});
