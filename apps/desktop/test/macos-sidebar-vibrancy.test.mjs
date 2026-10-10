import { readMainModule } from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { register, registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

const electron = `data:text/javascript,${encodeURIComponent(`
  import { EventEmitter } from "node:events";
  export const nativeTheme = {
    themeSource: "system",
    osDark: false,
    get shouldUseDarkColors() {
      return this.themeSource === "dark" || (this.themeSource === "system" && this.osDark);
    },
  };
  export const app = Object.assign(new EventEmitter(), {
    isPackaged: false,
    getAppPath: () => "/tmp/pi-desktop-test",
    getLocale: () => "en",
    dock: { setIcon() {} },
    relaunch() {},
    quit() {},
  });
  export const net = {};
  export const session = { defaultSession: { setProxy: async () => {} } };
  export class BrowserWindow extends EventEmitter {
    static getAllWindows() { return []; }
    static fromWebContents() { return null; }
  }
  export const Menu = {
    setApplicationMenu() {},
    buildFromTemplate: (template) => template,
  };
  export const nativeImage = {
    createFromPath: () => ({ isEmpty: () => true }),
    createFromBuffer: () => ({ isEmpty: () => true }),
    createFromDataURL: () => ({ isEmpty: () => true }),
  };
  export const powerSaveBlocker = {
    start: () => 1,
    stop() {},
    isStarted: () => false,
  };
  export class Tray extends EventEmitter {}
  export const screen = {
    getPrimaryDisplay: () => ({
      id: 1,
      workArea: { x: 0, y: 0, width: 1440, height: 900 },
      bounds: { x: 0, y: 0, width: 1440, height: 900 },
    }),
    getDisplayMatching: () => ({
      id: 1,
      workArea: { x: 0, y: 0, width: 1440, height: 900 },
      bounds: { x: 0, y: 0, width: 1440, height: 900 },
    }),
    getAllDisplays: () => [],
  };
`)}`;
registerHooks({
  resolve(specifier, context, next) {
    return specifier === "electron" ? { url: electron, shortCircuit: true } : next(specifier, context);
  },
});
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

const { createApplicationLifecycle } = await import("../electron/main/bootstrap/app-lifecycle.ts");
const { registerApplicationActivation } = await import("../electron/main/bootstrap/app-activation.ts");
const { registerSettingsIpc } = await import("../electron/main/ipc/settings-ipc.ts");
const { app, nativeTheme } = await import("electron");
const { builtinWindowBackground, IPC } = await import("@pi-desktop/shared");


const windowSource = await readMainModule("bootstrap/window.ts");
const lifecycleSource = await readMainModule("bootstrap/app-lifecycle.ts");
const stylesSource = await loadStyles();
const hostPlatform = process.platform;

const createWindowSource = windowSource.slice(windowSource.indexOf("export async function createWindow("));
const mainWindowBlock =
  createWindowSource.match(/mainWindow = new BrowserWindow\(\{[\s\S]*?\n  \}\);/)?.[0] ?? "";
const macOptions =
  mainWindowBlock.match(
    /\.\.\.\(process\.platform === "darwin"[\s\S]*?\n      : \{[\s\S]*?\n        \}\),/,
  )?.[0] ?? "";

function styleBlock(selector) {
  return stylesSource.match(new RegExp(`${selector}\\s*\\{[^}]*\\}`))?.[0] ?? "";
}

function functionSource(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `expected function ${name}`);
  const next = source.indexOf("\n  function ", start + 1);
  return source.slice(start, next === -1 ? undefined : next);
}

function createLifecycle(t, { vibrancy = false, themes = [], platform = "darwin", applicationBooted = true } = {}) {
  Object.defineProperty(process, "platform", { configurable: true, value: platform });
  nativeTheme.themeSource = "system";
  nativeTheme.osDark = false;
  t.after(() => {
    Object.defineProperty(process, "platform", { configurable: true, value: hostPlatform });
    nativeTheme.themeSource = "system";
    nativeTheme.osDark = false;
  });
  const colors = [];
  const vibrancyCalls = [];
  let destroyed = false;
  let shown = 0;
  const window = {
    isDestroyed: () => destroyed,
    destroy() {
      destroyed = true;
    },
    show() {
      shown++;
    },
    focus() {},
    isMinimized() {
      return false;
    },
    restore() {},
    setBackgroundColor(color) {
      colors.push(color);
    },
    setVibrancy(kind) {
      vibrancyCalls.push(kind);
    },
  };
  const appearanceState = {
    updaterLocale: "en",
    pluginPanelTheme: "light",
    appThemePreference: "system",
    broadcastAppearanceSignature: "",
  };
  const state = {
    mainWindow: window,
    macosSidebarVibrancy: vibrancy,
    quitting: false,
    quitConfirmed: false,
    tray: null,
  };
  const appState = {
    windowCreationPromise: null,
    applicationBooted,
    pendingApplicationMenuCommands: [],
    appliedMenuSettings: null,
  };
  const lifecycle = createApplicationLifecycle({
    state,
    appState,
    appearanceState,
    dataDir: "/tmp/pi-desktop-test",
    isDevelopmentBuild: false,
    windowsAllowedToClose: new WeakSet(),
    windowMinWidth: 800,
    windowMinHeight: 560,
    windowBoundsSettleMs: 0,
    workPanelNativeResizeSettleMs: 0,
    applyWorkPanelReservation: () => ({ width: 0, xOffset: 0 }),
    markWorkPanelChatResizeActive() {},
    workPanelMinimumWindowWidth: () => 800,
    observedWorkPanelBaseBounds: () => null,
    classifyDisplayTransition: () => "none",
    sendToRenderer() {},
    safeOpenExternal: async () => {},
    showPluginLauncher: async () => {},
    askCloseBehavior: async () => null,
    applyCloseBehavior() {},
    browserHost: {},
    pluginViews: {},
    plugins: {
      getThemes: () => themes,
      broadcastEvent() {},
    },
    logger: { app() {} },
    refreshReleaseNotes() {},
    applyPluginLauncherShortcut() {},
    applyToggleWindowShortcut() {},
    broadcastPluginPanelEvent() {},
    getHost: () => null,
    getRunningSessionIds: () => [],
  });
  return { appearanceState, appState, colors, lifecycle, shown: () => shown, state, vibrancyCalls, window };
}

function createSettingsIpc(t, options) {
  const created = createLifecycle(t, options);
  let stored = { macosSidebarVibrancy: options?.vibrancy === true };
  const handlers = new Map();
  registerSettingsIpc({
    registrar: {
      ipcMain: {},
      handle(channel, fn) {
        handlers.set(channel, fn);
      },
      handleWithEvent() {},
      assertMainWindowSender() {},
    },
    getHost: () => ({
      call(method, payload) {
        if (method === "settings.get") return stored;
        stored = { ...stored, ...payload };
        return stored;
      },
    }),
    getSidecar: () => null,
    dataDir: "/tmp/pi-desktop-test",
    normalizeSettings: (settings) => settings,
    validateSettingsWrite: (settings) => settings,
    testNetworkProxy: async () => ({ ok: true }),
    applyNetworkProxyFromAppSettings: async () => ({}),
    currentNetworkProxy: () => ({ mode: "system" }),
    applyApplicationMenuSettings: created.lifecycle.applyApplicationMenuSettings,
    applyDeveloperMode() {},
    applyPreventScreenSleep() {},
    applyKeepAwakeWhileRunning() {},
    applyUpdatePreference() {},
    resolveEffectiveCommandShell: async () => ({}),
  });
  return {
    ...created,
    stored: () => stored,
    setSettings(settings) {
      return handlers.get(IPC.invoke.settingsSet)(settings);
    },
  };
}


test("macOS main window enables native sidebar vibrancy only in its platform branch", () => {
  assert.match(macOptions, /titleBarStyle:\s*"hiddenInset"/);
  // The position itself lives in @pi-desktop/shared so the renderer's reserve
  // for it (styles/tokens.css) is derived from the same numbers.
  assert.match(macOptions, /trafficLightPosition:\s*MAC_TRAFFIC_LIGHT_POSITION/);
  assert.match(macOptions, /vibrancy:\s*"sidebar"/);
  assert.match(macOptions, /visualEffectState:\s*"followWindow"/);
  assert.match(macOptions, /transparent:\s*true/);
  assert.match(macOptions, /backgroundColor:\s*"#00000000"/);
  assert.doesNotMatch(
    mainWindowBlock,
    /vibrancy:\s*"under-window"/,
    "non-mac branch must not set under-window vibrancy",
  );

  // The platform helper receives the built-in fallback selected from the
  // native theme. Windows paints it inside the rounded content surface;
  // Linux keeps its native window background behavior.
  assert.match(
    mainWindowBlock,
    /\.\.\.mainWindowBackgroundOptions\(process\.platform, initialWindowBackground\)/,
  );
  assert.match(
    windowSource,
    /const initialWindowBackground = builtinWindowBackground\(\s*nativeTheme\.shouldUseDarkColors \? "dark" : "light",?\s*\)/,
  );
  assert.match(mainWindowBlock, /frame: false/);
  assert.doesNotMatch(
    mainWindowBlock.replace(macOptions, ""),
    /vibrancy:\s*"sidebar"/,
    "sidebar vibrancy stays in the darwin branch",
  );
});

test("native theme source maps preferences including plugin bases", (t) => {
  const themes = [{ id: "plugin:demo", base: "dark" }];
  const { lifecycle } = createLifecycle(t, { themes });
  lifecycle.applyNativeThemeSource({ theme: "light" });
  assert.equal(nativeTheme.themeSource, "light");
  lifecycle.applyNativeThemeSource({ theme: "dark" });
  assert.equal(nativeTheme.themeSource, "dark");
  lifecycle.applyNativeThemeSource({ theme: "plugin:demo" });
  assert.equal(nativeTheme.themeSource, "dark");
  themes.splice(0);
  lifecycle.applyNativeThemeSource({ theme: "plugin:demo" });
  assert.equal(nativeTheme.themeSource, "system");
  lifecycle.applyAppThemePreference("light");
  assert.equal(nativeTheme.themeSource, "light");
});

test("unchanged native appearance does not overwrite a contributed opaque plate", (t) => {
  const themes = [{ id: "plugin:demo", base: "dark" }];
  const { lifecycle, colors, window } = createLifecycle(t, { themes });
  lifecycle.applyNativeThemeSource({ theme: "plugin:demo" });
  window.setBackgroundColor("#243040");
  lifecycle.applyNativeThemeSource({ theme: "plugin:demo" });
  assert.equal(nativeTheme.themeSource, "dark");
  assert.equal(colors.at(-1), "#243040");
});

test("sidebar vibrancy is only reapplied when the theme source changes", (t) => {
  const { lifecycle, colors, vibrancyCalls } = createLifecycle(t, { vibrancy: true });
  lifecycle.applyNativeThemeSource({ theme: "dark" });
  assert.equal(nativeTheme.themeSource, "dark");
  assert.deepEqual(vibrancyCalls, ["sidebar"]);
  lifecycle.applyNativeThemeSource({ theme: "dark" });
  assert.deepEqual(vibrancyCalls, ["sidebar"]);
  assert.deepEqual(colors, []);
});

test("a destroyed opaque window is left untouched", (t) => {
  const { lifecycle, colors, window } = createLifecycle(t, { vibrancy: false });
  window.destroy();
  lifecycle.applyNativeThemeSource({ theme: "dark" });
  assert.equal(nativeTheme.themeSource, "dark");
  assert.deepEqual(colors, []);
});

test("the macOS startup splash shares the sidebar glass tint and sheen", () => {
  const macGlassBlock =
    stylesSource.match(
      /:root\[data-platform="darwin"\] \.startup-splash,\n:root\[data-platform="darwin"\] \.sidebar-surface,\n:root\[data-platform="darwin"\] \.sidebar-rail\s*\{[^}]*\}/,
    )?.[0] ?? "";
  assert.match(macGlassBlock, /background-color:\s*var\(--ds-sidebar-glass-tint\)/);
  assert.match(macGlassBlock, /var\(--ds-sidebar-glass-sheen-top\)/);
  assert.match(macGlassBlock, /var\(--ds-sidebar-glass-sheen-bottom\)/);
  assert.doesNotMatch(macGlassBlock, /var\(--ds-bg-primary\)/);
  // Keep splash `position: fixed`; relative is only for the dock surfaces.
  assert.doesNotMatch(macGlassBlock, /position:\s*relative/);

  // Other platforms keep the opaque boot surface; the glass is darwin-only.
  const baseSplashBlock = stylesSource.match(/\n\.startup-splash\s*\{[^}]*\}/)?.[0] ?? "";
  assert.match(baseSplashBlock, /background:\s*var\(--ds-bg-primary\)/);
  assert.doesNotMatch(baseSplashBlock, /glass/);

  assert.match(
    stylesSource,
    /:root\[data-platform="darwin"\] \.app-shell\.is-booting:has\(\.startup-splash:not\(\.is-exiting\)\)\s*>\s*:not\(\.startup-splash\)\s*\{\s*visibility:\s*hidden;/,
  );
  assert.match(
    stylesSource,
    /:root\[data-platform="darwin"\] \.app-shell\.is-booting:has\(\.startup-splash\.is-exiting\)\s*>\s*:not\(\.startup-splash\)\s*\{\s*opacity:\s*1;\s*transition:\s*opacity/,
  );
});

test("only macOS sidebar and splash surfaces receive the translucent glass treatment", () => {
  const macGlassBlock =
    stylesSource.match(
      /:root\[data-platform="darwin"\] \.startup-splash,\n:root\[data-platform="darwin"\] \.sidebar-surface,\n:root\[data-platform="darwin"\] \.sidebar-rail\s*\{[^}]*\}/,
    )?.[0] ?? "";
  assert.match(macGlassBlock, /background-color:\s*var\(--ds-sidebar-glass-tint\)/);
  // Sheen, not a flat tint — this is what keeps the material reading as glass.
  assert.match(macGlassBlock, /var\(--ds-sidebar-glass-sheen-top\)/);
  assert.match(macGlassBlock, /var\(--ds-sidebar-glass-sheen-bottom\)/);
  // No dock seam on any platform (D297): neither the macOS glass rule nor the
  // base `.sidebar` rule draws a right edge, so the glass meets the opaque main
  // pane flush and no transparent override is needed.
  assert.doesNotMatch(macGlassBlock, /border-right/);
  const baseSidebarBlock = stylesSource.match(/\n\.sidebar\s*\{[^}]*\}/)?.[0] ?? "";
  assert.doesNotMatch(baseSidebarBlock, /border-right/);

  const macAncestorBlock =
    stylesSource.match(
      /:root\[data-platform="darwin"\],\n:root\[data-platform="darwin"\] body,\n:root\[data-platform="darwin"\] #root,\n:root\[data-platform="darwin"\] \.app-shell,\n:root\[data-platform="darwin"\] \.settings-shell\s*\{[^}]*\}/,
    )?.[0] ?? "";
  assert.match(macAncestorBlock, /background:\s*transparent/);

  const mainPaneBlock = styleBlock("\\.main-pane");
  const mainTitlebarBlock = styleBlock("\\.main-titlebar");
  const conversationTopbarBlock = styleBlock("\\.conversation-topbar");
  for (const block of [mainPaneBlock, mainTitlebarBlock, conversationTopbarBlock]) {
    assert.match(block, /background:\s*var\(--ds-bg-primary\)/);
    assert.doesNotMatch(block, /transparent/);
  }
});

test("the sidebar glass tint stays thin enough to reveal the vibrancy material", () => {
  // Slice at the @theme block so later partials cannot fake a token, and match
  // the light selector at a line start — the file header comment quotes it.
  const tokenSource = stylesSource.slice(0, stylesSource.indexOf("@theme {"));
  const lightIndex = /\n:root\[data-theme="light"\]\s*\{/.exec(tokenSource)?.index ?? -1;
  assert.ok(lightIndex > 0, "expected a light theme token block");
  const themes = {
    dark: tokenSource.slice(0, lightIndex),
    light: tokenSource.slice(lightIndex),
  };

  for (const [theme, block] of Object.entries(themes)) {
    for (const token of [
      "--ds-sidebar-glass-tint",
      "--ds-sidebar-glass-sheen-top",
      "--ds-sidebar-glass-sheen-bottom",
    ]) {
      assert.match(block, new RegExp(`${token}:`), `${theme} must define ${token}`);
    }
    const tint = block.match(
      /--ds-sidebar-glass-tint:\s*color-mix\(in oklab,\s*var\(--ds-bg-sidebar\)\s*(\d+)%,\s*transparent\)/,
    );
    assert.ok(tint, `${theme}: tint must derive from --ds-bg-sidebar`);
    assert.ok(
      Number(tint[1]) <= 60,
      `${theme}: tint ${tint[1]}% is too opaque for the material to show through`,
    );
  }
});

test("macOS can turn sidebar vibrancy off without changing the default", () => {
  assert.match(macOptions, /windowState\.macosSidebarVibrancy/);
  assert.match(macOptions, /vibrancy:\s*"sidebar"/);
  assert.match(macOptions, /transparent:\s*true/);
  const falseArm = macOptions.slice(macOptions.indexOf(": {"));
  assert.match(falseArm, /backgroundColor:\s*builtinWindowBackground\(/);
  assert.doesNotMatch(falseArm, /vibrancy:\s*"sidebar"/);
  assert.doesNotMatch(falseArm, /transparent:\s*true/);
});

test("a branded development host hands vibrancy restart to its dev owner before quitting", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-vibrancy-restart-"));
  const request = join(root, "restart.json");
  const previousRequest = process.env.PI_DESKTOP_DEV_RESTART_FILE;
  const previousDev = process.env.PI_DESKTOP_DEV;
  const previousPackaged = app.isPackaged;
  // The branded macOS development binary reports isPackaged=true.
  process.env.PI_DESKTOP_DEV = "1";
  app.isPackaged = true;
  process.env.PI_DESKTOP_DEV_RESTART_FILE = request;
  t.after(async () => {
    if (previousRequest === undefined) delete process.env.PI_DESKTOP_DEV_RESTART_FILE;
    else process.env.PI_DESKTOP_DEV_RESTART_FILE = previousRequest;
    if (previousDev === undefined) delete process.env.PI_DESKTOP_DEV;
    else process.env.PI_DESKTOP_DEV = previousDev;
    app.isPackaged = previousPackaged;
    await rm(root, { recursive: true, force: true });
  });
  const { lifecycle, state, window, vibrancyCalls } = createLifecycle(t, { vibrancy: true });
  let quitRan = false;
  let requestAtQuit;
  t.mock.method(app, "relaunch", () => assert.fail("dev must not orphan a native relaunch"));
  t.mock.method(app, "quit", () => {
    quitRan = true;
    requestAtQuit = readFile(request, "utf8");
  });
  lifecycle.applyApplicationMenuSettings({ macosSidebarVibrancy: false });
  assert.equal(state.macosSidebarVibrancy, false);
  assert.equal(state.quitConfirmed, true);
  assert.equal(quitRan, false);
  assert.equal(existsSync(request), true);
  assert.deepEqual(JSON.parse(await readFile(request, "utf8")), process.argv.slice(1));
  assert.equal(state.mainWindow, window);
  assert.equal(window.isDestroyed(), false);
  assert.deepEqual(vibrancyCalls, []);
  await new Promise(setImmediate);
  assert.equal(quitRan, true);
  assert.deepEqual(JSON.parse(await requestAtQuit), process.argv.slice(1));
});

test("startup and unchanged vibrancy settings do not request a restart", async (t) => {
  const { lifecycle, state } = createLifecycle(t, { vibrancy: true });
  t.mock.method(app, "relaunch", () => assert.fail("no restart before a live change"));
  t.mock.method(app, "quit", () => assert.fail("settings initialization must not quit"));
  lifecycle.applyApplicationMenuSettings({ macosSidebarVibrancy: true });
  await new Promise(setImmediate);
  assert.equal(state.quitConfirmed, false);
  state.mainWindow = null;
  lifecycle.applyApplicationMenuSettings({ macosSidebarVibrancy: false });
  await new Promise(setImmediate);
  assert.equal(state.macosSidebarVibrancy, false);
  assert.equal(state.quitConfirmed, false);
});

test("a failed restart-file write keeps live vibrancy retryable through settings IPC", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-vibrancy-restart-fail-"));
  const blocked = join(root, "missing", "restart.json");
  const request = join(root, "restart.json");
  const previousRequest = process.env.PI_DESKTOP_DEV_RESTART_FILE;
  const previousDev = process.env.PI_DESKTOP_DEV;
  const previousPackaged = app.isPackaged;
  process.env.PI_DESKTOP_DEV = "1";
  app.isPackaged = true;
  process.env.PI_DESKTOP_DEV_RESTART_FILE = blocked;
  t.after(async () => {
    if (previousRequest === undefined) delete process.env.PI_DESKTOP_DEV_RESTART_FILE;
    else process.env.PI_DESKTOP_DEV_RESTART_FILE = previousRequest;
    if (previousDev === undefined) delete process.env.PI_DESKTOP_DEV;
    else process.env.PI_DESKTOP_DEV = previousDev;
    app.isPackaged = previousPackaged;
    await rm(root, { recursive: true, force: true });
  });
  const { setSettings, stored, state, window } = createSettingsIpc(t, { vibrancy: true });
  let quitRan = false;
  t.mock.method(app, "relaunch", () => assert.fail("dev must not orphan a native relaunch"));
  t.mock.method(app, "quit", () => {
    quitRan = true;
  });
  await assert.rejects(() => setSettings({ macosSidebarVibrancy: false }), { code: "ENOENT" });
  assert.equal(stored().macosSidebarVibrancy, false);
  assert.equal(state.macosSidebarVibrancy, true);
  assert.equal(state.quitConfirmed, false);
  assert.equal(quitRan, false);
  assert.equal(state.mainWindow, window);
  assert.equal(window.isDestroyed(), false);

  process.env.PI_DESKTOP_DEV_RESTART_FILE = request;
  const result = await setSettings({ macosSidebarVibrancy: false });
  assert.equal(result.macosSidebarVibrancy, false);
  assert.equal(state.macosSidebarVibrancy, false);
  assert.equal(state.quitConfirmed, true);
  assert.equal(quitRan, false);
  assert.deepEqual(JSON.parse(await readFile(request, "utf8")), process.argv.slice(1));
  await new Promise(setImmediate);
  assert.equal(quitRan, true);
  assert.equal(window.isDestroyed(), false);
});

test("a packaged native host requests relaunch before quitting and does not rebuild the window", async (t) => {
  const previousRequest = process.env.PI_DESKTOP_DEV_RESTART_FILE;
  const previousDev = process.env.PI_DESKTOP_DEV;
  const previousPackaged = app.isPackaged;
  delete process.env.PI_DESKTOP_DEV;
  delete process.env.PI_DESKTOP_DEV_RESTART_FILE;
  app.isPackaged = true;
  t.after(() => {
    if (previousRequest === undefined) delete process.env.PI_DESKTOP_DEV_RESTART_FILE;
    else process.env.PI_DESKTOP_DEV_RESTART_FILE = previousRequest;
    if (previousDev === undefined) delete process.env.PI_DESKTOP_DEV;
    else process.env.PI_DESKTOP_DEV = previousDev;
    app.isPackaged = previousPackaged;
  });
  const { lifecycle, state, window } = createLifecycle(t, { vibrancy: true });
  let relaunchCalls = 0;
  let quitRan = false;
  t.mock.method(app, "relaunch", () => {
    relaunchCalls++;
  });
  t.mock.method(app, "quit", () => {
    quitRan = true;
  });
  lifecycle.applyApplicationMenuSettings({ macosSidebarVibrancy: false });
  assert.equal(relaunchCalls, 1);
  assert.equal(quitRan, false);
  assert.equal(state.macosSidebarVibrancy, false);
  assert.equal(state.quitConfirmed, true);
  assert.equal(state.mainWindow, window);
  assert.equal(window.isDestroyed(), false);
  await new Promise(setImmediate);
  assert.equal(quitRan, true);
  assert.equal(relaunchCalls, 1);
  assert.equal(window.isDestroyed(), false);
});

test("Windows and Linux vibrancy setting changes do not restart", async (t) => {
  t.mock.method(app, "relaunch", () => assert.fail("non-mac hosts must not relaunch"));
  t.mock.method(app, "quit", () => assert.fail("non-mac hosts must not quit"));
  for (const platform of ["win32", "linux"]) {
    const { lifecycle, state } = createLifecycle(t, { vibrancy: true, platform });
    lifecycle.applyApplicationMenuSettings({ macosSidebarVibrancy: false });
    await new Promise(setImmediate);
    assert.equal(state.macosSidebarVibrancy, false, platform);
    assert.equal(state.quitConfirmed, false, platform);
  }
});


test("early activation and second-instance wait for boot before restoring a window", async (t) => {
  const { lifecycle, appState, state, window, shown } = createLifecycle(t, {
    vibrancy: true,
    applicationBooted: false,
  });
  t.after(() => app.removeAllListeners());
  let restores = 0;
  registerApplicationActivation({
    restoreMainWindow: () => {
      restores++;
      lifecycle.restoreMainWindow();
    },
    isQuitting: () => state.quitting,
    isApplicationBooted: () => appState.applicationBooted,
    hasVisibleWindow: lifecycle.hasVisibleWindow,
  });
  state.mainWindow = null;
  app.emit("activate");
  app.emit("second-instance");
  await new Promise(setImmediate);
  assert.equal(restores, 0);
  assert.equal(state.mainWindow, null);
  assert.equal(shown(), 0);
  assert.equal(state.macosSidebarVibrancy, true);

  appState.applicationBooted = true;
  state.mainWindow = window;
  app.emit("activate");
  await new Promise(setImmediate);
  assert.equal(restores, 1);
  assert.equal(shown(), 1);
  assert.equal(state.mainWindow, window);
  app.emit("second-instance");
  await new Promise(setImmediate);
  assert.equal(restores, 2);
  assert.equal(shown(), 2);
  assert.equal(window.isDestroyed(), false);
});

