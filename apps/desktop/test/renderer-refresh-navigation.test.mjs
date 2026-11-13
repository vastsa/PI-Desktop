import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

test("packaged file refresh crosses the production navigation guard, restores drafts, and still blocks external navigation", { timeout: 70_000 }, async () => {
  const root = repositoryRoot();
  const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");
  const temp = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "refresh-navigation-"));
  try {
    await build({ entryPoints: [join(root, "apps/desktop/test/e2e/renderer-refresh/navigation-fixture.tsx")],
      outfile: join(temp, "renderer.js"), bundle: true, platform: "browser", format: "esm", jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"' },
      alias: { "@pi-desktop/i18n": join(root, "packages/i18n/src"), "@pi-desktop/shared": join(root, "packages/shared/src"),
        react: join(root, "apps/desktop/node_modules/react"), "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
        i18next: join(root, "apps/desktop/node_modules/i18next"), "react-i18next": join(root, "apps/desktop/node_modules/react-i18next") },
      nodePaths: [join(root, "apps/desktop/node_modules")], loader: { ".svg": "dataurl", ".png": "dataurl" } });
    await build({ entryPoints: [join(root, "apps/desktop/electron/main/app-shell-navigation.ts")],
      outfile: join(temp, "guard.cjs"), bundle: true, platform: "node", format: "cjs", external: ["electron"] });
    await writeFile(join(temp, "index.html"), '<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module" src="renderer.js"></script>');
    await writeFile(join(temp, "main.cjs"), `
const { app, BrowserWindow } = require("electron");
const assert = require("node:assert/strict");
const path = require("node:path");
const { registerAppShellNavigationGuard } = require("./guard.cjs");
app.setPath("userData", path.join(__dirname, "profile"));
app.disableHardwareAcceleration();
const watchdog = setTimeout(() => { console.error("Refresh navigation deadline exceeded"); app.exit(1); }, 45_000);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true,
    nodeIntegration: false, backgroundThrottling: false } });
  let blocked;
  registerAppShellNavigationGuard(win.webContents, { onBlocked: url => blocked?.(new Error("Production guard blocked: " + url)) });
  const ready = () => win.webContents.executeJavaScript("new Promise(resolve => { const check = () => window.refreshNavigationProbe ? resolve() : requestAnimationFrame(check); check(); })");
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    await ready();
    const url = win.webContents.getURL();
    const reloaded = new Promise((resolve, reject) => {
      blocked = reject;
      win.webContents.once("did-finish-load", resolve);
    });
    void win.webContents.executeJavaScript("window.refreshNavigationProbe.click()").catch(() => {});
    await reloaded;
    await ready();
    const result = await win.webContents.executeJavaScript("({ ...window.refreshNavigationProbe, click: undefined })");
    assert.equal(result.boot, 2);
    assert.equal(result.mainDraft, "UNSENT-MAIN-DRAFT");
    assert.equal(result.childDraft, "UNSENT-CHILD-DRAFT");
    assert.equal(result.childModel, "Fixture/child-model");
    assert.equal(result.panel, "subagents");
    assert.equal(result.running, true);
    assert.equal(result.checkpointConsumed, true);
    for (const target of ["https://outside.invalid/", new URL("other.html", url).href]) {
      const refused = new Promise(resolve => { blocked = resolve; });
      await win.webContents.executeJavaScript("window.location.href = " + JSON.stringify(target));
      const error = await refused;
      assert.equal(error.message, "Production guard blocked: " + target);
      assert.equal(win.webContents.getURL(), url);
    }
    console.log("REFRESH_NAVIGATION " + JSON.stringify(result));
    clearTimeout(watchdog); app.exit(0);
  } catch (error) { clearTimeout(watchdog); console.error(error?.stack ?? error); app.exit(1); }
});`);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(resolveElectronBinary(root).electronBinary, [join(temp, "main.cjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8");
      stream.on("data", chunk => { output = (output + chunk).slice(-64_000); });
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    let code;
    try { code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); }); }
    finally { clearTimeout(timer); }
    assert.equal(code, 0, output.slice(-10_000));
    assert.match(output, /REFRESH_NAVIGATION /);
  } finally { await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
