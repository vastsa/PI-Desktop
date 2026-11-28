import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import {
  createRendererCrashLoopFallback,
  gpuFallbackMarkerPath,
  hasGpuFallbackMarker,
} from "../electron/main/renderer-crash-loop.ts";
import {
  _resetCooldownForTest,
  noteRendererLoaded,
  recoverRendererAfterGone,
} from "../electron/main/renderer-recovery.ts";

/** Manual timer queue: nothing fires until the test advances the clock. */
function fakeTimers() {
  let now = 0;
  let nextId = 1;
  const pending = new Map();
  return {
    setTimer: (callback, ms) => {
      const id = nextId++;
      pending.set(id, { at: now + ms, callback });
      return id;
    },
    clearTimer: (id) => pending.delete(id),
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...pending]) {
        if (timer.at > now) continue;
        pending.delete(id);
        timer.callback();
      }
    },
    get size() {
      return pending.size;
    },
  };
}

const STABLE_MS = 600_000;

/**
 * One app process: a fallback controller wired to the real recovery breaker
 * the way `bootstrap/window.ts` wires it. `relaunch` ends the process.
 */
function launch(markerDir, timers) {
  _resetCooldownForTest();
  const outcome = { relaunches: 0, dialogs: 0, reloads: 0, logs: [] };
  const fallback = createRendererCrashLoopFallback({
    markerDir,
    logger: { app: (_category, level, message, fields) => outcome.logs.push({ level, message, fields }) },
    relaunch: () => outcome.relaunches++,
    showTerminalDialog: () => outcome.dialogs++,
    stableMs: STABLE_MS,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  const crash = () => {
    mock.timers.tick(3_000); // past the reload cooldown
    fallback.rendererGone();
    recoverRendererAfterGone(
      { reason: "crashed", exitCode: -2147483645 },
      {
        isCurrentWindow: true,
        quitting: false,
        windowCloseAccepted: false,
        windowDestroyed: false,
        webContentsDestroyed: false,
        reload: () => outcome.reloads++,
        log: () => {},
        onCrashLoopDetected: fallback.crashLoopDetected,
      },
    );
  };
  const load = () => {
    noteRendererLoaded();
    fallback.rendererLoaded();
  };
  return { outcome, fallback, crash, load };
}

describe("renderer crash-loop fallback (#2595)", () => {
  let markerDir;
  beforeEach(() => {
    markerDir = mkdtempSync(join(tmpdir(), "pi-crash-loop-"));
    mock.timers.enable({ apis: ["Date"], now: 10_000 });
  });
  afterEach(() => {
    _resetCooldownForTest();
    mock.timers.reset();
    chmodSync(markerDir, 0o755);
    rmSync(markerDir, { recursive: true, force: true });
  });

  it("relaunches once, then a second failing launch reaches the dialog", () => {
    const timers = fakeTimers();
    const first = launch(markerDir, timers);
    for (let i = 0; i < 8; i += 1) first.crash();
    assert.equal(first.outcome.relaunches, 1, "one guarded relaunch");
    assert.equal(first.outcome.dialogs, 0);
    assert.equal(first.outcome.reloads, 4, "reloads stop once the breaker trips");
    assert.ok(hasGpuFallbackMarker(markerDir), "the relaunch is persisted before it happens");

    const second = launch(markerDir, timers);
    for (let i = 0; i < 8; i += 1) second.crash();
    assert.equal(second.outcome.relaunches, 0, "the fallback is never spent twice");
    assert.equal(second.outcome.dialogs, 1, "the loop that survives it reaches the dialog once");
    assert.ok(hasGpuFallbackMarker(markerDir));
  });

  it("a stable fallback run clears the marker after continuous healthy uptime", () => {
    writeFileSync(gpuFallbackMarkerPath(markerDir), "{}");
    const timers = fakeTimers();
    const run = launch(markerDir, timers);
    run.load();
    timers.advance(STABLE_MS - 1);
    assert.ok(hasGpuFallbackMarker(markerDir), "not before the stable window elapses");
    timers.advance(1);
    assert.equal(hasGpuFallbackMarker(markerDir), false);
  });

  it("an earlier load's timer never clears the marker after a later crash", () => {
    writeFileSync(gpuFallbackMarkerPath(markerDir), "{}");
    const timers = fakeTimers();
    const run = launch(markerDir, timers);
    run.load();
    timers.advance(STABLE_MS / 2);
    for (let i = 0; i < 5; i += 1) run.crash();
    assert.equal(run.outcome.dialogs, 1, "terminal dialog is open");
    timers.advance(STABLE_MS * 2);
    assert.equal(timers.size, 0, "no timer outlives the crashed renderer");
    assert.ok(hasGpuFallbackMarker(markerDir), "marker survives while the dialog is open");
  });

  it("a reload restarts the healthy-uptime window instead of stacking timers", () => {
    writeFileSync(gpuFallbackMarkerPath(markerDir), "{}");
    const timers = fakeTimers();
    const run = launch(markerDir, timers);
    run.load();
    timers.advance(STABLE_MS - 1_000);
    run.load();
    assert.equal(timers.size, 1);
    timers.advance(1_000);
    assert.ok(hasGpuFallbackMarker(markerDir), "uptime counts from the latest load");
    timers.advance(STABLE_MS);
    assert.equal(hasGpuFallbackMarker(markerDir), false);
  });

  it("closing the window cancels the healthy-uptime timer", () => {
    writeFileSync(gpuFallbackMarkerPath(markerDir), "{}");
    const timers = fakeTimers();
    const run = launch(markerDir, timers);
    run.load();
    run.fallback.dispose();
    timers.advance(STABLE_MS * 2);
    assert.ok(hasGpuFallbackMarker(markerDir));
  });

  it("a normal boot without a marker arms no timer", () => {
    const timers = fakeTimers();
    launch(markerDir, timers).load();
    assert.equal(timers.size, 0);
  });

  it("a marker that cannot be persisted shows the dialog instead of relaunching", (t) => {
    if (process.platform === "win32" || process.getuid?.() === 0) {
      t.skip("directory permissions do not block writes here");
      return;
    }
    chmodSync(markerDir, 0o500);
    const timers = fakeTimers();
    const run = launch(markerDir, timers);
    for (let i = 0; i < 5; i += 1) run.crash();
    assert.equal(run.outcome.relaunches, 0, "no relaunch without a deduplication guard");
    assert.equal(run.outcome.dialogs, 1);
    const failure = run.outcome.logs.find((entry) => entry.level === "error");
    assert.ok(failure?.fields?.data?.error, "the write failure is logged");
  });

  it("a corrupt marker still counts as spent without being rewritten", () => {
    const path = gpuFallbackMarkerPath(markerDir);
    writeFileSync(path, "not json");
    assert.ok(hasGpuFallbackMarker(markerDir));
    assert.ok(existsSync(path));
  });
});
