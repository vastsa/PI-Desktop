/**
 * Maximize-toggle planning for the Windows flag-loss quirk (issue #1993).
 *
 * Behavioral: with `frame:false` + `thickFrame:false`, Windows can drop the
 * native maximized flag (IsZoomed) while the window keeps its work-area
 * size; `isMaximized()` then reads false and a plain toggle keeps calling
 * `maximize()` on a window that already fills the screen — the title-bar
 * button goes dead. The decision must fall back to geometry: a non-maximized
 * window whose bounds cover the work area of its display counts as
 * pseudo-maximized, and the toggle restores it to an explicit windowed rect
 * (Electron's own restore bounds are the full rect in that state, so
 * `maximize()+unmaximize()` is a no-op — review feedback on PR #2420).
 *
 * Contract: fullscreen windows never count as pseudo-maximized (their
 * bounds cover the work area too), so the exit-fullscreen-then-maximize
 * interlock from issue #1655 stays intact; and the geometric fallback is
 * Windows-only, because elsewhere a work-area-filling window is an ordinary
 * user-resized window.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const { boundsCoverWorkArea, planMaximizeToggle, windowedRestoreBounds } = await import(
  "../electron/main/window-maximize.ts"
);

const WORK_AREA = { x: 0, y: 0, width: 1920, height: 1040 };

test("a maximized window always restores", () => {
  assert.equal(
    planMaximizeToggle({
      isMaximized: true,
      isFullScreen: false,
      platform: "win32",
      bounds: WORK_AREA,
      workArea: WORK_AREA,
    }),
    "unmaximize",
  );
});

test("a pseudo-maximized window (flag lost, bounds cover the work area) restores to a windowed rect on Windows", () => {
  assert.equal(
    planMaximizeToggle({
      isMaximized: false,
      isFullScreen: false,
      platform: "win32",
      bounds: { x: -8, y: -8, width: 1936, height: 1088 },
      workArea: WORK_AREA,
    }),
    "restoreWindowed",
  );
});

test("the geometric fallback is Windows-only", () => {
  // Outside win32 a work-area-filling window is an ordinary user-resized
  // window: the maximize() flag sets fine there, and intercepting it would
  // only regress the working toggle.
  for (const platform of ["darwin", "linux"]) {
    assert.equal(
      planMaximizeToggle({
        isMaximized: false,
        isFullScreen: false,
        platform,
        bounds: { x: -8, y: -8, width: 1936, height: 1088 },
        workArea: WORK_AREA,
      }),
      "maximize",
      `${platform} keeps the plain maximize path`,
    );
  }
});

test("slack tolerates off-by-small bounds from DPI rounding and display changes", () => {
  assert.equal(
    boundsCoverWorkArea(
      { x: -6, y: -6, width: 1930, height: 1050 },
      WORK_AREA,
    ),
    true,
  );
  assert.equal(
    boundsCoverWorkArea(
      { x: -40, y: -40, width: 2000, height: 1120 },
      WORK_AREA,
    ),
    true,
    "covering means the window reaches past the work area, not exact equality",
  );
  assert.equal(
    boundsCoverWorkArea(
      { x: 0, y: 0, width: 1900, height: 1040 },
      WORK_AREA,
    ),
    false,
    "a window narrower than the work area does not cover it",
  );
});

test("an ordinary windowed window maximizes", () => {
  assert.equal(
    planMaximizeToggle({
      isMaximized: false,
      isFullScreen: false,
      platform: "win32",
      bounds: { x: 100, y: 100, width: 800, height: 600 },
      workArea: WORK_AREA,
    }),
    "maximize",
  );
});

test("a fullscreen window never takes the pseudo-maximized path", () => {
  assert.equal(
    planMaximizeToggle({
      isMaximized: false,
      isFullScreen: true,
      platform: "win32",
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      workArea: WORK_AREA,
    }),
    "maximize",
    "fullscreen must keep the exit-fullscreen-then-maximize interlock (#1655)",
  );
});

test("a missing work area falls back to the plain maximize path", () => {
  assert.equal(
    planMaximizeToggle({
      isMaximized: false,
      isFullScreen: false,
      platform: "win32",
      bounds: WORK_AREA,
      workArea: null,
    }),
    "maximize",
  );
});

test("trustworthy last normal bounds win over the computed rect", () => {
  const lastNormal = { x: 200, y: 150, width: 1100, height: 700 };
  assert.deepEqual(
    windowedRestoreBounds({
      workArea: WORK_AREA,
      lastNormal,
      minWidth: 400,
      minHeight: 300,
    }),
    lastNormal,
  );
});

test("last normal bounds are rejected when they cover the work area (flag-loss pollution)", () => {
  // In the flag-lost state Win32 reports the full rect as the normal
  // position, so bounds recorded afterwards are the rect being escaped.
  assert.deepEqual(
    windowedRestoreBounds({
      workArea: WORK_AREA,
      lastNormal: { x: 0, y: 0, width: 1920, height: 1040 },
      minWidth: 400,
      minHeight: 300,
    }),
    { x: 320, y: 174, width: 1280, height: 693 },
    "falls back to two thirds of the work area, centered",
  );
});

test("last normal bounds are rejected when they leave the work area", () => {
  assert.deepEqual(
    windowedRestoreBounds({
      workArea: WORK_AREA,
      lastNormal: { x: -500, y: 0, width: 800, height: 600 },
      minWidth: 400,
      minHeight: 300,
    }),
    { x: 320, y: 174, width: 1280, height: 693 },
  );
});

test("last normal bounds below the minimum size are rejected", () => {
  assert.deepEqual(
    windowedRestoreBounds({
      workArea: WORK_AREA,
      lastNormal: { x: 100, y: 100, width: 200, height: 100 },
      minWidth: 400,
      minHeight: 300,
    }),
    { x: 320, y: 174, width: 1280, height: 693 },
  );
});

test("no last normal bounds yields two thirds of the work area, centered", () => {
  assert.deepEqual(
    windowedRestoreBounds({
      workArea: WORK_AREA,
      lastNormal: null,
      minWidth: 0,
      minHeight: 0,
    }),
    { x: 320, y: 174, width: 1280, height: 693 },
  );
});
