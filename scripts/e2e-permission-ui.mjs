#!/usr/bin/env node
/** Isolated Chromium rendering of the actual permission card, without a user profile. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveElectronBinary } from "./e2e/boot.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = resolve(process.env.PI_PERMISSION_UI_SOURCE_ROOT || root);
const artifactRoot = process.env.PI_PERMISSION_UI_ARTIFACTS;
const require = createRequire(join(root, "packages/agent-runtime/package.json"));
const { build } = require("esbuild");
const temp = await mkdtemp(join(tmpdir(), "pi-permission-ui-"));
const { electronBinary } = resolveElectronBinary(root);
try {
  if (artifactRoot) await mkdir(artifactRoot, { recursive: true });
  await build({
    entryPoints: [join(root, "scripts/e2e/permission-ui.tsx")],
    outfile: join(temp, "renderer.js"), bundle: true, platform: "browser",
    format: "iife", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' },
    loader: { ".woff": "file", ".woff2": "file", ".ttf": "file" },
    alias: {
      "permission-card-under-test": join(sourceRoot, "apps/desktop/src/components/PermissionCard.tsx"),
      "permission-store-under-test": join(sourceRoot, "apps/desktop/src/stores/app-store.ts"),
      "permission-api-under-test": join(sourceRoot, "apps/desktop/src/lib/api.ts"),
      "permission-tokens-under-test": join(sourceRoot, "apps/desktop/src/styles/tokens.css"),
      "permission-styles-under-test": join(sourceRoot, "apps/desktop/src/styles/messages.css"),
      "permission-base-under-test": join(sourceRoot, "apps/desktop/src/styles/base.css"),
      "permission-ui-kit-under-test": join(sourceRoot, "apps/desktop/src/styles/ui-kit.css"),
      "@pi-desktop/i18n": join(sourceRoot, "packages/i18n/src/index.ts"),
      react: join(root, "apps/desktop/node_modules/react"),
      "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
      "react-i18next": join(root, "apps/desktop/node_modules/react-i18next"),
      i18next: join(root, "apps/desktop/node_modules/i18next"),
    },
    nodePaths: [join(root, "apps/desktop/node_modules")],
  });
  await writeFile(join(temp, "index.html"), `<!doctype html><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:">
<link rel="stylesheet" href="renderer.css"><title>Permission card fixture</title>
<body><script src="renderer.js"></script>`);
  await writeFile(join(temp, "main.cjs"), `
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 920, height: 640, show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  try {
    await window.loadFile(path.join(__dirname, "index.html"));
    const results = [];
    const captureCard = async (name) => {
      // Wait for the hidden compositor and reject blank evidence.
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
        const image = await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
        const pixels = image.toBitmap();
        let varied = false;
        for (let offset = 4; offset < pixels.length; offset += 4) {
          if (pixels[offset] !== pixels[0] || pixels[offset + 1] !== pixels[1] || pixels[offset + 2] !== pixels[2]) { varied = true; break; }
        }
        if (varied) {
          await fs.writeFile(path.join(process.env.PI_PERMISSION_UI_ARTIFACTS, name), image.toPNG());
          return;
        }
      }
      throw new Error('Permission card capture remained blank: ' + name);
    };
    for (const locale of ["en", "zh-CN"]) {
      await window.webContents.executeJavaScript('globalThis.renderPermissionFixture(' + JSON.stringify(locale) + ')');
      if (process.env.PI_PERMISSION_UI_ARTIFACTS) {
        await captureCard('permission-' + locale + '.png');
      }
      results.push(await window.webContents.executeJavaScript('globalThis.verifyPermissionFixture()'));
      if (!process.env.PI_PERMISSION_UI_SOURCE_ROOT || process.env.PI_PERMISSION_UI_REVIEW_STATES === '1') {
        await window.webContents.executeJavaScript('globalThis.renderPermissionFixture(' + JSON.stringify(locale) + ', "reviewing")');
        if (process.env.PI_PERMISSION_UI_ARTIFACTS) {
          await captureCard('reviewing-' + locale + '.png');
        }
        results.push(await window.webContents.executeJavaScript('globalThis.verifyReviewTakeoverFixture()'));
        results.push(await window.webContents.executeJavaScript('globalThis.verifyGrantSwitchFixture()'));
      }
    }
    // Baseline screenshots may point to an upstream sourceRoot; the editable
    // policy fixture only describes the current candidate, never that baseline.
    if (!process.env.PI_PERMISSION_UI_SOURCE_ROOT) {
      results.push(await window.webContents.executeJavaScript('globalThis.verifyReviewPolicySettingsFixture()'));
    }
    console.log("PERMISSION_UI_PROBE " + JSON.stringify({ ok: true, results }));
    app.quit();
  } catch (error) { console.error("PERMISSION_UI_PROBE " + JSON.stringify({ ok: false, error: String(error) })); app.exit(1); }
});`);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronBinary, [join(temp, "main.cjs")], {
    env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (data) => { output += data; });
  const timer = setTimeout(() => child.kill(), 45_000);
  let code;
  try {
    code = await new Promise((done, reject) => { child.once("error", reject); child.once("close", done); });
  } finally { clearTimeout(timer); }
  const resultLine = output.split(/\r?\n/).find((line) => line.startsWith("PERMISSION_UI_PROBE "));
  assert(resultLine, `No UI result (exit ${code}): ${output.slice(-4000)}`);
  const result = JSON.parse(resultLine.slice("PERMISSION_UI_PROBE ".length));
  console.log(JSON.stringify(result));
  assert.equal(code, 0, output.slice(-4000));
  assert.equal(result.ok, true);
} finally { await rm(temp, { recursive: true, force: true }); }
