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
    contentView: {
      setBackgroundColor: (color) => calls.push(["contentView", color]),
    },
    setBackgroundColor: (color) => calls.push(["window", color]),
  };
}

test("plugin colors convert from RRGGBBAA to an explicit CSS color", () => {
  assert.equal(toElectronBackgroundColor("#123456"), "rgba(18, 52, 86, 1)");
  assert.equal(
    toElectronBackgroundColor("#12345680"),
    "rgba(18, 52, 86, 0.5019607843137255)",
  );
  assert.equal(toElectronBackgroundColor("#abcdef00"), "rgba(171, 205, 239, 0)");
  assert.throws(() => toElectronBackgroundColor("#1234567"), /invalid window background color/);
});

test("constructor background options keep only the Windows outer surface transparent", () => {
  assert.deepEqual(mainWindowBackgroundOptions("win32", "#ffffff"), {
    transparent: true,
    backgroundColor: "#00000000",
  });
  assert.deepEqual(mainWindowBackgroundOptions("linux", "#12345680"), {
    backgroundColor: "rgba(18, 52, 86, 0.5019607843137255)",
  });
  assert.deepEqual(mainWindowBackgroundOptions("darwin", "#ffffff"), {});
});

test("background updates target the rounded content view on Windows and native window on Linux", () => {
  const windows = makeWindow();
  assert.equal(applyMainWindowBackground(windows, "win32", "#12345680"), true);
  assert.deepEqual(windows.calls, [["contentView", "rgba(18, 52, 86, 0.5019607843137255)"]]);

  const linux = makeWindow();
  assert.equal(applyMainWindowBackground(linux, "linux", "#123456"), true);
  assert.deepEqual(linux.calls, [["window", "rgba(18, 52, 86, 1)"]]);

  const mac = makeWindow();
  assert.equal(applyMainWindowBackground(mac, "darwin", "#123456"), false);
  assert.deepEqual(mac.calls, []);
});
