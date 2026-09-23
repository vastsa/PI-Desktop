import assert from "node:assert/strict";
import test from "node:test";
import { recoverRendererAfterGone } from "../electron/main/renderer-recovery.ts";

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

test("unexpected renderer exits reload the live main window and preserve diagnostics", () => {
  const { calls, dependencies } = recovery();
  const details = { reason: "crashed", exitCode: 73 };

  assert.equal(recoverRendererAfterGone(details, dependencies), true);
  assert.equal(calls.reload, 1);
  assert.deepEqual(calls.logs, [{ details, reloaded: true }]);
});

test("clean exits and windows outside the live main lifecycle are not reloaded", () => {
  const cases = [
    [{ reason: "clean-exit", exitCode: 0 }, {}],
    [{ reason: "crashed", exitCode: 1 }, { isCurrentWindow: false }],
    [{ reason: "crashed", exitCode: 1 }, { quitting: true }],
    [{ reason: "crashed", exitCode: 1 }, { windowCloseAccepted: true }],
    [{ reason: "crashed", exitCode: 1 }, { windowDestroyed: true }],
    [{ reason: "crashed", exitCode: 1 }, { webContentsDestroyed: true }],
  ];

  for (const [details, overrides] of cases) {
    const { calls, dependencies } = recovery(overrides);
    assert.equal(recoverRendererAfterGone(details, dependencies), false);
    assert.equal(calls.reload, 0);
    assert.deepEqual(calls.logs, [{ details, reloaded: false }]);
  }
});

test("new renderer exit reasons remain recoverable by default", () => {
  const { calls, dependencies } = recovery();
  assert.equal(
    recoverRendererAfterGone({ reason: "future-electron-reason", exitCode: 2 }, dependencies),
    true,
  );
  assert.equal(calls.reload, 1);
});
