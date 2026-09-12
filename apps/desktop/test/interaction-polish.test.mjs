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
    ".work-panel-subagent-back",
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

test("scrollbars are transparent at rest and reveal on hover, focus, or scrolling", () => {
  assert.match(
    styles,
    /::-webkit-scrollbar\s*\{[\s\S]*?width:\s*6px;[\s\S]*?height:\s*6px;/,
  );
  // Rest state: the bare thumb rule paints nothing.
  assert.match(
    styles,
    /\n::-webkit-scrollbar-thumb\s*\{\s*background:\s*transparent;/,
  );
  // Revealed by the owning scroller's hover/focus state or scroll-reveal mark.
  assert.match(
    styles,
    /:hover::-webkit-scrollbar-thumb,\s*\n:focus-within::-webkit-scrollbar-thumb,\s*\n\[data-scrolling\]::-webkit-scrollbar-thumb\s*\{[^}]*color-mix\([^;]*16%/,
  );
  // Strengthens under the pointer and while dragged.
  assert.match(
    styles,
    /::-webkit-scrollbar-thumb:hover,\s*::-webkit-scrollbar-thumb:active\s*\{[^}]*color-mix\([^;]*28%/,
  );
});

test("no partial sets scrollbar-width or scrollbar-color (they disable the pseudo-elements)", () => {
  const declarations = styles.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(declarations, /scrollbar-width\s*:/);
  assert.doesNotMatch(declarations, /scrollbar-color\s*:/);
});

test("the renderer entry installs the scroll-reveal mark", async () => {
  const main = await readFile(new URL("../src/main.tsx", import.meta.url), "utf8");
  assert.match(main, /import \{ installScrollbarReveal \} from "\.\/lib\/scrollbar-reveal";/);
  assert.match(main, /installScrollbarReveal\(document\);/);
});

test("all renderer scrollbars share the compact reveal contract", () => {
  assert.doesNotMatch(styles, /\.sidebar-session-groups[^{}]*::-webkit-scrollbar/);
  assert.doesNotMatch(styles, /--sidebar-scrollbar-thumb-hover/);
  assert.match(styles, /:focus-within::-webkit-scrollbar-thumb/);
});
