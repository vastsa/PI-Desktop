#!/usr/bin/env node
/** Production error component in isolated Chromium; optional review captures. */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveElectronBinary } from "./e2e/boot.mjs";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");
const { electronBinary } = resolveElectronBinary(root);
const temp = await mkdtemp(join(tmpdir(), "pi-certificate-ui-"));
const baseline = process.argv.includes("--baseline");
const evidence = process.env.PI_CERTIFICATE_EVIDENCE_DIR;
try {
  await build({
    entryPoints: [join(root, "scripts/e2e/provider-certificate-ui.tsx")], outfile: join(temp, "renderer.js"),
    bundle: true, platform: "browser", format: "iife", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' }, loader: { ".css": "empty" },
    alias: { "@pi-desktop/i18n": join(root, "packages/i18n/src/index.ts"),
      react: join(root, "apps/desktop/node_modules/react"), "react-dom": join(root, "apps/desktop/node_modules/react-dom") },
    nodePaths: [join(root, "apps/desktop/node_modules")],
    plugins: baseline ? [{ name: "upstream-error-component", setup(build) {
      build.onLoad({ filter: /[/\\]transcript[/\\]shared\.tsx$/ }, () => ({
        contents: execFileSync("git", ["show", "origin/main:apps/desktop/src/features/chat/transcript/shared.tsx"], { cwd: root, encoding: "utf8" }), loader: "tsx",
      }));
    } }] : [],
  });
  const renderer = join(root, "apps/desktop/out/renderer");
  const html = await readFile(join(renderer, "index.html"), "utf8");
  const css = [...html.matchAll(/href="([^" ]+\.css)"/g)].map((m) => m[1]);
  assert.ok(css.length, "build desktop first");
  await cp(join(renderer, "assets"), join(temp, "assets"), { recursive: true });
  await writeFile(join(temp, "index.html"), `<!doctype html><html data-theme="light"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:">${css.map(p => `<link rel="stylesheet" href="${p}">`).join("")}<body><script src="renderer.js"></script></body></html>`);
  let screenshot;
  if (evidence) { await mkdir(resolve(evidence), { recursive: true }); screenshot = join(resolve(evidence), baseline ? "before.png" : "after.png"); }
  await writeFile(join(temp, "main.cjs"), `
const { app, BrowserWindow } = require('electron');
const path = require('node:path'); const fs = require('node:fs/promises');
app.setPath('userData', path.join(__dirname, 'profile'));
app.whenReady().then(async () => {
 const window = new BrowserWindow({show:false,width:1100,height:520,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
 try {
  await window.loadFile(path.join(__dirname, 'index.html'));
  const result = await window.webContents.executeJavaScript('globalThis.certificateUiProbe(${baseline})');
  await window.webContents.executeJavaScript('document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))');
  const screenshot = ${JSON.stringify(screenshot ?? null)};
  if (screenshot) await fs.writeFile(screenshot, (await window.webContents.capturePage()).toPNG());
  console.log('CERTIFICATE_UI ' + JSON.stringify(result)); app.quit();
 } catch(error) { console.error(error); app.exit(1); }
});`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronBinary, [join(temp, "main.cjs")], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", data => { output += data; });
  const timeout = setTimeout(() => child.kill(), 30_000);
  let code;
  try { code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); }); }
  finally { clearTimeout(timeout); }
  assert.equal(code, 0, output);
  assert.ok(output.includes('"ok":true'), output);
  console.log(output.trim());
} finally { await rm(temp, { recursive: true, force: true }); }
