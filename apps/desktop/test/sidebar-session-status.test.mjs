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
  const styles = loadStylesSync();
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
  // The highlight is clipped to the glyph outlines, so the light travels
  // across the letterforms rather than across a box behind them.
  assert.match(
    styles,
    /\.thread-item\.running \.thread-item-title[\s\S]*background-clip: text[\s\S]*sidebar-title-sheen/,
  );
  assert.doesNotMatch(styles, /\.thread-item\.running \.thread-item-title::after/);
  // The title keeps the colour the row already gives it and a dim streak
  // travels over it. The base stops read `currentColor` so the streak rides
  // the row's real colour through hover and selection, and the travelling
  // band is the dimmer token — a bright band over a dim base darkened the
  // whole title just to light one slice of it.
  assert.match(
    styles,
    /linear-gradient\(\s*100deg,\s*currentColor 0%,\s*currentColor 45%,\s*var\(--ds-text-muted\) 50%,\s*currentColor 55%,\s*currentColor 100%\s*\)/,
  );
  assert.doesNotMatch(
    styles,
    /\.thread-item\.running \.thread-item-title \{[^}]*var\(--ds-text-primary\)/s,
  );
  // The glyph fill has to go transparent for the clipped background to show,
  // but `currentColor` resolves against `color`, so the fill is emptied
  // through `-webkit-text-fill-color` and `color` is left alone.
  assert.match(styles, /-webkit-text-fill-color: transparent;/);
  assert.doesNotMatch(
    styles,
    /\.thread-item\.running \.thread-item-title \{[^}]*(?<![\w-])color: transparent/s,
  );
  // The streak crosses left to right, the direction a reader enters a line,
  // so the keyframes drag the background rightward: 100% puts the band beyond
  // the left edge, 0% beyond the right one.
  assert.match(
    styles,
    /@keyframes sidebar-title-sheen \{[\s\S]*?background-position: 100% 0;[\s\S]*?background-position: 0% 0;/,
  );
  assert.match(
    styles,
    /background-size: 240% 100%;[\s\S]*?background-position: 100% 0;[\s\S]*?background-clip: text;/,
  );
  // A 2x gradient left the bright band straddling an edge at both ends of the
  // sweep, so every loop reset jumped the lit half of the title sideways —
  // the flicker. 2.4x carries the streak clear of the element at the turn,
  // and a linear timing keeps the speed constant instead of decelerating
  // into the dead end and snapping back.
  assert.match(styles, /animation: sidebar-title-sheen 2\.3s linear infinite;/);
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
