#!/usr/bin/env node
/** Settings navigation in isolated Electron, with the production component/store/CSS. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repositoryRoot, resolveElectronBinary } from "./e2e/boot.mjs";

const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");
const urlAssets = {
  name: "local-url-assets",
  setup(build) {
    build.onResolve({ filter: /\?url$/ }, ({ path, resolveDir }) => ({
      path: join(resolveDir, path.slice(0, -4)), namespace: "local-url-asset",
    }));
    build.onLoad({ filter: /.*/, namespace: "local-url-asset" }, async ({ path }) => ({
      contents: await readFile(path), loader: "file",
    }));
  },
};
const temp = await mkdtemp(join(tmpdir(), "pi-settings-scroll-"));
try {
  await build({ entryPoints: [join(root, "scripts/e2e/settings-scroll.jsx")],
    outfile: join(temp, "renderer.js"), bundle: true, platform: "browser", format: "esm", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "true" },
    alias: { "@pi-desktop/i18n": join(root, "packages/i18n/src"),
      react: join(root, "apps/desktop/node_modules/react"),
      "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
      i18next: join(root, "apps/desktop/node_modules/i18next"),
      "react-i18next": join(root, "apps/desktop/node_modules/react-i18next") },
    nodePaths: [join(root, "apps/desktop/node_modules")],
    plugins: [urlAssets],
  });
  const renderer = join(root, "apps/desktop/out/renderer");
  const html = await readFile(join(renderer, "index.html"), "utf8");
  const css = [...html.matchAll(/href="([^" ]+\.css)"/g)].map((match) => match[1]);
  assert(css.length, "Run pnpm build:js before this test");
  await cp(join(renderer, "assets"), join(temp, "assets"), { recursive: true });
  await writeFile(join(temp, "index.html"), `<!doctype html><html data-platform="darwin"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:">${css.map((path) => `<link rel="stylesheet" href="${path}">`).join("")}</head><body><div id="root"></div><script type="module" src="renderer.js"></script></body></html>`);
  await writeFile(join(temp, "main.cjs"), `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1000, height: 720,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.on("console-message", (event) => console.error(event.message));
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    const result = await win.webContents.executeJavaScript("window.settingsScrollProbe()");
    console.log("SETTINGS_SCROLL " + JSON.stringify(result));
    const segments = [];
    for (const width of [800, 1000, 1440]) {
      win.setContentSize(width, 720);
      for (const language of ["en", "zh-CN"]) {
        for (const scale of [1, 1.5]) {
          segments.push(await win.webContents.executeJavaScript(
            "window.settingsSegmentProbe(" + JSON.stringify(language) + "," + scale + ")"));
        }
      }
    }
    console.log("SETTINGS_SEGMENTS " + JSON.stringify(segments));
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
});
`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(resolveElectronBinary(root).electronBinary, [join(temp, "main.cjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { output += chunk; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
  let code;
  try { code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); }); }
  finally { clearTimeout(timer); }
  assert.equal(code, 0, output);
  const result = output.split(/\r?\n/).find((line) => line.startsWith("SETTINGS_SCROLL "));
  assert(result, output);
  console.log(result);
  const segments = output.split(/\r?\n/).find((line) => line.startsWith("SETTINGS_SEGMENTS "));
  assert(segments, output);
  console.log(segments);
} finally { await rm(temp, { recursive: true, force: true }); }
