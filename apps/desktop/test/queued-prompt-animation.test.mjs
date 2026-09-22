import {
  readAppSource,
  readSettingsSource,
  readSharedTypesSource,
} from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

const rowSource = await readFile(
  new URL(
    "../src/components/settings/QueuedPromptAnimationRow.tsx",
    import.meta.url,
  ),
  "utf8",
);
const appSource = await readAppSource();
const settingsPageSource = await readSettingsSource();
const settingsSearchSource = await readFile(
  new URL("../src/lib/settings-search.ts", import.meta.url),
  "utf8",
);
const sharedTypesSource = await readSharedTypesSource();
const enLocaleSource = await readFile(
  new URL(
    "../../../packages/i18n/src/locales/en/index.ts",
    import.meta.url,
  ),
  "utf8",
);
const zhLocaleSource = await readFile(
  new URL(
    "../../../packages/i18n/src/locales/zh-CN/index.ts",
    import.meta.url,
  ),
  "utf8",
);
const deLocaleSource = await readFile(
  new URL(
    "../../../packages/i18n/src/locales/de/index.ts",
    import.meta.url,
  ),
  "utf8",
);
const styles = await loadStyles();

test("the defaults card mounts the queued prompt animation row", () => {
  assert.match(settingsPageSource, /<QueuedPromptAnimationRow /);
  assert.match(settingsPageSource, /QueuedPromptAnimationRow/);
});

test("the animation row persists every variant through AppSettings", () => {
  assert.match(rowSource, /saveSettings\(\{/);
  assert.match(rowSource, /queuedPromptAnimation:/);
  assert.match(rowSource, /settings\.queuedPromptAnimation"/);
  for (const variant of [
    "off",
    "bubbles",
    "glow",
    "wave",
  ]) {
    assert.match(rowSource, new RegExp(`id: "${variant}"`));
  }
});

test("shared types carry the validated animation union", () => {
  assert.match(
    sharedTypesSource,
    /queuedPromptAnimation\?: QueuedPromptAnimation/,
  );
});

test("the renderer applies the root data attribute without a reload", () => {
  assert.match(appSource, /resolveQueuedPromptAnimation\(settings/);
  assert.match(appSource, /dataset\.queueAnimation =/);
  assert.match(
    appSource,
    /\}, \[settings\?\.queuedPromptAnimation\]\);/,
  );
});

test("the promoted row keeps its accent bar and layers motion on top", () => {
  // The bar itself never moves: the motion selectors only add decoration.
  assert.match(
    styles,
    /\.composer-queued-prompt\[data-priority="true"\]\s*\{[^}]*inset 3px 0 0 0 var\(--ds-accent\)/s,
  );
  for (const variant of ["bubbles", "glow", "wave"]) {
    assert.match(styles, new RegExp(`\\[data-queue-animation="${variant}"\\]`));
  }
  assert.match(styles, /@keyframes queue-bubbles-rise/);
  assert.match(styles, /@keyframes queue-glow-sweep/);
  assert.match(styles, /@keyframes queue-wave-flow/);
});

test("queued prompt motion stays clipped to the promoted row", () => {
  const motionRowRule = styles.match(
    /\[data-queue-animation="bubbles"\][\s\S]*?\[data-queue-animation="wave"\][^{}]*\{[^}]*\}/,
  )?.[0] ?? "";
  assert.match(motionRowRule, /position:\s*relative;/);
  assert.match(motionRowRule, /overflow:\s*hidden;/);
});

test("the wave variant keeps the enlarged waterline amplitude", () => {
  assert.match(
    styles,
    /\[data-queue-animation="wave"\][\s\S]*?height:\s*12px;/,
  );
  assert.match(styles, /M0 6 Q 12 -2 24 6/);
});

test("queue row motion stands down under prefers-reduced-motion", () => {
  const guard = styles.slice(
    styles.indexOf("@media (prefers-reduced-motion: reduce) {"),
  );
  assert.match(guard, /\[data-queue-animation="bubbles"\][^{]*::after\s*\{[^}]*display:\s*none/s);
  assert.match(guard, /\[data-queue-animation="glow"\][^{]*::after\s*\{[^}]*display:\s*none/s);
  assert.match(guard, /\[data-queue-animation="wave"\][^{]*::after\s*\{[^}]*display:\s*none/s);
});

test("the animation row is searchable in the preferences nav", () => {
  assert.match(settingsSearchSource, /"settings\.queuedPromptAnimation"/);
  assert.match(settingsSearchSource, /"settings\.queuedPromptAnimationDesc"/);
  assert.match(settingsSearchSource, /"settings\.queuedPromptAnimationGlow"/);
  assert.match(settingsSearchSource, /"settings\.queuedPromptAnimationWave"/);
});

test("every shipped catalog carries the animation keys", () => {
  for (const source of [enLocaleSource, zhLocaleSource, deLocaleSource]) {
    assert.match(source, /queuedPromptAnimation"?:/);
    assert.match(source, /queuedPromptAnimationDesc"?:/);
    assert.match(source, /queuedPromptAnimationOff"?:/);
    assert.match(source, /queuedPromptAnimationBubbles"?:/);
    assert.match(source, /queuedPromptAnimationGlow"?:/);
    assert.match(source, /queuedPromptAnimationWave"?:/);
  }
});
