#!/usr/bin/env node
/** Real React/Chromium coverage for Skill and MCP market retry controls. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveElectronBinary } from "./e2e/boot.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "packages/agent-runtime/package.json"));
const { build } = require("esbuild");
const { electronBinary } = resolveElectronBinary(root);
const evidence = process.env.PI_MARKET_EVIDENCE_DIR;
const temp = await mkdtemp(join(tmpdir(), "pi-market-retry-"));
try {
  await build({
    entryPoints: [join(root, "scripts/e2e/market-retry.tsx")],
    outfile: join(temp, "renderer.js"),
    bundle: true,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    loader: { ".woff": "file", ".woff2": "file", ".ttf": "file" },
    define: { "process.env.NODE_ENV": '"production"' },
    alias: {
      "@pi-desktop/i18n": join(root, "packages/i18n/src/index.ts"),
      react: join(root, "apps/desktop/node_modules/react"),
      "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
    },
    nodePaths: [join(root, "apps/desktop/node_modules")],
  });
  await writeFile(
    join(temp, "index.html"),
    '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; style-src \'self\' \'unsafe-inline\'; img-src \'self\' data:"><link rel="stylesheet" href="renderer.css"><title>Market retry interactions</title><body><script src="renderer.js"></script>',
  );
  const stageScript = evidence
    ? [
        '    const stages = ["error-with-snapshot", "retry-loading", "error-no-snapshot", "recovered"];',
        '    const out = [];',
        '    for (const stage of stages) {',
        '      const result = await window.webContents.executeJavaScript(`globalThis.marketSnapshotStage(${JSON.stringify(stage)})`);',
        '      await window.webContents.executeJavaScript("document.fonts.ready.then(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))");',
        '      const png = await window.webContents.capturePage();',
        '      const target = path.join(__dirname, "shots", stage + ".png");',
        '      await fs.mkdir(path.join(__dirname, "shots"), { recursive: true });',
        '      await fs.writeFile(target, png.toPNG());',
        '      out.push({ stage, ...result });',
        '    }',
        '    console.log("MARKET_SNAPSHOT_SHOTS " + JSON.stringify(out));',
      ].join("\n")
    : "";
  await writeFile(
    join(temp, "main.cjs"),
    [
      'const { app, BrowserWindow } = require("electron");',
      'const path = require("node:path");',
      'const fs = require("node:fs/promises");',
      'app.setPath("userData", path.join(__dirname, "profile"));',
      'app.whenReady().then(async () => {',
      '  const window = new BrowserWindow({ show: false, width: 1280, height: 800, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });',
      '  window.webContents.on("console-message", (event) => console.error(event.message));',
      '  try {',
      '    await window.loadFile(path.join(__dirname, "index.html"));',
      '    const result = await window.webContents.executeJavaScript("globalThis.marketRetryProbe()");',
      '    console.log("MARKET_RETRY_PROBE " + JSON.stringify(result));',
      stageScript,
      '    app.quit();',
      '  } catch (error) {',
      '    console.error("MARKET_RETRY_PROBE " + JSON.stringify({ ok: false, error: String(error) }));',
      '    app.exit(1);',
      '  }',
      '});',
    ].join("\n"),
  );
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronBinary, [join(temp, "main.cjs")], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (data) => {
      output += data;
    });
  }
  const timeout = setTimeout(() => child.kill("SIGKILL"), 90_000);
  let code;
  try {
    code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
  } finally {
    clearTimeout(timeout);
  }
  const line = output.split(/\r?\n/).find((entry) => entry.startsWith("MARKET_RETRY_PROBE "));
  assert(line, `renderer returned no probe result (exit=${code}): ${output.slice(-2000)}`);
  const result = JSON.parse(line.slice("MARKET_RETRY_PROBE ".length));
  console.log("MARKET_RETRY_PROBE " + JSON.stringify(result));
  assert.equal(code, 0, output.slice(-6000));
  assert.equal(result.ok, true);
  if (evidence) {
    const shots = output
      .split(/\r?\n/)
      .find((entry) => entry.startsWith("MARKET_SNAPSHOT_SHOTS "));
    assert(shots, `renderer returned no stage shots: ${output.slice(-2000)}`);
    await mkdir(resolve(evidence), { recursive: true });
    const staged = JSON.parse(shots.slice("MARKET_SNAPSHOT_SHOTS ".length));
    for (const stage of staged) {
      assert.equal(stage.ok, true, `${stage.stage}: ${JSON.stringify(stage)}`);
      const from = join(temp, "shots", `${stage.stage}.png`);
      const to = join(resolve(evidence), `${stage.stage}.png`);
      await (await import("node:fs/promises")).copyFile(from, to);
    }
    console.log(`MARKET_SNAPSHOT_SHOTS ok=${staged.length} dir=${resolve(evidence)}`);
  }
} finally {
  await rm(temp, { recursive: true, force: true });
}
