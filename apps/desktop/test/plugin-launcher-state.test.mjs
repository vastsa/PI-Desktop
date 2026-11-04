import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  PLUGIN_LAUNCHER_DEFAULT_HEIGHT,
  PLUGIN_LAUNCHER_DEFAULT_WIDTH,
  PLUGIN_LAUNCHER_MAX_WIDTH,
  PLUGIN_LAUNCHER_MIN_CONTENT_HEIGHT,
  PLUGIN_LAUNCHER_MIN_WIDTH,
  PLUGIN_LAUNCHER_STATE_FILE,
  parseLauncherWindowState,
  readLauncherWindowState,
  resolveLauncherBounds,
  writeLauncherWindowState,
} from "../electron/main/plugin-launcher-state.ts";

const WORK_AREA = { x: 0, y: 0, width: 1920, height: 1040 };

function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), "pi-launcher-state-"));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a missing state file means the panel opens at its default size", () => {
  withTempDir((dir) => {
    assert.equal(readLauncherWindowState(dir), null);
    const bounds = resolveLauncherBounds(null, WORK_AREA);
    assert.equal(bounds.width, PLUGIN_LAUNCHER_DEFAULT_WIDTH);
    assert.equal(bounds.height, PLUGIN_LAUNCHER_DEFAULT_HEIGHT);
  });
});

test("the window cannot be persisted narrower than the eight-column floor", () => {
  const state = parseLauncherWindowState({ width: 120, height: 20 });

  assert.equal(state.width, PLUGIN_LAUNCHER_MIN_WIDTH);
  // Height is content-driven now, so only a very small floor is enforced.
  assert.equal(state.height, PLUGIN_LAUNCHER_MIN_CONTENT_HEIGHT);
});

test("an oversized remembered width is clamped", () => {
  const state = parseLauncherWindowState({ width: 5000, height: 5000 });

  assert.equal(state.width, PLUGIN_LAUNCHER_MAX_WIDTH);
});

test("a payload without a usable size is not remembered", () => {
  assert.equal(parseLauncherWindowState(null), null);
  assert.equal(parseLauncherWindowState("760x440"), null);
  assert.equal(parseLauncherWindowState({ width: "wide", height: 440 }), null);
});

test("a remembered position inside the work area is kept", () => {
  const bounds = resolveLauncherBounds(
    { width: 800, height: 500, x: 100, y: 120 },
    WORK_AREA,
  );

  assert.deepEqual(bounds, { x: 100, y: 120, width: 800, height: 500 });
});

test("a remembered position on a display that is gone falls back to centre", () => {
  const bounds = resolveLauncherBounds(
    { width: 800, height: 500, x: 4000, y: 3000 },
    WORK_AREA,
  );

  assert.equal(bounds.x, Math.round((WORK_AREA.width - 800) / 2));
  assert.equal(bounds.y, Math.round((WORK_AREA.height - 500) / 2));
});

test("a remembered size larger than the work area is reduced to fit", () => {
  const bounds = resolveLauncherBounds(
    { width: 1280, height: 940 },
    { x: 0, y: 0, width: 1000, height: 700 },
  );

  assert.equal(bounds.width, 1000);
  assert.equal(bounds.height, 700);
});

test("the size survives a write and read round trip", () => {
  withTempDir((dir) => {
    writeLauncherWindowState(dir, { x: 40, y: 60, width: 900, height: 620 });

    assert.deepEqual(readLauncherWindowState(dir), {
      width: 900,
      height: 620,
      x: 40,
      y: 60,
    });
  });
});

test("an unreadable state file degrades to no remembered size", () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, PLUGIN_LAUNCHER_STATE_FILE), "{not json", "utf8");

    assert.equal(readLauncherWindowState(dir), null);
  });
});

test("a write into a directory that does not exist does not throw", () => {
  assert.doesNotThrow(() =>
    writeLauncherWindowState(join(tmpdir(), "pi-launcher-missing-dir"), {
      width: 800,
      height: 500,
    }),
  );
});
