import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

const globalStyles = await loadStyles();

test("shell chrome is not text-selectable by default", () => {
  assert.match(
    globalStyles,
    /html,\s*body,\s*#root\s*\{[^}]*-webkit-user-select:\s*none;[^}]*user-select:\s*none;/s,
  );
  assert.match(
    globalStyles,
    /button,\s*\[role="button"\][^}]*\{[^}]*-webkit-user-select:\s*none;[^}]*user-select:\s*none;/s,
  );
});

test("editing and document-like content explicitly remains selectable", () => {
  assert.match(
    globalStyles,
    /input,\s*textarea,\s*select,\s*\[contenteditable\][\s\S]*?-webkit-user-select:\s*text;[\s\S]*?user-select:\s*text;/,
  );
  assert.match(
    globalStyles,
    /\.message-bubble[\s\S]*?\.message-user-text[\s\S]*?\.prose-chat[\s\S]*?\.tool-row-content[\s\S]*?pre[\s\S]*?code[\s\S]*?-webkit-user-select:\s*text;[\s\S]*?user-select:\s*text;/,
  );
});

test("copyable surfaces use theme-aware selection and caret colors", () => {
  assert.match(
    globalStyles,
    /::selection\s*\{[\s\S]*?background:\s*color-mix\(in oklab, var\(--ds-text-primary\) 18%, transparent\)/,
  );
  assert.match(
    globalStyles,
    /html\s*\{[\s\S]*?caret-color:\s*var\(--ds-text-primary\);[\s\S]*?accent-color:\s*var\(--ds-accent\);/,
  );
  assert.match(
    globalStyles,
    /:focus-visible\s*\{[\s\S]*?outline:\s*1\.5px solid color-mix\(in oklab, var\(--ds-accent\) 80%, transparent\)/,
  );
});

test("CJK section labels drop Latin-only uppercase tracking", () => {
  assert.match(
    globalStyles,
    /:lang\(zh-CN\) \.sidebar-list-label[\s\S]*?letter-spacing:\s*var\(--tracking-normal\);[\s\S]*?text-transform:\s*none;/,
  );
});

test("brand hover chip uses a defined radius token", () => {
  assert.doesNotMatch(globalStyles, /--radius-token-row/);
  assert.match(
    globalStyles,
    /\.brand\s*\{[\s\S]*?border-radius:\s*var\(--radius-sm\);/,
  );
});
