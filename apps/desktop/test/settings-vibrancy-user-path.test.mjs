import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");

test("vibrancy confirmation retries write failures, accepts saved changes, and description search locates its row", {
  timeout: 60_000,
  skip: process.platform === "linux" && !process.env.DISPLAY ? "Isolated Electron UI requires a display" : false,
}, async () => {
  const temp = await mkdtemp(join(root, "apps/desktop/.settings-vibrancy-ui-"));
  try {
    await build({
      entryPoints: [join(root, "apps/desktop/test/fixtures/settings-vibrancy.jsx")],
      outfile: join(temp, "renderer.js"), bundle: true, platform: "browser", format: "esm", jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "false", "import.meta.env.PROD": "true" },
      alias: {
        "@pi-desktop/i18n": join(root, "packages/i18n/src"),
        react: join(root, "apps/desktop/node_modules/react"),
        "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
        i18next: join(root, "apps/desktop/node_modules/i18next"),
        "react-i18next": join(root, "apps/desktop/node_modules/react-i18next"),
      },
      nodePaths: [join(root, "apps/desktop/node_modules")],
      plugins: [{
        name: "vite-url-assets",
        setup(builder) {
          builder.onResolve({ filter: /\?url$/ }, (args) => ({
            path: resolve(args.resolveDir, args.path.slice(0, -4)), namespace: "url-asset",
          }));
          builder.onLoad({ filter: /.*/, namespace: "url-asset" }, async (args) => ({
            contents: await readFile(args.path), loader: "file",
          }));
        },
      }],
    });
    await writeFile(join(temp, "index.html"), '<!doctype html><html lang="en" data-theme="light"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; style-src \'self\' \'unsafe-inline\'"><link rel="stylesheet" href="renderer.css"><style>html,body,#root{height:100%;margin:0}#open-global-search{position:fixed;right:12px;bottom:12px;z-index:999}</style><body><div id="root"></div><script type="module" src="renderer.js"></script></html>');
    await writeFile(join(temp, "main.cjs"), `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 900, height: 700,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.on("console-message", (event) => console.error(event.message));
  win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith("file:") && !details.url.startsWith("data:") }));
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    const result = await win.webContents.executeJavaScript("window.settingsVibrancyProbe()");
    console.log("SETTINGS_VIBRANCY_PROBE " + JSON.stringify(result));
    app.exit(0);
  } catch (error) { console.error(error?.stack ?? error); app.exit(1); }
});
`);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(resolveElectronBinary(root).electronBinary, [join(temp, "main.cjs")], {
      env, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => { output += chunk; });
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), 45_000);
    let code;
    try {
      code = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
    } finally {
      clearTimeout(timer);
    }
    assert.equal(code, 0, output.slice(-6000));
    const line = output.split(/\r?\n/).find((item) => item.startsWith("SETTINGS_VIBRANCY_PROBE "));
    assert.ok(line, output.slice(-6000));
    assert.deepEqual(JSON.parse(line.slice("SETTINGS_VIBRANCY_PROBE ".length)), {
      asksBeforeWrite: true, cancelPreservesSetting: true, failedWriteStaysOpen: true,
      persistedAndVisible: true, noFalseSaveError: true, descriptionHitHighlightsRow: true, errors: [],
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
