import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

const mainSource = await readFile(
  new URL("../electron/main/index.ts", import.meta.url),
  "utf8",
);
const menuSource = await readFile(
  new URL("../electron/main/application-menu.ts", import.meta.url),
  "utf8",
);
const shortcutSource = await readFile(
  new URL("../../../packages/shared/src/keyboard-shortcuts.ts", import.meta.url),
  "utf8",
);
const appSource = await readFile(
  new URL("../src/App.tsx", import.meta.url),
  "utf8",
);
const stylesSource = await loadStyles();
const controlsSource = await readFile(
  new URL("../src/components/WindowControls.tsx", import.meta.url),
  "utf8",
);
const protocolSource = await readFile(
  new URL("../../../packages/shared/src/protocol.ts", import.meta.url),
  "utf8",
);
const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const iconScriptSource = await readFile(
  new URL("../../../scripts/make-icon.py", import.meta.url),
  "utf8",
);

test("macOS installs a standard application menu before window creation", () => {
  assert.match(menuSource, /label:\s*APP_NAME/);
  for (const role of [
    "about",
    "services",
    "hide",
    "hideOthers",
    "unhide",
    "quit",
  ]) {
    assert.match(menuSource, new RegExp(`role: "${role}"`));
  }
  for (const topLevel of ["file", "edit", "view", "window"]) {
    assert.match(menuSource, new RegExp(`label: labels\\.menu\\.${topLevel}`));
  }
  assert.match(menuSource, /role:\s*"help"/);
  assert.match(menuSource, /resolveLocale\(locale\)/);
  assert.match(mainSource, /app\.setName\(APP_NAME\)/);
  assert.match(mainSource, /locale:\s*app\.getLocale\(\)/);
  assert.match(menuSource, /Menu\.buildFromTemplate\(template\)/);
  assert.match(menuSource, /Menu\.setApplicationMenu/);
  assert.match(
    menuSource,
    /options\.platform \?\? process\.platform\) !== "darwin"/,
  );
  assert.match(menuSource, /Menu\.setApplicationMenu\(null\)/);
  assert.match(
    mainSource,
    /installApplicationMenu\(\{\s+locale: app\.getLocale\(\),\s+dispatch: dispatchApplicationMenuCommand,\s+\}\);/,
  );
  assert.ok(
    mainSource.indexOf("prewarmPluginLauncher();") < mainSource.indexOf("registerIpc();"),
    "launcher warm-up should start before IPC registration completes",
  );
});

test("macOS application menu routes shell commands and preserves native roles", () => {
  for (const [id, binding] of [
    ["openSettings", "Mod+Comma"],
    ["newTask", "Mod+N"],
    ["openProject", "Mod+O"],
    ["openSearch", "Mod+K"],
    ["toggleSidebar", "Mod+B"],
  ]) {
    assert.match(menuSource, new RegExp(`accelerator\\("${id}"\\)`));
    assert.match(shortcutSource, new RegExp(`defaultBinding: "${binding.replace("+", "\\+")}"`));
  }
  for (const role of [
    "undo",
    "redo",
    "cut",
    "copy",
    "paste",
    "selectAll",
    "reload",
    "resetZoom",
    "zoomIn",
    "zoomOut",
    "togglefullscreen",
  ]) {
    assert.match(menuSource, new RegExp(`role: "${role}"`));
  }
  assert.match(mainSource, /IPC\.event\.menuCommand/);
  assert.match(mainSource, /APP_MENU_COMMANDS\.includes\(command\)/);
  assert.doesNotMatch(menuSource, /CmdOrCtrl\+J|toggleWorkPanel/);
  assert.doesNotMatch(protocolSource, /"toggleWorkPanel"/);
});

test("developer mode gates every devtools entry point in the main process", () => {
  assert.match(menuSource, /developerMode = false/);
  assert.match(
    menuSource,
    /\.\.\.\(developerMode[\s\S]*role: "toggleDevTools"/,
  );
  assert.match(mainSource, /let developerMode = false/);
  assert.match(mainSource, /function applyDeveloperMode/);
  assert.match(
    mainSource,
    /if \(!next[\s\S]*isDevToolsOpened\(\)[\s\S]*closeDevTools\(\)/,
  );
  assert.match(
    mainSource,
    /before-input-event[\s\S]*!developerMode[\s\S]*input\.code === "F12"/,
  );
  assert.match(
    mainSource,
    /process\.platform !== "darwin"[\s\S]*input\.control[\s\S]*input\.shift/,
  );
  assert.match(protocolSource, /devtoolsToggle:\s*"pi-desktop\/devtools\/toggle"/);
  const handler = mainSource.slice(mainSource.indexOf("IPC.invoke.devtoolsToggle"));
  assert.ok(
    handler.indexOf("!developerMode") < handler.indexOf("openDevTools"),
    "the IPC gate must run before opening devtools",
  );
});

test("Windows and Linux use menu-free frameless chrome with window controls", () => {
  assert.match(
    mainSource,
    /process\.platform === "darwin"[\s\S]*titleBarStyle:\s*"hiddenInset"[\s\S]*frame:\s*false/,
  );
  assert.doesNotMatch(appSource, /DesktopMenuBar/);
  assert.doesNotMatch(stylesSource, /\.desktop-menu-/);
  assert.match(appSource, /platform as ShortcutPlatform/);
  assert.match(appSource, /resolveKeybinding/);
  for (const id of ["newTask", "openProject", "openSettings"]) {
    assert.match(appSource, new RegExp(`case "${id}"`));
  }
  assert.match(appSource, /runMenuCommand\(id\)/);
  for (const id of ["resetZoom", "toggleFullScreen"]) {
    assert.match(appSource, new RegExp(`case "${id}"`));
  }
  assert.match(appSource, /nativeMenuAction\(id\)/);
  assert.match(controlsSource, /windowControl\("getState"\)/);
  assert.match(controlsSource, /aria-label=\{t\("window\.minimize"/);
  assert.match(controlsSource, /aria-label=\{t\("window\.close"/);
  assert.match(controlsSource, /window-controls-in-pane/);
  assert.match(
    appSource,
    /<section className="main-pane">[\s\S]*?<WindowControls contained \/>/,
  );
  assert.match(
    stylesSource,
    /\.window-controls\.window-controls-in-pane\s*\{[^}]*position:\s*absolute;/s,
  );
  assert.match(
    stylesSource,
    /\.window-control-btn\s*\{[^}]*-webkit-app-region:\s*no-drag;[^}]*pointer-events:\s*auto;/s,
  );
  assert.match(
    stylesSource,
    /\.window-controls\s*\{[^}]*-webkit-app-region:\s*no-drag;[^}]*pointer-events:\s*auto;[^}]*width:\s*var\(--ds-window-controls-width\);/s,
  );
  assert.match(
    stylesSource,
    /\.window-controls\s*\{[^}]*height:\s*var\(--ds-toolbar-height\)[^}]*padding-left:\s*8px;[^}]*background:\s*var\(--ds-bg-primary\);[^}]*border-bottom:\s*1px solid var\(--ds-border-subtle\);[^}]*border-left:\s*1px solid var\(--ds-border-subtle\);/s,
  );
  assert.match(stylesSource, /--ds-window-controls-width:\s*120px;/);
  assert.match(
    stylesSource,
    /:root\[data-platform="win32"\] \.main-titlebar,[\s\S]*:root\[data-platform="linux"\] \.settings-titlebar\s*\{[^}]*right:\s*var\(--ds-window-controls-width\);/,
  );
  assert.match(
    stylesSource,
    /:root\[data-platform="win32"\] \.main-titlebar\.work-panel-open,[\s\S]*:root\[data-platform="linux"\] \.main-titlebar\.work-panel-open\s*\{[^}]*right:\s*var\(--ds-window-controls-width\);/,
  );
  assert.doesNotMatch(stylesSource, /\.work-panel-header\s*\{[^}]*margin-right:/s);
  assert.match(
    stylesSource,
    /:root\[data-platform="(win32|linux)"\] \.thread-content[\s\S]*?padding-top:\s*var\(--ds-toolbar-height\);/,
  );
  assert.match(
    stylesSource,
    /\.toast\s*\{[^}]*-webkit-app-region:\s*no-drag;[^}]*pointer-events:\s*auto;/s,
  );
  assert.match(mainSource, /window\.on\("maximize", sendMaximized\)/);
  assert.match(
    mainSource,
    /window\.on\("unmaximize", \(\) => \{[\s\S]*process\.platform !== "darwin"[\s\S]*scheduleWorkPanelReservation\(\)/,
  );
  assert.match(
    mainSource,
    /window\.on\("leave-full-screen", \(\) => \{[\s\S]*scheduleWorkPanelReservation\(\)/,
  );
  assert.match(mainSource, /window\.webContents\.isDestroyed\(\)/);
  assert.match(mainSource, /mainWindow = null/);
  assert.match(mainSource, /windowCreationPromise/);
  assert.match(mainSource, /pendingApplicationMenuCommands/);
  assert.match(protocolSource, /menuRendererReady:\s*"pi-desktop\/menu\/rendererReady"/);
  assert.match(mainSource, /waitForMenuRenderer\(window\)/);
  assert.doesNotMatch(
    mainSource.slice(
      mainSource.indexOf("async function deliverApplicationMenuCommand"),
      mainSource.indexOf("function dispatchApplicationMenuCommand"),
    ),
    /setTimeout/,
  );
  assert.match(
    mainSource,
    /PI_DESKTOP_START_MAXIMIZED[\s\S]*window\.maximize\(\)/,
  );
});

test("menu and window IPC reject actions outside their shared allowlists", () => {
  assert.match(protocolSource, /export const APP_MENU_COMMANDS/);
  assert.match(protocolSource, /export const NATIVE_MENU_ACTIONS/);
  assert.match(protocolSource, /export const WINDOW_CONTROL_ACTIONS/);
  assert.match(protocolSource, /nativeMenuAction:\s*"pi-desktop\/menu\/nativeAction"/);
  assert.match(protocolSource, /menuCommand:\s*"pi-desktop\/menu\/event\/command"/);
  assert.match(mainSource, /NATIVE_MENU_ACTIONS\.includes/);
  assert.match(mainSource, /WINDOW_CONTROL_ACTIONS\.includes/);
  assert.match(mainSource, /throw new Error\("unsupported native menu action"\)/);
  assert.match(mainSource, /throw new Error\("unsupported window control action"\)/);

  const windowControlBlock = mainSource.slice(
    mainSource.indexOf("IPC.invoke.windowControl"),
    mainSource.indexOf("IPC.invoke.nativeMenuAction"),
  );
  assert.ok(
    windowControlBlock.indexOf("WINDOW_CONTROL_ACTIONS.includes") <
      windowControlBlock.indexOf("!mainWindow"),
    "window actions must be validated before the no-window return",
  );
});

test("Windows/Linux explicit minimize paths use the native taskbar", () => {
  assert.match(mainSource, /import \{[\s\S]*Tray[\s\S]*\} from "electron"/);
  assert.match(mainSource, /function createTray\(\)/);
  assert.match(mainSource, /join\(resourceRoot, "tray-icon-mac\.png"\)/);
  assert.match(mainSource, /icon\.setTemplateImage\(true\)/);
  assert.match(mainSource, /tray\.on\("click", restoreMainWindow\)/);
  assert.match(mainSource, /tray\.on\("double-click", restoreMainWindow\)/);
  assert.match(
    mainSource,
    /window\.on\("minimize", \(\) => \{[\s\S]*process\.platform !== "darwin"\) return;[\s\S]*window\.hide\(\)/,
  );
  assert.match(mainSource, /tray\?\.destroy\(\)/);
  assert.match(mainSource, /case "minimize":\s*window\.minimize\(\)/);
  const nativeMenuBlock = mainSource.slice(
    mainSource.indexOf("IPC.invoke.nativeMenuAction"),
  );
  assert.match(nativeMenuBlock, /case "minimize":\s*window\.minimize\(\)/);
  const trayResource = packageJson.build.extraResources.find(
    (resource) => resource.to === "tray-icon.png",
  );
  assert.deepEqual(trayResource, {
    from: "build/icon.png",
    to: "tray-icon.png",
  });
  assert.deepEqual(packageJson.build.mac.extraResources, [
    {
      from: "../../target/release/pi-desktop-host-core",
      to: "bin/pi-desktop-host-core",
    },
    {
      from: "build/tray-icon-mac.png",
      to: "tray-icon-mac.png",
    },
  ]);
  assert.match(iconScriptSource, /tray-icon-mac\.png/);
  assert.match(iconScriptSource, /ImageChops\.multiply/);
});

test("Windows taskbar minimize keeps the taskbar entry", () => {
  const minimizeHandler = mainSource.slice(
    mainSource.indexOf('window.on("minimize"'),
    mainSource.indexOf('window.on("minimize"') + 420,
  );
  assert.match(
    minimizeHandler,
    /if \(quitting \|\| !tray \|\| process\.platform !== "darwin"\) return;/,
  );
  assert.match(
    mainSource,
    /function restoreMainWindow\(\)[\s\S]*if \(window\.isMinimized\(\)\) window\.restore\(\);[\s\S]*window\.focus\(\);/,
  );
  assert.match(
    mainSource,
    /IPC\.invoke\.windowControl[\s\S]*case "minimize":\s*window\.minimize\(\)/,
  );
});

test("macOS activation resurfaces a tray-hidden window", () => {
  assert.match(mainSource, /app\.on\("activate", \(\) => \{\s*restoreMainWindow\(\);/);
  assert.match(
    mainSource,
    /app\.on\("did-become-active", \(\) => \{[\s\S]*restoreMainWindow\(\);/,
  );
  assert.match(
    mainSource,
    /if \(quitting \|\| !applicationBooted \|\| hasVisibleWindow\(\)\) return;/,
  );
  assert.match(
    mainSource,
    /function hasVisibleWindow\(\): boolean \{[\s\S]*BrowserWindow\.getAllWindows\(\)[\s\S]*window\.isVisible\(\)/,
  );
});

test("desktop packaging builds the native host before every local target", () => {
  assert.match(
    packageJson.scripts["build:host-release"],
    /cargo build --release .* -p host-core/,
  );
  for (const name of ["pack", "dist", "dist:mac", "dist:win", "dist:linux"]) {
    const script = packageJson.scripts[name];
    assert.match(script, /pnpm run build:host-release/);
    assert.ok(
      script.indexOf("pnpm run build:host-release") < script.indexOf("electron-builder"),
      `${name} must build the native host before electron-builder packages it`,
    );
  }
  assert.equal(packageJson.build.win.extraResources[0].to, "bin/pi-desktop-host-core.exe");
  assert.equal(packageJson.build.linux.extraResources[0].to, "bin/pi-desktop-host-core");
  assert.equal(packageJson.build.mac.extraResources[0].to, "bin/pi-desktop-host-core");
  assert.match(iconScriptSource, /package_icon = BUILD \/ "icon\.png"/);
  assert.match(iconScriptSource, /shutil\.which\("iconutil"\)/);
});
