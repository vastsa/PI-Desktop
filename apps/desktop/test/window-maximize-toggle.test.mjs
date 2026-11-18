/**
 * Maximize-toggle planning for the Windows flag-loss quirk (issue #1993).
 *
 * Behavioral: with `frame:false` + `thickFrame:false`, Windows can drop the
 * native maximized flag (IsZoomed) while the window keeps its work-area
 * size; `isMaximized()` then reads false and a plain toggle keeps calling
 * `maximize()` on a window that already fills the screen — the title-bar
 * button goes dead. The decision must fall back to geometry: a non-maximized
 * window whose bounds cover the work area of its display counts as
 * pseudo-maximized.
 *
 * Contract: fullscreen windows never count as pseudo-maximized (their
 * bounds cover the work area too), so the exit-fullscreen-then-maximize
 * interlock from issue #1655 stays intact.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const { boundsCoverWorkArea, planMaximizeToggle } = await import(
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

test("a pseudo-maximized window (flag lost, bounds cover the work area) resyncs and restores on Windows", () => {
  assert.equal(
    planMaximizeToggle({
      isMaximized: false,
      isFullScreen: false,
      platform: "win32",
      bounds: { x: -8, y: -8, width: 1936, height: 1088 },
      workArea: WORK_AREA,
    }),
    "resyncUnmaximize",
  );
});

test("the geometric fallback is Windows-only", () => {
  // Outside win32 a work-area-filling window is an ordinary user-resized
  // window: the maximize() flag sets fine there, and a resync would only
  // risk regressing the working toggle.
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
