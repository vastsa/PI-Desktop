import assert from "node:assert/strict";
import test from "node:test";
import { activateMainWindowTarget } from "../electron/main/bootstrap/window-visibility.ts";

function target({ minimized = false, topmost = false, focused = false, focusError, closedOnShow = false } = {}) {
  const calls = [];
  let closed = false;
  return {
    calls,
    window: {
      isDestroyed: () => closed,
      isMinimized: () => minimized,
      isAlwaysOnTop: () => topmost,
      isFocused: () => focused,
      restore: () => calls.push("restore"),
      show: () => {
        calls.push("show");
        closed = closedOnShow;
      },
      focus: () => {
        calls.push("focus");
        if (focusError) throw focusError;
      },
      setAlwaysOnTop: (value) => calls.push(value),
    },
  };
}

test("explicit Windows activation restores, temporarily raises, and reports observed focus", () => {
  const { calls, window } = target({ minimized: true });
  assert.deepEqual(activateMainWindowTarget(window, "win32"), { focused: false });
  assert.deepEqual(calls, ["restore", true, "show", "focus", false]);
});

test("explicit activation preserves an already topmost window and does not raise on other platforms", () => {
  for (const [platform, topmost] of [["win32", true], ["linux", false], ["darwin", false]]) {
    const { calls, window } = target({ topmost, focused: true });
    assert.deepEqual(activateMainWindowTarget(window, platform), { focused: true });
    assert.deepEqual(calls, ["show", "focus"]);
  }
});

test("explicit activation undoes temporary topmost state after an exception", () => {
  const error = new Error("Focus failed");
  const { calls, window } = target({ focusError: error });
  assert.throws(() => activateMainWindowTarget(window, "win32"), (thrown) => thrown === error);
  assert.deepEqual(calls, [true, "show", "focus", false]);
});

test("explicit activation no-ops when a main window is unavailable or disappears", () => {
  assert.deepEqual(activateMainWindowTarget(null, "win32"), { focused: false });
  const { calls, window } = target({ closedOnShow: true });
  assert.deepEqual(activateMainWindowTarget(window, "win32"), { focused: false });
  assert.deepEqual(calls, [true, "show"]);
});
