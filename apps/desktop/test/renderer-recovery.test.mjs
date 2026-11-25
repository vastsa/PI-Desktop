import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import { recoverRendererAfterGone, _resetCooldownForTest } from "../electron/main/renderer-recovery.ts";

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

  it("stops reloading after too many consecutive crash loops", () => {
    mock.timers.enable({ apis: ["Date", "setTimeout"] });
    mock.timers.tick(10_000);

    const details = { reason: "crashed", exitCode: 1 };

    // Simulate the startup crash loop: a crash every ~2 seconds, forever.
    let recovered = 0;
    for (let i = 0; i < 50; i++) {
      const attempt = recovery();
      assert.equal(recoverRendererAfterGone(details, attempt.dependencies), i < 5);
      if (i < 5) recovered++;
      mock.timers.tick(2_100);
    }

    assert.equal(recovered, 5, "recovery should stop after the reload cap");
  });

  it("a renderer that stays up past the recovery window resets the crash counter", () => {
    mock.timers.enable({ apis: ["Date", "setTimeout"] });
    mock.timers.tick(10_000);

    const details = { reason: "crashed", exitCode: 1 };
    let reloads = 0;
    const dependencies = recovery({
      reload: () => reloads++,
    }).dependencies;

    for (let i = 0; i < 5; i++) {
      mock.timers.tick(2_100);
      recoverRendererAfterGone(details, dependencies);
    }
    assert.equal(reloads, 5);

    // Renderer stays up long enough to count as recovered, then crashes again.
    mock.timers.tick(60_000);
    const after = recovery({ reload: () => reloads++ });
    assert.equal(recoverRendererAfterGone(details, after.dependencies), true);
    assert.equal(reloads, 6, "recovery should resume after a healthy window");
  });
});
