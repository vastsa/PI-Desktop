const { app, BrowserWindow, screen } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Host } = require("SNAP_HOST_HELPER");
const { installWindowsNativeSnap } = require("SNAP_WINDOW_MODULE");
const { installWindows11CornerController, usesWindows11NativeCorners } = require("SNAP_CORNERS_MODULE");
const { isWindowFullScreen, setWindowFullScreen } = require("SNAP_FULLSCREEN_MODULE");
const { installWindowShape } = require("SNAP_SHAPE_MODULE");

const root = __dirname;
const options = JSON.parse(fs.readFileSync(path.join(root, "options.json"), "utf8"));
const baseline = process.argv.includes("--baseline");
let host;
let window;
let timer;
let snap;
let corners;
let quitting = false;
const logger = { app: (...args) => console.error(...args) };
const resolve = (name) => path.isAbsolute(name) ? name : path.join(root, name);
const publish = (name, value) => {
  const destination = path.join(root, name);
  fs.writeFileSync(destination + ".tmp", JSON.stringify(value));
  fs.renameSync(destination + ".tmp", destination);
};

app.whenReady().then(async () => {
  const legacySurface = options.legacySurface || !usesWindows11NativeCorners(process.platform, process.getSystemVersion());
  host = new Host(resolve(options.hostBinary), path.join(root, baseline ? "host-baseline" : "host-candidate"), {
    env: { PI_DESKTOP_ELECTRON_PID: String(process.pid) }, quiet: true,
  });
  await host.start();
  window = new BrowserWindow({
    x: 200, y: 140, width: 1200, height: 800,
    minWidth: options.minWidth, minHeight: options.minHeight,
    frame: false, thickFrame: false, resizable: true, show: false,
    transparent: legacySurface, backgroundColor: legacySurface ? "#00000000" : "#181818",
    title: "Native Snap Regression", webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  const nativeHandle = window.getNativeWindowHandle().readBigUInt64LE().toString();
  await assert.rejects(host.call("window.enableNativeSnap", { nativeHandle: "0", ownerPid: process.pid }),
    (error) => error.errorCode === "INVALID_PARAMS");
  await assert.rejects(host.call("window.enableNativeSnap", { nativeHandle, ownerPid: process.pid + 1 }),
    (error) => error.errorCode === "UNAUTHORIZED");
  const foreignHandle = process.argv.find((arg) => arg.startsWith("--foreign-handle="))?.split("=")[1];
  assert.ok(foreignHandle);
  await assert.rejects(host.call("window.enableNativeSnap", { nativeHandle: foreignHandle, ownerPid: process.pid }),
    (error) => error.errorCode === "INTERNAL");
  if (!baseline) snap = await installWindowsNativeSnap(window, () => host, logger);
  if (legacySurface) installWindowShape(window, 12, screen);
  else corners = await installWindows11CornerController(window, 12, () => host, screen, logger);
  window.webContents.on("page-title-updated", (event) => event.preventDefault());
  await window.loadURL("data:text/html," + encodeURIComponent(`<style>
    html,body{margin:0;width:100%;height:100%;overflow:hidden;background:linear-gradient(90deg,#f6f6f6 50%,#181818 50%)}
    header{height:46px;-webkit-app-region:drag;background:#7f7f7f}
  </style><header></header>`));
  window.setTitle("Native Snap Regression");
  window.show(); window.focus();
  const snapshot = () => ({ processId: process.pid, title: window.getTitle(), nativeHandle,
    systemVersion: process.getSystemVersion(), electronVersion: process.versions.electron, legacySurface,
    workArea: screen.getDisplayMatching(window.getBounds()).workArea,
    displayBounds: screen.getDisplayMatching(window.getBounds()).bounds,
    maximized: window.isMaximized(), fullscreen: isWindowFullScreen(window),
    scaleFactor: screen.getDisplayMatching(window.getBounds()).scaleFactor });
  const flush = async () => { if (snap) await snap.flush(); if (corners) await corners.flush(); };
  await flush();
  publish("ready.json", snapshot());
  let active = false;
  timer = setInterval(async () => {
    const file = path.join(root, "command.json");
    if (active || !fs.existsSync(file)) return;
    active = true;
    try {
      const command = JSON.parse(fs.readFileSync(file, "utf8")); fs.unlinkSync(file);
      if (command.action === "quit") { app.quit(); return; }
      if (command.action === "reset") {
        if (isWindowFullScreen(window)) setWindowFullScreen(window, false, true);
        if (window.isMaximized()) window.unmaximize();
        window.setBounds({ x: 200, y: 140, width: 1200, height: 800 }); window.focus();
      }
      if (command.action === "maximize") window.maximize();
      if (command.action === "unmaximize") window.unmaximize();
      if (command.action === "minimize") window.minimize();
      if (command.action === "restore") window.restore();
      if (command.action === "fullscreen") setWindowFullScreen(window, command.value, true);
      await new Promise((done) => setTimeout(done, 500));
      await flush();
      publish("state.json", { ...snapshot(), id: command.id });
    } catch (error) {
      fs.writeFileSync(path.join(root, "fixture-error.txt"), String(error.stack || error));
    } finally { active = false; }
  }, 25);
}).catch(async (error) => {
  fs.writeFileSync(path.join(root, "fixture-error.txt"), String(error.stack || error));
  if (host) await host.stop().catch((cleanupError) => console.error("fixture Host cleanup failed", cleanupError));
  app.exit(1);
});

app.on("before-quit", (event) => {
  if (quitting) return;
  event.preventDefault(); quitting = true; clearInterval(timer);
  void (async () => {
    try { if (host) await host.stop(); app.exit(0); }
    catch (error) { console.error("fixture Host cleanup failed", error); app.exit(1); }
  })();
});
app.on("window-all-closed", () => app.quit());
