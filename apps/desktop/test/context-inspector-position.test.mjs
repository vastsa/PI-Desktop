import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { CONTEXT_INSPECTOR_MARGIN, placeContextInspector } = await import(
  "../src/lib/context-inspector-position.ts"
);

const inspectorSource = await readFile(
  new URL("../src/components/ContextUsageInspector.tsx", import.meta.url),
  "utf8",
);
const chatShellStyles = await readFile(
  new URL("../src/styles/chat-shell.css", import.meta.url),
  "utf8",
);

const VIEWPORT = { width: 1440, height: 900 };
/** Sidebar 276px, then the conversation pane; the work panel starts at 1120. */
const PANE = { left: 276, right: 1120 };
const POPOVER = { width: 376, height: 220 };

const place = (trigger, pane = PANE, popover = POPOVER) =>
  placeContextInspector({ trigger, popover, pane, viewport: VIEWPORT });
const placedWidth = (placement) =>
  Math.min(POPOVER.width, placement.maxWidth);

test("the popover never crosses the pane edge into the work panel", () => {
  // Trigger parked against the pane's right edge, which is where it sits while
  // the work panel is open: the popover must not reach the panel's column, or
  // the panel's native browser/plugin surface would paint over it.
  const placement = place({ left: 1080, top: 700, bottom: 728 });
  assert.ok(placement);
  assert.ok(
    placement.left + placedWidth(placement) <=
      PANE.right - CONTEXT_INSPECTOR_MARGIN,
    "the popover must end inside the conversation pane",
  );
});

test("a pane narrower than the popover caps the popover instead of overflowing", () => {
  // The work panel at its 720px ceiling leaves a 320px pane.
  const narrow = { left: 0, right: 320 };
  const placement = place({ left: 300, top: 700, bottom: 728 }, narrow);
  assert.ok(placement);
  assert.equal(placement.maxWidth, 320 - CONTEXT_INSPECTOR_MARGIN * 2);
  assert.equal(placement.left, CONTEXT_INSPECTOR_MARGIN);
  assert.ok(
    placement.left + placement.maxWidth <=
      narrow.right - CONTEXT_INSPECTOR_MARGIN,
  );
});

test("a trigger that already fits keeps its own left edge", () => {
  const placement = place({ left: 600, top: 700, bottom: 728 });
  assert.ok(placement);
  assert.equal(placement.left, 600);
  assert.equal(placement.maxWidth, PANE.right - PANE.left - 32);
});

test("the popover clamps to the pane's left edge, not the window's", () => {
  const placement = place({ left: 4, top: 700, bottom: 728 });
  assert.ok(placement);
  assert.equal(placement.left, PANE.left + CONTEXT_INSPECTOR_MARGIN);
});

test("the popover opens above the trigger and falls back below it", () => {
  const above = place({ left: 600, top: 700, bottom: 728 });
  assert.equal(above.top, 700 - POPOVER.height - 8);

  const below = place({ left: 600, top: 100, bottom: 128 });
  assert.equal(below.top, 128 + 8);
});

test("a pane with no usable width leaves the popover unplaced", () => {
  assert.equal(
    place({ left: 10, top: 700, bottom: 728 }, { left: 0, right: 20 }),
    null,
  );
});

test("a missing pane falls back to the viewport", () => {
  const placement = place({ left: 1400, top: 700, bottom: 728 }, null);
  assert.ok(placement);
  assert.ok(
    placement.left + placedWidth(placement) <=
      VIEWPORT.width - CONTEXT_INSPECTOR_MARGIN,
  );
});

test("the inspector clamps against the conversation pane, not the viewport", () => {
  assert.match(inspectorSource, /trigger\.closest\("\.main-pane"\)/);
  assert.match(inspectorSource, /placeContextInspector\(\{/);
  assert.doesNotMatch(
    inspectorSource,
    /window\.innerWidth - popoverRect\.width/,
    "the horizontal clamp must come from the pane, not the viewport",
  );
  // The landmark the clamp queries has to stay declared by the shell stylesheet.
  assert.match(chatShellStyles, /\.main-pane\s*\{/);
});

test("the inspector re-places the popover when the pane geometry changes", () => {
  // #246: sidebar toggle/resize, work-panel open/resize, and the panel's
  // entrance animation all move the pane's right edge without emitting a
  // window resize or a scroll event, so a stale clamp can leave part of the
  // popover under the panel's native surfaces. A ResizeObserver on the
  // conversation pane is the only signal that fires for those changes.
  assert.match(
    inspectorSource,
    /closest\("\.main-pane"\)[\s\S]{0,200}new ResizeObserver\(updatePopoverPosition\)/,
    "an open popover must observe the pane so geometry changes re-run placement",
  );
});
