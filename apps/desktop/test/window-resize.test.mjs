import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const mainSource = await readFile(
  new URL("../electron/main/index.ts", import.meta.url),
  "utf8",
);

const reservationHandler = mainSource.slice(
  mainSource.indexOf("IPC.invoke.windowSetWorkPanelReservation"),
  mainSource.indexOf("IPC.invoke.windowSetWorkPanelChatWidth"),
);

test("the main window keeps native edge and corner resizing enabled", () => {
  assert.match(mainSource, /resizable:\s*true/);
  assert.match(mainSource, /minWidth:\s*WINDOW_MIN_WIDTH/);
  assert.match(mainSource, /minHeight:\s*WINDOW_MIN_HEIGHT/);
});

test("bounds recovery waits for a stable native resize snapshot", () => {
  assert.match(mainSource, /const WINDOW_BOUNDS_SETTLE_MS = 300/);
  assert.match(mainSource, /const scheduledBounds = window\.getBounds\(\)/);
  assert.match(
    mainSource,
    /if \(!windowBoundsEqual\(window\.getBounds\(\), scheduledBounds\)\)/,
  );
  assert.match(mainSource, /scheduleBoundsCheck\(\)/);
});

test("work-panel reservation mirrors the requested committed width", () => {
  assert.match(reservationHandler, /parseWorkPanelReservationWidth/);
  assert.match(reservationHandler, /requestedWorkPanelReservation = requested/);
  assert.match(reservationHandler, /applyWorkPanelReservation/);
  assert.match(reservationHandler, /return \{ requested, reserved: reservation\.width \}/);
});

test("native right-edge resize participates in the shared panel budget", () => {
  assert.match(mainSource, /window\.on\("will-resize"/);
  assert.match(mainSource, /window\.on\("resized"/);
  assert.match(mainSource, /isWorkPanelOuterResizeEdge/);
  assert.match(mainSource, /sendWorkPanelResize\("preview", panelWidth\)/);
  assert.match(mainSource, /sendWorkPanelResize\("commit", panelWidth\)/);
});

test("native bounds timers are cleaned up with the window", () => {
  assert.match(
    mainSource,
    /window\.on\("closed", \(\) => \{[\s\S]*?clearTimeout\(boundsTimer\)[\s\S]*?clearTimeout\(saveTimer\)/,
  );
});
