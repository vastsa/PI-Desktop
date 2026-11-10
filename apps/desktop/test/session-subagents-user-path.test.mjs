import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");

test("current-session subagent page exposes recorded activity and safe session operations", {
  skip: process.platform === "linux" && !process.env.DISPLAY ? "Electron requires a display" : false,
  timeout: 90_000,
}, async () => {
  // The fixture has no Host, provider, real conversations or OS clipboard.
  const temp = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "session-subagents-ui-"));
  try {
    await build({
      entryPoints: [join(root, "apps/desktop/test/e2e/session-subagents/fixture.tsx")],
      outfile: join(temp, "renderer.js"), bundle: true, platform: "browser", format: "esm", jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"' },
      alias: {
        "@pi-desktop/i18n": join(root, "packages/i18n/src"),
        "@pi-desktop/shared": join(root, "packages/shared/src"),
        react: join(root, "apps/desktop/node_modules/react"),
        "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
        i18next: join(root, "apps/desktop/node_modules/i18next"),
        "react-i18next": join(root, "apps/desktop/node_modules/react-i18next"),
      },
      nodePaths: [join(root, "apps/desktop/node_modules")],
      loader: { ".svg": "dataurl", ".png": "dataurl", ".woff2": "file", ".woff": "file", ".ttf": "file" },
    });
    await writeFile(join(temp, "index.html"), '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; style-src \'self\' \'unsafe-inline\'"><link rel="stylesheet" href="renderer.css"><div id="root"></div><script type="module" src="renderer.js"></script>');
    await writeFile(join(temp, "main.cjs"), `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
app.disableHardwareAcceleration();
const watchdog = setTimeout(() => { console.error("Subagent UI fixture deadline exceeded"); app.exit(1); }, 45_000);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1200, height: 800,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.on("console-message", (_event, level, message) => { console.log("RENDERER " + level + " " + message); });
  win.webContents.on("render-process-gone", (_event, details) => { console.error("RENDERER_GONE " + JSON.stringify(details)); });
  win.webContents.on("dom-ready", () => { console.log("FIXTURE_DOM_READY"); });
  try {
    console.log("FIXTURE_LOADING");
    await win.loadFile(path.join(__dirname, "index.html"));
    console.log("FIXTURE_LOADED");
    console.log("SESSION_SUBAGENTS_PROBE " + JSON.stringify(await win.webContents.executeJavaScript("window.sessionSubagentsProbe()")));
    clearTimeout(watchdog); app.exit(0);
  } catch (error) { clearTimeout(watchdog); console.error(error?.stack ?? error); app.exit(1); }
});`);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(resolveElectronBinary(root).electronBinary, [join(temp, "main.cjs"), `--user-data-dir=${join(temp, "profile")}`], {
      env, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => { output = (output + chunk).slice(-64_000); });
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    let code;
    try {
      code = await new Promise((resolve, reject) => {
        child.once("error", reject); child.once("close", resolve);
      });
    } finally { clearTimeout(timer); }
    assert.equal(code, 0, output.slice(-8000));
    const line = output.split(/\r?\n/).find((item) => item.startsWith("SESSION_SUBAGENTS_PROBE "));
    assert.ok(line, output.slice(-8000));
    const report = JSON.parse(line.slice("SESSION_SUBAGENTS_PROBE ".length));
    assert.equal(report.passed, true);
    assert.equal(report.checks.length, 9);
    assert.ok(report.reads > 10, "The fixture did not exercise history paging");
    assert.deepEqual(report.stops, [
      { sessionId: "session-a", delegationIds: ["a2"] },
      { sessionId: "session-a" },
    ]);
    assert.deepEqual(report.copied, ["a2"]);
  } finally {
    await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
