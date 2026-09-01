import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

const sidebarSource = await readFile(
  new URL("../src/components/Sidebar.tsx", import.meta.url),
  "utf8",
);
const appSource = await readFile(
  new URL("../src/App.tsx", import.meta.url),
  "utf8",
);
const globalStyles = await loadStyles();

test("the sidebar exposes an accessible pointer and keyboard resize handle", () => {
  assert.match(sidebarSource, /className=\{cx\("sidebar-resize-handle no-drag"/);
  assert.match(sidebarSource, /role="separator"/);
  assert.match(sidebarSource, /aria-orientation="vertical"/);
  assert.match(sidebarSource, /onPointerDown=\{startSidebarResize\}/);
  assert.match(sidebarSource, /onPointerMove=\{moveSidebarResize\}/);
  assert.match(sidebarSource, /onPointerCancel=\{cancelSidebarResize\}/);
  assert.match(sidebarSource, /onLostPointerCapture=\{cancelSidebarResize\}/);
  assert.match(sidebarSource, /requestAnimationFrame\(\(\) =>/);
  assert.match(sidebarSource, /event\.key === "ArrowRight"/);
  assert.match(sidebarSource, /event\.key === "Home"/);
  assert.match(sidebarSource, /finishSidebarResize\(true\)/);
});

test("sidebar width is shell-owned and the resize affordance is edge-anchored", () => {
  assert.match(appSource, /loadSidebarWidth\(\)/);
  assert.match(appSource, /saveSidebarWidth\(nextWidth\)/);
  assert.match(appSource, /"--ds-sidebar-width": `\$\{sidebarWidth\}px`/);
  assert.match(globalStyles, /\.sidebar\s*\{[\s\S]*?position:\s*relative/);
  assert.match(globalStyles, /\.sidebar-resize-handle\s*\{[\s\S]*?right:\s*0;[\s\S]*?cursor:\s*col-resize/);
  assert.match(globalStyles, /\.sidebar-resize-handle\s*\{[\s\S]*?touch-action:\s*none/);
});

test("sidebar hover does not paint a full-height resize rail", () => {
  const marker = globalStyles.match(
    /\.sidebar-resize-handle::after\s*\{[^}]+\}/s,
  )?.[0] ?? "";

  assert.match(marker, /top:\s*50%/);
  assert.match(marker, /height:\s*32px/);
  assert.match(marker, /border-radius:\s*var\(--radius-full\)/);
  assert.match(globalStyles, /\.sidebar-resize-handle:hover::after,/);
  assert.doesNotMatch(globalStyles, /\.sidebar:hover\s+\.sidebar-resize-handle::after/);
  assert.match(
    globalStyles,
    /\.sidebar-resize-handle:focus-visible\s*\{[^}]*outline:\s*none/s,
  );
});
