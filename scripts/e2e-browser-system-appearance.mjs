#!/usr/bin/env node
/** Opt-in macOS appearance acceptance; restore the original OS setting. */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { resolveElectronBinary } from "./e2e/boot.mjs";

assert.equal(process.platform, "darwin", "This acceptance uses macOS System Events");
assert.equal(process.env.PI_E2E_SYSTEM_APPEARANCE, "1", "Set PI_E2E_SYSTEM_APPEARANCE=1 to allow temporary OS appearance changes");
const root = resolve(import.meta.dirname, "..");
const osScript = source => execFileSync("osascript", ["-e", 'tell application "System Events" to tell appearance preferences to ' + source], { encoding: "utf8" }).trim();
const original = osScript("get dark mode");
assert.ok(original === "true" || original === "false");
const temp = await mkdtemp(join(tmpdir(), "pi-browser-appearance-"));
try {
  await writeFile(join(temp, "preload.cjs"), `
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("pluginBridge", {
  on: (name, callback) => ipcRenderer.on(name, (_event, value) => callback(value)),
  invoke: name => ipcRenderer.invoke("appearance-probe", name),
});
`);
  await build({
    stdin: { sourcefile: "appearance-main.ts", loader: "ts", resolveDir: root, contents: `
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { app, BrowserWindow, ipcMain, nativeTheme } from "electron";
import { createApplicationLifecycle } from "./apps/desktop/electron/main/bootstrap/app-lifecycle";
app.setPath("userData", ${JSON.stringify(join(temp, "profile"))});
app.on("window-all-closed", () => {});
app.whenReady().then(async () => {
  const initialListeners = nativeTheme.listenerCount("updated");
  let window;
  const appearanceState = { appThemePreference: "system", pluginPanelTheme: "light", updaterLocale: "en", broadcastAppearanceSignature: "" };
  const theme = { id: "plugin:fixture/midnight", base: "dark", css: "" };
  const lifecycle = createApplicationLifecycle({
    state: { quitting: false }, appState: {}, appearanceState,
    plugins: { getThemes: () => [theme], broadcastEvent() {} }, logger: { app() {} },
    getHost: () => null, getRunningSessionIds: () => [],
    broadcastPluginPanelEvent: (name, payload) => window?.webContents.send(name, payload),
  } as any);
  ipcMain.handle("appearance-probe", (_event, name) => name === "app.getAppearance" ? lifecycle.resolveAppearance() : null);
  const open = async () => {
    window = new BrowserWindow({ show: false, width: 800, height: 500, webPreferences: {
      sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
      preload: ${JSON.stringify(join(temp, "preload.cjs"))},
    } });
    await window.loadFile(${JSON.stringify(join(root, "apps/desktop/resources/plugins/pi.browser/views/browser.html"))});
  };
  const waitFor = async check => {
    const deadline = Date.now() + 10000;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error("appearance did not propagate within ten seconds");
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  };
  const setOS = dark => execFileSync("osascript", ["-e", 'tell application "System Events" to tell appearance preferences to set dark mode to ' + dark]);
  const sample = () => window.webContents.executeJavaScript('({base:document.documentElement.dataset.base,background:getComputedStyle(document.querySelector(".chrome")).backgroundColor})');
  try {
    await open();
    lifecycle.applyAppThemePreference("system");
    const samples = [];
    for (const dark of [false, true, false]) {
      setOS(dark);
      await waitFor(async () => nativeTheme.shouldUseDarkColors === dark && (await sample()).base === (dark ? "dark" : "light"));
      assert.equal(appearanceState.pluginPanelTheme, dark ? "dark" : "light");
      samples.push(await sample());
    }
    assert.notEqual(samples[0].background, samples[1].background);
    assert.equal(samples[0].background, samples[2].background);
    for (const preference of ["light", "dark", theme.id]) {
      lifecycle.applyAppThemePreference(preference);
      const expected = preference === "light" ? "light" : "dark";
      await waitFor(async () => (await sample()).base === expected);
      for (const dark of [true, false]) {
        setOS(dark);
        assert.equal((await sample()).base, expected);
      }
    }
    lifecycle.applyAppThemePreference("system");
    window.destroy();
    await open();
    await waitFor(async () => (await sample()).base === (nativeTheme.shouldUseDarkColors ? "dark" : "light"));
    app.on("will-quit", () => {
      assert.equal(nativeTheme.listenerCount("updated"), initialListeners);
      console.log("BROWSER_SYSTEM_APPEARANCE " + JSON.stringify({ ok: true, samples, fixedPalettes: 3, reopened: true, listenerRemoved: true }));
    });
    app.quit();
  } catch (error) { console.error(error.stack); app.exit(1); }
});
` },
    outfile: join(temp, "main.cjs"), bundle: true, platform: "node", format: "cjs", external: ["electron"],
  });
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  for (let restart = 0; restart < 2; restart += 1) {
    const child = spawn(resolveElectronBinary(root).electronBinary, [join(temp, "main.cjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { output += chunk; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 60000);
    let code;
    try { code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); }); }
    finally { clearTimeout(timer); }
    assert.equal(code, 0, output);
    assert.match(output, /BROWSER_SYSTEM_APPEARANCE .*"ok":true/);
    console.log(output.trim());
  }
} finally {
  osScript("set dark mode to " + original);
  await rm(temp, { recursive: true, force: true });
}
