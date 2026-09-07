import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

const styles = await loadStyles();

test("work panel uses a quiet light-theme inset surface", () => {
  assert.match(
    styles,
    /:root\[data-theme="light"\]\s+\.work-panel\s*\{[\s\S]*?background:\s*#fafafa/,
  );
  assert.match(
    styles,
    /:root\[data-theme="light"\]\s+\.work-panel-header\s*\{[\s\S]*?background:\s*#ffffff/,
  );
  assert.match(
    styles,
    /\.work-panel-context\s*\{[\s\S]*?display:\s*flex/,
  );
  assert.match(
    styles,
    /\.work-panel-menu-row\.active::before\s*\{[\s\S]*?background:\s*var\(--ds-text-primary\)/,
  );
});

test("work panel interactive rows ease hover fills with motion tokens", () => {
  for (const selector of [
    ".file-tree-row",
    ".review-change-card-header",
    ".work-panel-resize",
    ".work-browser-url input",
  ]) {
    const re = new RegExp(
      `${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{[\\s\\S]*?transition:[\\s\\S]*?var\\(--motion-duration-fast\\)`,
    );
    assert.match(styles, re, `${selector} should transition with motion tokens`);
  }
});

test("button press feedback eases transform instead of snapping", () => {
  for (const selector of [
    ".btn",
    ".icon-btn",
    ".title-nav-btn",
    ".nav-item",
    ".copy-btn",
    ".sidebar-toolbar-button",
    ".sidebar-session-group-add",
  ]) {
    const escaped = selector.replace(".", "\\.");
    const re = new RegExp(
      `${escaped}\\s*\\{[\\s\\S]*?transform var\\(--motion-duration-fast\\)`,
    );
    assert.match(styles, re, `${selector} should ease pressed feedback`);
  }
  assert.match(styles, /\.btn:active:not\(:disabled\)\s*\{[\s\S]*?scale\(0\.98\)/);
  assert.match(styles, /\.send-btn:active:not\(:disabled\)[\s\S]*?scale\(0\.94\)/);
  assert.match(styles, /\.stop-btn:active:not\(:disabled\)[\s\S]*?scale\(0\.94\)/);
});

test("settings and form controls gain light-theme surfaces", () => {
  // D297: fields are filled wells from the shared tile tokens in both themes,
  // with no per-theme hex override and no stroke; focus lifts them onto the
  // raised layer behind an accent ring.
  const field = styles.match(/\.field-input,\n\.field-select,\n\.field-textarea\s*\{[^}]*\}/)?.[0] ?? "";
  assert.match(field, /border:\s*0/);
  assert.match(field, /background:\s*var\(--ds-tile-hover\)/);
  assert.doesNotMatch(styles, /:root\[data-theme="light"\]\s+\.field-input/);
  assert.match(
    styles,
    /\.field-input:focus,\n\.field-select:focus,\n\.field-textarea:focus\s*\{[^}]*background:\s*var\(--ds-raised\)[^}]*box-shadow:\s*0 0 0 2px/,
  );
  assert.match(
    styles,
    /:root\[data-theme="light"\]\s+\.settings-toggle\.on\s+\.settings-toggle-thumb\s*\{[\s\S]*?background:\s*#ffffff/,
  );
  // D297: the segment track and keycaps come from the shared tile/raised
  // tokens, so they need no per-theme override and carry no stroke.
  assert.doesNotMatch(styles, /:root\[data-theme="light"\]\s+\.settings-segment\s*\{/);
  assert.match(styles, /\.settings-segment\s*\{[^}]*border-radius:\s*var\(--radius-full\)[^}]*background:\s*color-mix/);
  assert.doesNotMatch(styles, /\.settings-segment\s*\{[^}]*box-shadow/);
  assert.match(
    styles,
    /\.settings-segment-item\.active\s*\{[^}]*background:\s*var\(--ds-raised\)[^}]*box-shadow:\s*var\(--ds-raised-shadow\)/,
  );
  assert.doesNotMatch(styles, /:root\[data-theme="light"\]\s+\.shortcut-keybinding\s+kbd/);
  assert.match(
    styles,
    /\.shortcut-keybinding kbd\s*\{[^}]*background:\s*var\(--ds-raised\)[^}]*box-shadow:\s*var\(--ds-raised-shadow\)/,
  );
  assert.doesNotMatch(styles, /\.shortcut-keybinding kbd\s*\{[^}]*border:/);
  assert.match(
    styles,
    /:root\[data-theme="light"\]\s+\.overlay\s*\{[\s\S]*?background:\s*color-mix\(in oklab,\s*#1a1c1f 28%/,
  );
});

test("switch on-track outranks the per-theme off-track", () => {
  /*
    A `:root[data-theme="light"] .settings-toggle` background declaration scores
    (0,3,0) and out-specifies `.settings-toggle.on` at (0,2,0), which strands the
    light theme on the pale off fill so only the knob slides. Off-track colours
    therefore live in the theme token blocks, not on this selector.
  */
  assert.doesNotMatch(
    styles,
    /:root\[data-theme="(light|dark)"\]\s+\.settings-toggle\s*\{[^}]*background:/,
  );
  assert.match(
    styles,
    /\.settings-toggle\s*\{[^}]*background:\s*var\(--ds-switch-track-off\)/,
  );
  assert.match(
    styles,
    /\.settings-toggle\.on\s*\{[^}]*background:\s*var\(--ds-accent\)/,
  );
  // D297: the off track is a fill alone; no inset ring on either state. Focus
  // is the only ring, and it sits outside the track.
  assert.doesNotMatch(styles, /\.settings-toggle(\.on)?\s*\{[^}]*inset 0 0 0 1px/);
  assert.match(
    styles,
    /\.settings-toggle:focus-visible,\n\.settings-toggle\.on:focus-visible\s*\{[^}]*box-shadow:\s*0 0 0 2px/,
  );
  // Both themes must define the switch tokens, or one falls back to nothing.
  for (const token of [
    "--ds-switch-track-off",
    "--ds-switch-track-off-hover",
    "--ds-switch-knob-off",
    "--ds-switch-knob-on",
  ]) {
    const defs = styles.match(new RegExp(`^\\s*${token}:`, "gm")) ?? [];
    assert.equal(defs.length, 2, `${token} should be defined in both themes`);
  }
});
