import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import {
  recoverRendererAfterGone,
  noteRendererLoaded,
  _resetCooldownForTest,
} from "../electron/main/renderer-recovery.ts";

function recovery(overrides = {}) {
  const calls = { reload: 0, logs: [] };
  const dependencies = {
    isCurrentWindow: true,
    quitting: false,
    windowCloseAccepted: false,
    windowDestroyed: false,
    webContentsDestroyed: false,
    reload: () => calls.reload++,
    log: (details, reloaded) => calls.logs.push({ details, reloaded }),
    ...overrides,
  };
  return { calls, dependencies };
}

describe("recoverRendererAfterGone", () => {
  afterEach(() => {
    _resetCooldownForTest();
    mock.timers.reset();
  });

  it("unexpected renderer exits reload the live main window and preserve diagnostics", () => {
    mock.timers.enable({ apis: ["Date", "setTimeout"] });
    mock.timers.tick(10_000);

    const { calls, dependencies } = recovery();
    const details = { reason: "crashed", exitCode: 73 };

    assert.equal(recoverRendererAfterGone(details, dependencies), true);
    assert.equal(calls.reload, 1);
    assert.deepEqual(calls.logs, [{ details, reloaded: true }]);
  });

  it("clean exits and windows outside the live main lifecycle are not reloaded", () => {
    mock.timers.enable({ apis: ["Date", "setTimeout"] });
    mock.timers.tick(10_000);

    const cases = [
      [{ reason: "clean-exit", exitCode: 0 }, {}],
      [{ reason: "crashed", exitCode: 1 }, { isCurrentWindow: false }],
      [{ reason: "crashed", exitCode: 1 }, { quitting: true }],
      [{ reason: "crashed", exitCode: 1 }, { windowCloseAccepted: true }],
      [{ reason: "crashed", exitCode: 1 }, { windowDestroyed: true }],
      [{ reason: "crashed", exitCode: 1 }, { webContentsDestroyed: true }],
    ];

    for (const [details, overrides] of cases) {
      // Advance clock so cooldown does not interfere.
      mock.timers.tick(10_000);
      const { calls, dependencies } = recovery(overrides);
      assert.equal(recoverRendererAfterGone(details, dependencies), false);
      assert.equal(calls.reload, 0);
      assert.deepEqual(calls.logs, [{ details, reloaded: false }]);
    }
  });

  it("new renderer exit reasons remain recoverable by default", () => {
    mock.timers.enable({ apis: ["Date", "setTimeout"] });
    mock.timers.tick(10_000);

    const { calls, dependencies } = recovery();
    assert.equal(
      recoverRendererAfterGone({ reason: "future-electron-reason", exitCode: 2 }, dependencies),
      true,
    );
    assert.equal(calls.reload, 1);
  });

  it("rapid consecutive crashes delay the reload instead of looping", () => {
    mock.timers.enable({ apis: ["Date", "setTimeout"] });
    mock.timers.tick(10_000);

    const first = recovery();
    const details = { reason: "crashed", exitCode: 1 };

    // First crash reloads immediately.
    assert.equal(recoverRendererAfterGone(details, first.dependencies), true);
    assert.equal(first.calls.reload, 1);

    // Second crash within cooldown window — reload is scheduled, not immediate.
    mock.timers.tick(500);
    const second = recovery();
    assert.equal(recoverRendererAfterGone(details, second.dependencies), true);
    assert.equal(second.calls.reload, 0, "should not reload synchronously during cooldown");

    // After the remaining cooldown elapses, the delayed reload fires.
    mock.timers.tick(1_500);
    assert.equal(second.calls.reload, 1, "delayed reload should have fired");
  });

  it("crashes after the cooldown window reload immediately", () => {
    mock.timers.enable({ apis: ["Date", "setTimeout"] });
    mock.timers.tick(10_000);

    const first = recovery();
    const details = { reason: "crashed", exitCode: 1 };
    recoverRendererAfterGone(details, first.dependencies);

    // Wait longer than cooldown.
    mock.timers.tick(3_000);
    const second = recovery();
    assert.equal(recoverRendererAfterGone(details, second.dependencies), true);
    assert.equal(second.calls.reload, 1, "should reload immediately after cooldown");
  });

  it("consecutive startup crashes without a load trip the breaker once (#2595)", () => {
    mock.timers.enable({ apis: ["Date", "setTimeout"] });
    mock.timers.tick(10_000);

    const details = { reason: "crashed", exitCode: 1 };
    let trips = 0;
    const reloads = [];

    for (let i = 1; i <= 7; i += 1) {
      const attempt = recovery({
        onCrashLoopDetected: () => {
          trips += 1;
        },
        reload: () => reloads.push(i),
      });
      mock.timers.tick(3_000); // clear cooldown between attempts
      recoverRendererAfterGone(details, attempt.dependencies);
    }

    // Crashes 1-4 keep reloading; crash 5 trips the breaker and stops the
    // loop; 6-7 are logged but inert.
    assert.deepEqual(reloads, [1, 2, 3, 4]);
    assert.equal(trips, 1, "the escalation fires exactly once");
  });

  it("a successful load resets the crash streak, so scattered crashes never trip it", () => {
    mock.timers.enable({ apis: ["Date", "setTimeout"] });
    mock.timers.tick(10_000);

    const details = { reason: "crashed", exitCode: 1 };
    let trips = 0;

    for (let cycle = 0; cycle < 6; cycle += 1) {
      const attempt = recovery({
        onCrashLoopDetected: () => {
          trips += 1;
        },
      });
      mock.timers.tick(3_000);
      recoverRendererAfterGone(details, attempt.dependencies);
      // The renderer came back up between crashes.
      noteRendererLoaded();
    }

    assert.equal(trips, 0);
  });

  it("a load after a trip re-arms the breaker for the next renderer", () => {
    mock.timers.enable({ apis: ["Date", "setTimeout"] });
    mock.timers.tick(10_000);

    const details = { reason: "crashed", exitCode: 1 };
    let trips = 0;
    let reloads = 0;
    const crash = () => {
      const attempt = recovery({
        onCrashLoopDetected: () => {
          trips += 1;
        },
        reload: () => {
          reloads += 1;
        },
      });
      mock.timers.tick(3_000);
      recoverRendererAfterGone(details, attempt.dependencies);
    };

    for (let i = 0; i < 5; i += 1) crash();
    assert.equal(trips, 1);
    noteRendererLoaded();
    crash();
    assert.equal(reloads, 5, "a crash after a successful load reloads again");
    for (let i = 0; i < 4; i += 1) crash();
    assert.equal(trips, 2);
  });

  it("clean exits never count toward the breaker", () => {
    mock.timers.enable({ apis: ["Date", "setTimeout"] });
    mock.timers.tick(10_000);

    let trips = 0;
    for (let i = 0; i < 8; i += 1) {
      const attempt = recovery({
        onCrashLoopDetected: () => {
          trips += 1;
        },
      });
      mock.timers.tick(3_000);
      assert.equal(
        recoverRendererAfterGone({ reason: "clean-exit", exitCode: 0 }, attempt.dependencies),
        false,
      );
    }
    assert.equal(trips, 0);
  });
});
