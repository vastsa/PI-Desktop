import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

const globalStyles = await loadStyles();

test("settings content follows the available window width", () => {
  assert.match(
    globalStyles,
    /\.settings-content\s*\{[^}]*min-width:\s*0;[^}]*flex:\s*1;/s,
  );
  assert.match(
    globalStyles,
    /\.settings-content-inner\s*\{[^}]*width:\s*100%;/s,
  );
  assert.doesNotMatch(
    globalStyles,
    /\.settings-content-inner\s*\{[^}]*width:\s*min\(\s*100%\s*,\s*720px\s*\);/s,
  );
});

test("settings row segments size to content and wrap whole options instead of labels", () => {
  assert.match(
    globalStyles,
    /\.settings-row:has\(> \.settings-row-control > \.settings-segment\)\s*\{[^}]*flex-wrap:\s*wrap;/s,
  );
  assert.match(
    globalStyles,
    /\.settings-row:has\(> \.settings-row-control > \.settings-segment\) > \.settings-row-copy\s*\{[^}]*flex-basis:\s*max-content;/s,
  );
  assert.match(
    globalStyles,
    /\.settings-row-control:has\(> \.settings-segment\)\s*\{[^}]*max-width:\s*100%;/s,
  );
  assert.match(
    globalStyles,
    /\.settings-row-control > \.settings-segment\s*\{[^}]*width:\s*max-content;[^}]*max-width:\s*100%;[^}]*flex-wrap:\s*wrap;/s,
  );
  assert.match(
    globalStyles,
    /\.settings-row-control > \.settings-segment > \.settings-segment-item\s*\{[^}]*flex:\s*0 0 auto;[^}]*white-space:\s*nowrap;/s,
  );
});
