import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const mainSource = await readFile(
  new URL("../electron/main/index.ts", import.meta.url),
  "utf8",
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

test("programmatic panel reservation bounds are not treated as user moves", () => {
  assert.match(mainSource, /let expectedWorkPanelBounds: WindowBounds \| null = null/);
  assert.match(mainSource, /expectedWorkPanelBounds = next\.bounds/);
  assert.match(
    mainSource,
    /expectedWorkPanelBounds\s*&&\s*windowBoundsEqual\(\s*currentBounds,\s*expectedWorkPanelBounds\s*\)/,
  );
  assert.match(mainSource, /expectedWorkPanelBounds = null/);
});

test("the right native edge previews panel width while the inner divider owns chat width", () => {
  assert.match(mainSource, /window\.on\("will-resize",/);
  assert.match(mainSource, /isWorkPanelOuterResizeEdge\(details\?\.edge\)/);
  assert.match(mainSource, /window\.on\("resized", armNativeWorkPanelResizeFinish\)/);
  assert.match(mainSource, /window\.webContents\.send\(IPC\.event\.windowWorkPanelResize/);
  assert.match(mainSource, /window\.setMinimumSize\(baseBounds\.width \+ WORK_PANEL_MIN_WIDTH/);
  assert.match(mainSource, /window\.on\("resize", observeNativeWorkPanelResize\)/);
});

test("native bounds timers are cleaned up with the window", () => {
  assert.match(
    mainSource,
    /window\.on\("closed", \(\) => \{[\s\S]*?clearTimeout\(boundsTimer\)[\s\S]*?clearTimeout\(saveTimer\)/,
  );
});
