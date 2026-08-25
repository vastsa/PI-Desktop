import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

const styles = await loadStyles();

test("high-traffic chrome uses shared motion tokens on hover fills", () => {
  for (const selector of [
    ".jump-latest-btn",
    ".stop-btn",
    ".composer-plus-item",
    ".search-item",
    ".footer-action",
    ".notification-item",
    ".work-panel-current-close",
  ]) {
    // Match the selector anywhere in a rule's selector list, and require the
    // transition inside that rule's own body — a shared list is as valid as a
    // standalone block.
    const re = new RegExp(
      `${selector.replace(/\./g, "\\.")}[^{}]*\\{[^}]*transition:[^;]*var\\(--motion-duration-fast\\)`,
    );
    assert.match(styles, re, `${selector} should transition with motion tokens`);
  }
});

test("empty-home stack gap stays within the 24px workstation ceiling", () => {
  const block = styles.match(/\.home-stack-inner\s*\{[^}]+\}/)?.[0] ?? "";
  assert.match(block, /gap:\s*(?:1[0-9]px|2[0-4]px)/);
  assert.doesNotMatch(block, /gap:\s*2[5-9]px|gap:\s*[3-9]\dpx/);
});

test("scrollbars expose a hover-strengthened thumb", () => {
  assert.match(styles, /::-webkit-scrollbar-thumb:hover/);
  assert.match(
    styles,
    /::-webkit-scrollbar\s*\{[\s\S]*?width:\s*8px;[\s\S]*?height:\s*8px;/,
  );
});

test("sidebar scrollbars stay hidden until hover or focus", () => {
  assert.match(
    styles,
    /\.sidebar-session-groups,\s*\.sidebar-session-group-body\.standalone\s*\{[\s\S]*?scrollbar-color:\s*transparent transparent;/,
  );
  assert.match(
    styles,
    /\.sidebar-session-groups::-webkit-scrollbar\s*,[\s\S]*?\.sidebar-session-group-body\.standalone::-webkit-scrollbar\s*\{[\s\S]*?width:\s*6px;[\s\S]*?height:\s*6px;/,
  );
  assert.match(styles, /--sidebar-scrollbar-thumb-hover: color-mix\([^;]*20%/);
  assert.match(
    styles,
    /\.sidebar-session-groups:hover,\s*\.sidebar-session-groups:focus-within,[\s\S]*?scrollbar-color:\s*var\(--sidebar-scrollbar-thumb-hover\) transparent;/,
  );
  assert.match(
    styles,
    /\.sidebar-session-groups:hover::-webkit-scrollbar-thumb,[\s\S]*?background:\s*var\(--sidebar-scrollbar-thumb-hover\);/,
  );
});
