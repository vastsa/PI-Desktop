/** Exercise the production menu action against native BrowserWindow state. */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { register, stripTypeScriptTypes } from "node:module";
import vm from "node:vm";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { isWindowFullScreen, setWindowFullScreen } = await import(
  "../electron/main/window-fullscreen.ts"
);
const { maximizedBoundsExceedWorkArea, maximizedBoundsForWorkArea } = await import(
  "../electron/main/work-panel-window.ts"
);
const { readMainSource } = await import("./helpers/source-contracts.mjs");
const lifecycleSource = await readMainSource();
const menuActionSource = lifecycleSource.slice(
  lifecycleSource.indexOf("  function executeNativeMenuAction("),
  lifecycleSource.indexOf("  function dispatchNativeMenuAction("),
);

function nativeMenuAction(window, systemVersion, { platform = "win32", mainWindow = window } = {}) {
  const deferred = [];
  const execute = vm.runInNewContext(stripTypeScriptTypes(`${menuActionSource}\nexecuteNativeMenuAction;`), {
    state: { mainWindow },
    process: { platform, getSystemVersion: () => systemVersion },
    isWindowFullScreen,
    setWindowFullScreen,
    setImmediate: (callback) => deferred.push(callback),
  });
  execute.flushDeferred = () => {
    for (const callback of deferred.splice(0)) callback();
  };
  return execute;
}

function makeWindow(nativeRestoreState = true) {
  const window = new EventEmitter();
  const calls = [];
  let maximized = false;
  let fullScreen = false;
  let restoreMaximized = false;
  Object.assign(window, {
    isDestroyed: () => false,
    isMaximized: () => maximized,
    isFullScreen: () => fullScreen,
    setFullScreen(value) {
      // Electron emits before publishing its native fullscreen state.
      window.emit(value ? "enter-full-screen" : "leave-full-screen");
      if (nativeRestoreState) {
        if (value) {
          restoreMaximized = maximized;
          maximized = false;
        } else maximized = restoreMaximized;
      }
      fullScreen = value;
    },
    unmaximize() { calls.push("unmaximize"); maximized = false; },
    maximize() { calls.push("maximize"); maximized = true; },
  });
  return {
    window,
    calls,
    setMaximized(value) { maximized = value; },
    setNativeFullScreen(value) { fullScreen = value; },
  };
}

for (const systemVersion of ["10.0.19045", "10.0.22000", "10.0.26200"]) {
  for (const initialMaximized of [false, true]) {
    test(`Windows main fullscreen preserves native state without a small-window transition: ${systemVersion}/${initialMaximized}`, () => {
      const fixture = makeWindow();
      const execute = nativeMenuAction(fixture.window, systemVersion);
      fixture.setMaximized(initialMaximized);
      execute("toggleFullScreen");
      assert.equal(isWindowFullScreen(fixture.window), true);
      assert.equal(fixture.window.isMaximized(), false);
      assert.deepEqual(fixture.calls, [], "enter fullscreen without unmaximizing first");
      execute("toggleFullScreen");
      execute.flushDeferred();
      assert.equal(isWindowFullScreen(fixture.window), false);
      assert.equal(fixture.window.isMaximized(), initialMaximized);
      assert.deepEqual(fixture.calls, [], "native fullscreen restores the original maximize state");
    });
  }
  test(`Windows native exit leaves no stale application fullscreen flag: ${systemVersion}`, () => {
    const fixture = makeWindow();
    const execute = nativeMenuAction(fixture.window, systemVersion);
    execute("toggleFullScreen");
    fixture.setNativeFullScreen(false);
    fixture.window.emit("leave-full-screen");
    execute.flushDeferred();
    assert.equal(isWindowFullScreen(fixture.window), false);
    execute("toggleFullScreen");
    assert.equal(isWindowFullScreen(fixture.window), true);
    assert.deepEqual(fixture.calls, []);
  });
}

test("all Windows main windows use an opaque surface for native fullscreen", async () => {
  const { mainWindowBackgroundOptions } = await import("../electron/main/window-background.ts");
  assert.deepEqual(mainWindowBackgroundOptions("win32", "#ffffff"), {
    transparent: false,
    backgroundColor: "#ffffff",
  });
});

test("maximizing from fullscreen leaves fullscreen before maximizing", () => {
  const fixture = makeWindow();
  const execute = nativeMenuAction(fixture.window, "10.0.19045");
  execute("toggleFullScreen");
  execute("toggleMaximize");
  assert.equal(isWindowFullScreen(fixture.window), false);
  assert.equal(fixture.window.isMaximized(), true);
  assert.deepEqual(fixture.calls, ["maximize"]);
});

for (const options of [{ platform: "linux" }, { platform: "darwin" }, { mainWindow: null }]) {
  test(`non-main or non-Windows windows preserve their explicit restore: ${JSON.stringify(options)}`, () => {
    const fixture = makeWindow(false);
    const execute = nativeMenuAction(fixture.window, "10.0.26200", options);
    fixture.setMaximized(true);
    execute("toggleFullScreen", fixture.window);
    assert.deepEqual(fixture.calls, ["unmaximize"]);
    execute("toggleFullScreen", fixture.window);
    execute.flushDeferred();
    assert.equal(fixture.window.isMaximized(), true);
    assert.deepEqual(fixture.calls, ["unmaximize", "maximize"]);
  });
}

for (const afterLeave of ["normal", "destroyed", "reentered-fullscreen"]) {
  test(`explicit restore waits for state publication and ignores stale results: ${afterLeave}`, () => {
    const fixture = makeWindow(false);
    const execute = nativeMenuAction(fixture.window, "", { platform: "linux" });
    fixture.setMaximized(true);
    execute("toggleFullScreen");
    execute("toggleFullScreen");
    assert.equal(fixture.window.isMaximized(), false);
    if (afterLeave === "destroyed") fixture.window.isDestroyed = () => true;
    if (afterLeave === "reentered-fullscreen") fixture.setNativeFullScreen(true);
    execute.flushDeferred();
    assert.equal(fixture.window.isMaximized(), afterLeave === "normal");
  });
}

test("display topology changes respect native fullscreen state", () => {
  assert.match(lifecycleSource, /if \(isLiveWindow\(\) && !isWindowFullScreen\(window\)\) \{/);
});

test("a maximized rect that only overshoots the work area is left alone", () => {
  const workArea = { x: 0, y: 0, width: 1920, height: 1032 };
  const maximized = { x: -8, y: -8, width: 1936, height: 1048 };
  assert.equal(maximizedBoundsExceedWorkArea(maximized, workArea), false);
  assert.deepEqual(maximizedBoundsForWorkArea(maximized, workArea), maximized);
});

test("the frameless restore that hides the taskbar is detected and corrected", () => {
  // Windows restores a frameless maximized window to the full monitor rect:
  // height 1120 instead of the work-area-based 1048, so the taskbar is hidden.
  const workArea = { x: 0, y: 0, width: 1920, height: 1032 };
  const restored = { x: -8, y: -8, width: 1936, height: 1120 };
  assert.equal(maximizedBoundsExceedWorkArea(restored, workArea), true);
  assert.deepEqual(maximizedBoundsForWorkArea(restored, workArea), {
    x: -8,
    y: -8,
    width: 1936,
    height: 1048,
  });
});

test("a monitor without a taskbar never reports a false positive", () => {
  // Secondary display: the work area equals the monitor, so a healthy
  // maximized window already overshoots the bottom by the same inset as the
  // top and must not be treated as a broken restore.
  const workArea = { x: 1920, y: 0, width: 1920, height: 1080 };
  const maximized = { x: 1912, y: -8, width: 1936, height: 1096 };
  assert.equal(maximizedBoundsExceedWorkArea(maximized, workArea), false);
  const restored = { x: 1912, y: -8, width: 1936, height: 1120 };
  assert.equal(maximizedBoundsExceedWorkArea(restored, workArea), true);
});

test("a windowed rect is never treated as a broken maximize", () => {
  const workArea = { x: 0, y: 0, width: 1920, height: 1032 };
  const windowed = { x: 360, y: 116, width: 1200, height: 800 };
  assert.equal(maximizedBoundsExceedWorkArea(windowed, workArea), false);
});

test("the restore handler re-applies the work-area-based maximized rect", () => {
  const block = lifecycleSource.slice(
    lifecycleSource.indexOf("const reconcileRestoredMaximize"),
    lifecycleSource.indexOf('window.on("resize", observeNativeWorkPanelResize)'),
  );
  assert.match(block, /maximizedBoundsExceedWorkArea\(bounds, workArea\)/);
  assert.match(
    block,
    /window\.setBounds\(maximizedBoundsForWorkArea\(bounds, workArea\)\)/,
  );
  assert.match(block, /window\.on\("restore"/);
  // The OS finishes the restore after the event dispatch, so the correction
  // has to be repeated once the transition settles.
  assert.match(block, /windowBoundsSettleMs/);
});
