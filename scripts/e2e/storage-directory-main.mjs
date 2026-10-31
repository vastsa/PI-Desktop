import assert from "node:assert/strict";
import { app, BrowserWindow, dialog, ipcMain, session } from "electron";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { prepareStorage } from "../../apps/desktop/electron/main/storage/bootstrap.ts";
import { registerStorageIpc } from "../../apps/desktop/electron/main/storage/ipc.ts";

const config = JSON.parse(process.env.PI_STORAGE_E2E_CONFIG);
app.setPath("userData", config.anchor);
if (!app.requestSingleInstanceLock()) throw new Error("Isolated fixture lock unavailable");
let window;
const result = { errors: [] };
const originalExit = app.exit.bind(app);
app.relaunch = () => { result.relaunched = true; };
dialog.showMessageBox = async (...args) => { result.errors.push(args.at(-1).detail); return { response: 0 }; };
app.exit = (code = 0) => {
  void (async () => {
    if (window && !window.isDestroyed()) {
      result.visibleText = await window.webContents.executeJavaScript("document.body.innerText");
      await window.webContents.executeJavaScript("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
      writeFileSync(join(config.directory, config.mode + ".png"), (await window.webContents.capturePage()).toPNG());
    }
    writeFileSync(config.result, JSON.stringify(result));
    originalExit(code);
  })().catch(error => { console.error(error); originalExit(1); });
};
app.on("browser-window-created", (_event, created) => {
  window = created;
  created.webContents.setBackgroundThrottling(false);
});

async function pointer(selector, last = false) {
  window.show();
  window.focus();
  window.webContents.focus();
  await window.webContents.executeJavaScript("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  const position = await window.webContents.executeJavaScript("(() => { const nodes = document.querySelectorAll(" + JSON.stringify(selector) + "); const b=nodes[" + (last ? "nodes.length-1" : "0") + "]; if (!b || b.disabled) throw new Error('Button unavailable'); b.scrollIntoView({block:'center'}); const r=b.getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}; })()");
  window.webContents.sendInputEvent({ type: "mouseMove", ...position });
  window.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...position });
  window.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...position });
}

void (async () => {
  const storage = await prepareStorage(config.data, false);
  await app.whenReady();
  result.roots = storage.preferences.roots;
  window = new BrowserWindow({ show: true, width: 1050, height: 760, title: "PI Storage Migration Test",
    webPreferences: { preload: join(config.artifacts, "preload.cjs"), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [config.target] });
  let finish;
  const scheduled = new Promise(resolve => { finish = resolve; });
  registerStorageIpc({ registrar: {
    assertMainWindowSender: event => assert.equal(event.sender, window.webContents),
    handleWithEvent: (channel, handler) => ipcMain.handle(channel, async (event, input) => {
      try { return { ok: true, data: await handler(event, input) }; }
      catch (error) { return { ok: false, error: { code: "STORAGE", message: error.message } }; }
    }),
  }, getMainWindow: () => window, restart: () => finish() });
  await window.loadFile(join(config.artifacts, "index.html"));
  await window.webContents.executeJavaScript('window.storageDirectoryWait("ready")');
  if (config.mode === "inspect" || config.mode === "inspect-backup") {
    result.browserState = await window.webContents.executeJavaScript('localStorage.getItem("migration-fixture")');
    result.sessionData = app.getPath("sessionData");
    if (config.mode === "inspect-backup") {
      assert.equal(storage.preferences.backups.length, 0);
      assert.equal(storage.preferences.lastError, undefined);
      assert.equal(await window.webContents.executeJavaScript('document.querySelectorAll(".settings-storage .settings-row-control button").length'), 2);
      result.backupControlRemoved = true;
    }
    app.exit(0); return;
  }
  await window.webContents.executeJavaScript('localStorage.setItem("migration-fixture","browser state survives restart")');
  if (config.mode === "backup") {
    assert.equal(storage.preferences.backups.length, 1);
    assert.equal(app.hasSingleInstanceLock(), true);
    if (process.platform === "win32") assert(existsSync(join(config.anchor, "lockfile")));
  }
  await pointer(".settings-storage .settings-row-control button", config.mode === "backup");
  await window.webContents.executeJavaScript('window.storageDirectoryWait("confirmation")');
  writeFileSync(join(config.directory, "confirmation.png"), (await window.webContents.capturePage()).toPNG());
  await pointer(".settings-storage-actions button", true);
  await scheduled;
  session.defaultSession.flushStorageData();
  result.scheduled = true;
  app.exit(0);
})().catch(error => { console.error(error); result.errors.push(error.message); app.exit(1); });
