import assert from "node:assert/strict";
import test from "node:test";
import {
  applyMainWindowBackground,
  mainWindowBackgroundOptions,
  toElectronBackgroundColor,
} from "../electron/main/window-background.ts";

function makeWindow() {
  const calls = [];
  return {
    calls,
    setBackgroundColor: (color) => calls.push(["window", color]),
  };
}

test("plugin colors convert from RRGGBBAA to an explicit CSS color", () => {
  assert.equal(toElectronBackgroundColor("#123456"), "rgba(18, 52, 86, 1)");
  assert.equal(toElectronBackgroundColor("#12345680"), "rgba(18, 52, 86, 0.5019607843137255)");
  assert.equal(toElectronBackgroundColor("#abcdef00"), "rgba(171, 205, 239, 0)");
  assert.throws(() => toElectronBackgroundColor("#1234567"), /invalid window background color/);
});

test("every Windows constructor uses an opaque surface while other platforms are unchanged", () => {
  assert.deepEqual(mainWindowBackgroundOptions("win32", "#ffffff"), {
    transparent: false,
    backgroundColor: "#ffffff",
  });
  assert.deepEqual(mainWindowBackgroundOptions("linux", "#12345680"), {
    backgroundColor: "rgba(18, 52, 86, 0.5019607843137255)",
  });
  assert.deepEqual(mainWindowBackgroundOptions("darwin", "#ffffff"), {});
});

test("Windows alpha theme colors are flattened before creation and later updates", () => {
  assert.deepEqual(mainWindowBackgroundOptions("win32", "#12345680", "#ffffff"), {
    transparent: false,
    backgroundColor: "#8899aa",
  });
  assert.deepEqual(mainWindowBackgroundOptions("win32", "#12345600", "#181818"), {
    transparent: false,
    backgroundColor: "#181818",
  });
  const windows = makeWindow();
  assert.equal(applyMainWindowBackground(windows, "win32", "#00000080", "#ffffff"), true);
  assert.deepEqual(windows.calls, [["window", "#7f7f7f"]]);
});

test("background updates use the native Windows/Linux window without changing macOS", () => {
  const windows = makeWindow();
  assert.equal(applyMainWindowBackground(windows, "win32", "#12345680"), true);
  assert.deepEqual(windows.calls, [["window", "#123456"]]);
  const linux = makeWindow();
  assert.equal(applyMainWindowBackground(linux, "linux", "#12345680"), true);
  assert.deepEqual(linux.calls, [["window", "rgba(18, 52, 86, 0.5019607843137255)"]]);
  const mac = makeWindow();
  assert.equal(applyMainWindowBackground(mac, "darwin", "#123456"), false);
  assert.deepEqual(mac.calls, []);
});
