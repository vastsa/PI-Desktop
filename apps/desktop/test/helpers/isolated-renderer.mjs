import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repositoryRoot, resolveElectronBinary } from "../../../../scripts/e2e/boot.mjs";

/** A sandboxed fixture, with only test-owned processes and an isolated profile. */
export async function runIsolatedRenderer(entry, probe, { width = 1200, height = 800, focusDocument = false } = {}) {
  assert.match(probe, /^[A-Za-z][A-Za-z0-9]*$/);
  const root = repositoryRoot();
  const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");
  const temp = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "isolated-renderer-"));
  try {
    await build({
      entryPoints: [join(root, entry)], outfile: join(temp, "renderer.js"),
      bundle: true, platform: "browser", format: "esm", jsx: "automatic",
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
const watchdog = setTimeout(() => { console.error("Isolated renderer deadline exceeded"); app.exit(1); }, 45_000);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: ${width}, height: ${height},
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.on("console-message", (_event, level, message) => console.log("RENDERER " + level + " " + message));
  win.webContents.on("render-process-gone", (_event, details) => console.error("RENDERER_GONE " + JSON.stringify(details)));
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    if (${Boolean(focusDocument)}) win.webContents.focus();
    console.log("ISOLATED_RENDERER_PROBE " + JSON.stringify(await win.webContents.executeJavaScript("window.${probe}()")));
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
    assert.equal(code, 0, output.slice(-12_000));
    const line = output.split(/\r?\n/).find((item) => item.startsWith("ISOLATED_RENDERER_PROBE "));
    assert.ok(line, output.slice(-12_000));
    return JSON.parse(line.slice("ISOLATED_RENDERER_PROBE ".length));
  } finally {
    await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
