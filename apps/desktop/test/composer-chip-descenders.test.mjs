import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

const composerSource = await readFile(
  new URL("../src/components/Composer.tsx", import.meta.url),
  "utf8",
);
const styles = await loadStyles();

function ruleBlock(source, selector) {
  const start = source.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `missing ${selector} rule`);
  // Prefer the layout rule (height: 28px) when color-only overrides exist first.
  let idx = start;
  while (idx !== -1) {
    const open = source.indexOf("{", idx);
    const close = source.indexOf("}", open);
    const block = source.slice(idx, close + 1);
    if (block.includes("height: 28px")) return block;
    idx = source.indexOf(`${selector} {`, close + 1);
  }
  throw new Error(`no 28px layout rule for ${selector}`);
}

test("model chip label avoids leading-none under truncation", () => {
  assert.match(composerSource, /className="composer-model-thinking-model"/);
  assert.doesNotMatch(
    composerSource,
    /composer-model-thinking-model[^"]*leading-none|truncate text-sm leading-none/,
  );
});

test("model menu options show one complete display name on hover", () => {
  assert.match(
    composerSource,
    /const optionTitle =\s*model\.displayName \|\| model\.modelId;/,
  );
  assert.match(composerSource, /title=\{optionTitle\}/);
  const optionBlock =
    composerSource.match(/const optionTitle[\s\S]*?<\/button>/)?.[0] ?? "";
  assert.doesNotMatch(optionBlock, /max-w-\[170px\]|font-mono text-text-secondary/);
});

test("composer runtime chips keep compact line-height for descenders", () => {
  for (const selector of [".mode-chip"]) {
    const block = ruleBlock(styles, selector);
    assert.match(block, /line-height:\s*var\(--leading-compact\);/);
    assert.match(block, /overflow:\s*visible;/);
  }

  assert.match(
    styles,
    /\.composer-model-thinking-chip\s*\{[\s\S]*?line-height:\s*var\(--leading-compact\);/,
  );
  assert.match(
    styles,
    /\.composer-model-thinking-model,\s*\.composer-model-thinking-level\s*\{[\s\S]*?text-overflow:\s*ellipsis;/,
  );
});

test("mode selector reserves the longest localized label width", () => {
  assert.match(
    composerSource,
    /className="icon-btn mode-chip composer-mode-chip"/,
  );

  const block = styles.match(/\.composer-mode-chip\s*\{[^}]+\}/)?.[0] ?? "";
  assert.match(block, /width:\s*88px;/);
  assert.match(block, /min-width:\s*88px;/);
  assert.match(block, /max-width:\s*88px;/);
  assert.match(block, /flex:\s*0 0 88px;/);
  assert.match(styles, /\.composer-mode-chip-label\s*\{[\s\S]*?text-overflow:\s*ellipsis;/);
});

test("mode chip cross-fades on switch and pulses while planning is live", () => {
  assert.match(composerSource, /data-planning=\{planningLive \? "true" : undefined\}/);
  assert.match(composerSource, /className="composer-mode-chip-face"/);
  assert.match(
    composerSource,
    /const planningLive =\s*isRunning &&\s*planningState === "planning" &&\s*\(mode === "plan" \|\| mode === "goal"\)/,
  );
  assert.match(
    styles,
    /\.composer-mode-chip-face\s*\{[\s\S]*?animation:\s*composer-mode-face-in/,
  );
  assert.match(
    styles,
    /\.composer-mode-chip\[data-planning="true"\] svg\s*\{[\s\S]*?animation:\s*composer-mode-planning-pulse/,
  );
  assert.match(
    styles,
    /prefers-reduced-motion:\s*reduce[\s\S]*?\.composer-mode-chip-face,/,
  );
});
