import {
  readStoreModuleSync,
  readMainSourceSync,
} from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  latestSessionOutcomes,
  sidebarSessionStatus,
} from "../src/lib/sidebar-session-status.ts";
import { loadStylesSync } from "./helpers/styles.mjs";

function notification(overrides) {
  return {
    id: "notification-1",
    kind: "task.completed",
    sessionId: "session-1",
    sessionTitle: "Session",
    turnId: "turn-1",
    createdAt: "2026-07-27T10:00:00.000Z",
    readAt: null,
    ...overrides,
  };
}

test("keeps the newest unread completed or failed outcome for each session", () => {
  const outcomes = latestSessionOutcomes([
    notification({ id: "latest", kind: "task.completed" }),
    notification({ id: "older", kind: "task.failed" }),
    notification({
      id: "other",
      kind: "task.failed",
      sessionId: "session-2",
    }),
  ]);

  assert.deepEqual(outcomes, {
    "session-1": "completed",
    "session-2": "failed",
  });
});

test("read task notifications leave no sidebar indicator", () => {
  const outcomes = latestSessionOutcomes([
    notification({ id: "latest", readAt: "2026-07-27T10:05:00.000Z" }),
    notification({ id: "older", kind: "task.failed" }),
  ]);

  assert.deepEqual(outcomes, {});
});

test("keeps only the indicators a row still paints", () => {
  // A running row says so by sheening its title, and the selected row by its
  // own background, so neither takes the dot the other three share.
  assert.equal(sidebarSessionStatus({ outcome: "failed" }), "failed");
  assert.equal(sidebarSessionStatus({ outcome: "completed" }), "completed");
  assert.equal(
    sidebarSessionStatus({ outcome: "completed", hasPendingPermission: true }),
    "permission",
  );
  assert.equal(sidebarSessionStatus({}), null);
});

test("opening a conversation acknowledges its outcome badge before loading details", () => {
  const sessionSource = readStoreModuleSync("slices/session-slice.ts");
  const catalogSource = readStoreModuleSync("slices/catalog-slice.ts");
  const selectBlock = sessionSource.match(/selectSession: async[\s\S]*?\n    newSession:/)?.[0] ?? "";
  const acknowledgementStart = selectBlock.indexOf(
    "const outcomeAcknowledgement = get().acknowledgeSessionOutcome(id);",
  );
  const detailLoadStart = selectBlock.indexOf(
    "const detailPromise = runtime.loadSessionDetail(id",
  );
  assert.ok(acknowledgementStart >= 0);
  assert.ok(detailLoadStart >= 0);
  assert.ok(
    acknowledgementStart < detailLoadStart,
    "session outcome acknowledgement must start before detail loading",
  );
  assert.match(selectBlock, /await outcomeAcknowledgement/);

  const ackBlock = catalogSource.slice(
    catalogSource.indexOf("acknowledgeSessionOutcome: async"),
  );
  assert.match(ackBlock, /withoutRecordKey\(state\.sessionOutcomes, sessionId\)/);
  assert.match(ackBlock, /markNotificationRead\(item\.id\)/);
});

test("renders semantic, shape-distinct sidebar status indicators", () => {
  const sidebar = fs.readFileSync(
    new URL("../src/components/Sidebar.tsx", import.meta.url),
    "utf8",
  );
  // Assertions run against the sheet with comments stripped. These rules
  // explain *why* a property is not used, and a `[^}]*` pattern happily walks
  // straight out of a comment and into the next declaration it was warning
  // against — a false failure whose only fix is rewording the comment.
  const styles = loadStylesSync().replace(/\/\*[\s\S]*?\*\//g, "");
  // The status fixture lives in the capture rig, which App only loads lazily
  // behind __PI_CAPTURE__.
  const app = fs.readFileSync(
    new URL("../src/capture/capture-rig.ts", import.meta.url),
    "utf8",
  );
  const main = readMainSourceSync();

  assert.match(
    sidebar,
    /sessionCompleted[\s\S]*sessionFailed[\s\S]*sessionPermission/,
  );
  assert.doesNotMatch(sidebar, /"nav\.sessionRunning"|"nav\.sessionSelected"/);
  assert.match(sidebar, /IconCheck[\s\S]*IconCircleAlert/);
  // The run is a sheen travelling across the title, and the selected row is
  // the row background — neither paints a `.thread-item-status` dot.
  assert.match(sidebar, /\$\{running \? "running" : ""\}/);
  // The highlight is clipped to the glyph outlines, so the pass travels
  // across the letterforms rather than across a box behind them. The sheet
  // owns the gradient and the clipping only — the animation name lives in the
  // hook, because the timing needs the measured width.
  assert.match(
    styles,
    /\.thread-item\.running \.thread-item-title[\s\S]*background-clip: text[\s\S]*-webkit-text-fill-color: transparent;/,
  );
  assert.doesNotMatch(styles, /\.thread-item\.running \.thread-item-title::after/);
  assert.doesNotMatch(styles, /sidebar-title-sheen/);
  // The title keeps the colour the row already gives it and a dim band
  // travels over it. The base stops read `currentColor` so the band rides
  // the row's real colour through hover and selection.
  //
  // Every stop is a length, not a share of the row: a percentage band and a
  // percentage travel both scale with the title, so a three-word session and
  // a thirty-word one would show visibly different thicknesses and speeds.
  // `--sheen-band` is the absolute width, and the box is sized from the
  // measured `--sheen-width` rather than from a percentage.
  //
  // The peak is a single stop. Two dim stops at `50% ± band/2` would hold the
  // full dip across the band's whole width, which reads as a block sitting on
  // the row instead of light passing over it.
  //
  // The dip is mixed from `currentColor`, not from `--ds-text-muted`: that
  // token is translucent white in dark and an opaque `#5d5d5d` in light, so a
  // band built from it is invisible against light-theme text.
  assert.match(
    styles,
    /linear-gradient\(\s*100deg,\s*currentColor 0,\s*currentColor calc\(50% - var\(--sheen-band\) \/ 2\),\s*color-mix\(in oklab, currentColor 45%, transparent\) 50%,\s*currentColor calc\(50% \+ var\(--sheen-band\) \/ 2\),\s*currentColor 100%\s*\)/,
  );
  assert.doesNotMatch(
    styles,
    /\.thread-item\.running \.thread-item-title \{[^}]*var\(--ds-text-primary\)/s,
  );
  // The band crosses left to right, the direction a reader enters a line, and
  // the resting stop sits a full band-width left of the text so a pass begins
  // off-screen rather than already washing the first glyphs.
  assert.match(
    styles,
    /background-size: calc\(2 \* var\(--sheen-width\) \+ var\(--sheen-band\)\) 100%;[\s\S]*?background-position: calc\(-1 \* \(var\(--sheen-width\) \+ var\(--sheen-band\)\)\) 0;[\s\S]*?background-clip: text;/,
  );
  // The glyph fill has to go transparent for the clipped background to show,
  // but `currentColor` resolves against `color`, so the fill is emptied
  // through `-webkit-text-fill-color` and `color` is left alone.
  assert.match(styles, /-webkit-text-fill-color: transparent;/);
  assert.doesNotMatch(
    styles,
    /\.thread-item\.running \.thread-item-title \{[^}]*(?<![\w-])color: transparent/s,
  );
  // The animation is the hook's, not the stylesheet's. The band has to travel
  // `width + band` pixels and then rest a fixed second, and a stylesheet can
  // express neither: the duration depends on a measurement it does not have,
  // and the keyframe split — which would have to move with the title length to
  // keep that rest at one second — cannot be a `var()` at all, because `var()`
  // is not a valid keyframe selector and the frame is silently dropped.
  assert.doesNotMatch(styles, /@keyframes sidebar-title-sheen/);
  assert.doesNotMatch(
    styles,
    /\.thread-item\.running \.thread-item-title \{[^}]*animation:/s,
  );
  assert.doesNotMatch(styles, /background-size: 240%/);
  assert.doesNotMatch(styles, /thread-item-status\.(running|selected)/);
  assert.match(styles, /thread-item-status\.permission::before[\s\S]*--ds-purple/);
  assert.match(styles, /thread-item-status\.completed[\s\S]*--ds-success/);
  assert.match(styles, /thread-item-status\.failed[\s\S]*--ds-error/);
  assert.match(
    styles,
    /prefers-reduced-motion: reduce[\s\S]*\.thread-item\.running \.thread-item-title[\s\S]*animation: none/,
  );
  assert.match(
    app,
    /seedSidebarStatuses[\s\S]*runningSessions[\s\S]*sessionOutcomes/,
  );
  assert.match(
    main,
    /PI_DESKTOP_CAPTURE_STATUS_ONLY[\s\S]*prefers-reduced-motion[\s\S]*SIDEBAR_STATUS_PROBE[\s\S]*pi-sidebar-status-/,
  );
});

test("the running sheen is sized from each row's measured title, not a share of it", () => {
  const hook = fs.readFileSync(
    new URL("../src/hooks/use-running-title-sheen.ts", import.meta.url),
    "utf8",
  );
  const sidebar = fs.readFileSync(
    new URL("../src/components/Sidebar.tsx", import.meta.url),
    "utf8",
  );
  const styles = loadStylesSync().replace(/\/\*[\s\S]*?\*\//g, "");

  // The hook is the reason the sweep can be one thickness and one speed on
  // every row: CSS resolves `animation-duration` before layout and `calc()`
  // cannot read an element's own width, so the travel — which has to be
  // `width + band` to clear both edges — is only knowable from a measurement.
  assert.match(hook, /getBoundingClientRect\(\)\.width/);
  assert.match(hook, /setProperty\("--sheen-width"/);
  // Only running rows carry the sheen, so only they are measured and stamped;
  // an idle row must never get a geometry the animation could pick up.
  assert.match(hook, /\.thread-item\.running \.thread-item-title/);
  // A resize is not a re-render: the sidebar is drag-resizable, and a title
  // whose text changes is not a React update the observer would otherwise see.
  assert.match(hook, /new ResizeObserver\(/);
  // Measured before paint, so no row is ever painted with the placeholder.
  assert.match(hook, /useLayoutEffect/);
  // Leaving a stale width behind would let a row that stopped running keep the
  // sweep's geometry if it starts again before the next measurement.
  assert.match(hook, /removeProperty\("--sheen-width"\)/);

  // The band is written to CSS as well as used here, so the two cannot drift.
  assert.match(hook, /setProperty\("--sheen-band"/);

  // One pixel rate and one rest, for every title length. The offsets are
  // computed rather than fixed percentages precisely so the rest is the same
  // second on a three-word row and a thirty-word one alike.
  assert.match(hook, /const SPEED = 80;/);
  assert.match(hook, /const PAUSE = 0\.33;/);
  assert.match(hook, /const travel = width \+ BAND;/);
  assert.match(hook, /const cycleMs = passMs \+ PAUSE \* 1000;/);
  assert.match(hook, /offset: passMs \/ cycleMs/);
  assert.match(hook, /iterations: Infinity/);
  assert.match(hook, /easing: "linear"/);
  // A title changing mid-run is ordinary, so the pass continues from where it
  // was instead of snapping back to the left edge.
  assert.match(hook, /animation\.currentTime = \(elapsed \/ previous\.cycleMs\) \* cycleMs;/);
  // Reduced motion is a live preference, not just a load-time one.
  assert.match(hook, /prefers-reduced-motion: reduce/);
  assert.match(hook, /reduceMotion\.addEventListener\("change"/);
  assert.match(hook, /animation\.cancel\(\)/);

  // Wired to the list that holds the rows, and to the running set so the
  // observed elements are rebuilt when rows start or stop running.
  assert.match(sidebar, /useRunningTitleSheen\(sessionGroupsRef, runningSessionIds\)/);
  assert.match(sidebar, /ref=\{sessionGroupsRef\}/);
  assert.match(sidebar, /Object\.keys\(runningSessions\)\.filter/);

  // The band the hook writes has to match the one the sheet falls back to, or
  // a row would jump to a different thickness on its first frame.
  const band = hook.match(/const BAND = (\d+);/)?.[1];
  const fallback = styles.match(/--sheen-band: (\d+)px;/)?.[1];
  assert.ok(band, "hook declares a band width");
  assert.equal(fallback, band, "stylesheet fallback band matches the hook");
});
