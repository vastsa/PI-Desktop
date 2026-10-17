import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import vm from "node:vm";
import * as corners from "../electron/main/window-native-corners.ts";
import * as background from "../electron/main/window-background.ts";

const source = await readFile(new URL("../electron/main/bootstrap/window.ts", import.meta.url), "utf8");
const creation = source.slice(
  source.indexOf("  windowState.mainWindow = new BrowserWindow("),
  source.indexOf("  suppressLinuxFramelessSystemMenu(window);"),
).replaceAll("import.meta.url", '"file:///fixture/window.ts"');

async function createMainWindow(systemVersion) {
  const mutations = [];
  const hostCalls = [];
  const screen = Object.assign(new EventEmitter(), {
    getDisplayMatching: () => ({ scaleFactor: 1.75 }),
  });
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.contentView = {
        getBounds: () => ({ x: 0, y: 0, width: 1200, height: 800 }),
        setBorderRadius: (radius) => mutations.push(["clip", radius]),
      };
      this.maximized = false;
      this.fullScreen = false;
      this.destroyed = false;
    }
    getBounds() { return { x: 100, y: 100, width: 1200, height: 800 }; }
    getNativeWindowHandle() { return Buffer.from([0x78, 0x56, 0x34, 0x12]); }
    isDestroyed() { return this.destroyed; }
    isMaximized() { return this.maximized; }
    isFullScreen() { return this.fullScreen; }
    setShape(region) { mutations.push(["shape", region]); }
    setBackgroundColor(color) { this.background = color; }
  }
  const windowState = { host: { call: async (...args) => { hostCalls.push(args); } } };
  await vm.runInNewContext(stripTypeScriptTypes(`(async () => { ${creation} })()`), {
    ...corners, ...background,
    windowState, BrowserWindow, screen,
    process: { platform: "win32", getSystemVersion: () => systemVersion },
    restoredBounds: null, initialMinWidth: 800, initialMinHeight: 560,
    initialWindowBackground: "#181818", APP_NAME: "PI-Desktop",
    windowsIconPath: () => undefined,
    join: () => "fixture-preload.cjs", getModuleDirectory: () => "fixture",
    app: { getLocale: () => "en" }, logger: { app() {} },
  });
  return { window: windowState.mainWindow, mutations, hostCalls, screen };
}

test("Windows 10 startup and theme/restore journey never clip the native thick frame", async () => {
  const fixture = await createMainWindow("10.0.19045");
  const { window } = fixture;
  assert.equal(window.options.thickFrame, true);
  assert.equal(window.options.transparent, false);
  assert.equal(window.options.resizable, true);
  assert.deepEqual(fixture.mutations, [], "no region may cut off the native frame or renderer");
  for (const radius of [0, 24, 12]) {
    assert.equal(await corners.applyWindowCornerRadius(window, radius), radius);
    background.applyMainWindowBackground(window, "win32", "#00000080", "#ffffff");
    assert.equal(window.background, "#7f7f7f");
    for (const event of ["maximize", "enter-full-screen", "leave-full-screen", "unmaximize", "show", "restore"]) {
      window.maximized = event === "maximize";
      window.fullScreen = event === "enter-full-screen";
      window.emit(event);
      await new Promise(setImmediate);
    }
    fixture.screen.emit("display-metrics-changed");
    assert.deepEqual(fixture.mutations, []);
    assert.deepEqual(fixture.hostCalls, [], "Windows 10 must not invoke the Windows 11 DWM API");
  }
  window.destroyed = true;
  window.emit("closed");
  assert.equal(await corners.applyWindowCornerRadius(window, 12), null);
});

test("Windows 11 startup and theme changes still use the DWM controller", async () => {
  const fixture = await createMainWindow("10.0.22000");
  assert.equal(fixture.hostCalls.at(-1)[1].preference, "round");
  assert.equal(await corners.applyWindowCornerRadius(fixture.window, 0), 0);
  assert.equal(fixture.hostCalls.at(-1)[1].preference, "square");
  assert.equal(await corners.applyWindowCornerRadius(fixture.window, 24), 24);
  assert.equal(fixture.hostCalls.at(-1)[1].preference, "round");
  assert.deepEqual(fixture.mutations, []);
  fixture.window.emit("closed");
});
