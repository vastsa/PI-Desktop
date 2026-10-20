#!/usr/bin/env node
/** Production SettingsPage in isolated Electron, including audio and restart persistence. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { repositoryRoot, resolveElectronBinary } from "./e2e/boot.mjs";

const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");
const temp = await mkdtemp(join(tmpdir(), "pi-notification-sound-"));
const evidence = process.env.PI_SOUND_EVIDENCE_DIR ? resolve(process.env.PI_SOUND_EVIDENCE_DIR) : null;
try {
  if (evidence) await mkdir(evidence, { recursive: true });
  await build({
    entryPoints: [join(root, "scripts/e2e/notification-sound.jsx")],
    outfile: join(temp, "renderer.js"), bundle: true, platform: "browser", format: "esm", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "false" },
    alias: { "@pi-desktop/i18n": join(root, "packages/i18n/src"),
      react: join(root, "apps/desktop/node_modules/react"), "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
      i18next: join(root, "apps/desktop/node_modules/i18next"), "react-i18next": join(root, "apps/desktop/node_modules/react-i18next") },
    nodePaths: [join(root, "apps/desktop/node_modules")],
    plugins: [{ name: "local-url-assets", setup(builder) {
      builder.onResolve({ filter: /\?url$/ }, ({ path, resolveDir }) => ({ path: join(resolveDir, path.slice(0, -4)), namespace: "asset" }));
      builder.onLoad({ filter: /.*/, namespace: "asset" }, async ({ path }) => ({ contents: await readFile(path), loader: "file" }));
    } }],
  });
  const renderer = join(root, "apps/desktop/out/renderer");
  const html = await readFile(join(renderer, "index.html"), "utf8");
  const css = [...html.matchAll(/href="([^" ]+\.css)"/g)].map((match) => match[1]);
  assert(css.length, "Run pnpm build:js before this test");
  await cp(join(renderer, "assets"), join(temp, "assets"), { recursive: true });
  await writeFile(join(temp, "index.html"), `<!doctype html><html data-platform="linux"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; media-src 'self' data:">${css.map((path) => `<link rel="stylesheet" href="${path}">`).join("")}</head><body><div id="root"></div><script type="module" src="renderer.js"></script></body></html>`);
  await writeFile(join(temp, "main.cjs"), `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const fs = require("node:fs/promises");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: true, width: 1440, height: 1100,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.on("console-message", (event) => console.error(event.message));
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    const result = await win.webContents.executeJavaScript("window.notificationSoundProbe(" + JSON.stringify(process.env.PI_SOUND_PHASE) + ")");
    if (process.env.PI_SOUND_EVIDENCE_DIR && result.clip) {
      await fs.writeFile(path.join(process.env.PI_SOUND_EVIDENCE_DIR, "settings-full.png"), (await win.webContents.capturePage()).toPNG());
      await fs.writeFile(path.join(process.env.PI_SOUND_EVIDENCE_DIR, "notification-sound-detail.png"), (await win.webContents.capturePage(result.clip)).toPNG());
    }
    await win.webContents.session.flushStorageData();
    console.log("NOTIFICATION_SOUND " + JSON.stringify(result));
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
});
`);
  for (const phase of ["write", "restore"]) {
    const env = { ...process.env, PI_SOUND_PHASE: phase, ...(evidence ? { PI_SOUND_EVIDENCE_DIR: evidence } : {}) };
    delete env.ELECTRON_RUN_AS_NODE;
    const args = [...(process.getuid?.() === 0 ? ["--no-sandbox"] : []),
      ...(process.platform === "linux" && !process.env.DISPLAY ? ["--ozone-platform=headless"] : []),
      "--disable-gpu", "--mute-audio", join(temp, "main.cjs")];
    const child = spawn(resolveElectronBinary(root).electronBinary, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { output += chunk; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    let code;
    try { code = await new Promise((accept, reject) => { child.once("error", reject); child.once("close", accept); }); }
    finally { clearTimeout(timer); }
    assert.equal(code, 0, output);
    const result = output.split(/\r?\n/).find((line) => line.startsWith("NOTIFICATION_SOUND "));
    assert(result, output);
    console.log(result);
  }
} finally {
  await rm(temp, { recursive: true, force: true });
}
