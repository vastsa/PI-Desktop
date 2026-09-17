#!/usr/bin/env node
/** Chromium regression: budget settings and the compiled session-reference pipeline. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveElectronBinary } from "./e2e/boot.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "packages/agent-runtime/package.json"));
const { build } = require("esbuild");
const { electronBinary } = resolveElectronBinary(root);
const temp = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "pi-reference-budget-"));
try {
  await build({
    entryPoints: [join(root, "scripts/e2e/session-reference-budget.tsx")],
    outfile: join(temp, "renderer.js"),
    bundle: true, platform: "browser", format: "iife", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    alias: {
      // Verify the artifacts actually consumed by the desktop, not just source tests.
      "@pi-desktop/shared": join(root, "packages/shared/dist/index.js"),
      "@pi-desktop/i18n": join(root, "packages/i18n/dist/index.js"),
      react: join(root, "apps/desktop/node_modules/react"),
      "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
    },
    nodePaths: [join(root, "apps/desktop/node_modules")],
  });
  const renderer = join(root, "apps/desktop/out/renderer");
  const appHtml = await readFile(join(renderer, "index.html"), "utf8");
  const css = [...appHtml.matchAll(/href="([^" ]+\.css)"/g)].map((match) => match[1]);
  assert(css.length, "Build the desktop and its shared/i18n dependencies before this check");
  await cp(join(renderer, "assets"), join(temp, "assets"), { recursive: true });
  await writeFile(join(temp, "index.html"), `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:"><title>Session reference budget regression</title>${css.map((path) => `<link rel="stylesheet" href="${path}">`).join("")}</head><body><script src="renderer.js"></script></body></html>`);
  await writeFile(join(temp, "main.cjs"), `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 1040, height: 720, webPreferences: { backgroundThrottling: false, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  window.webContents.on("console-message", (event) => console.error(event.message));
  try {
    await window.loadFile(path.join(__dirname, "index.html"));
    const checks = [];
    for (const width of [460, 1040]) {
      window.setContentSize(width, 720);
      for (const language of ["en", "zh-CN"]) {
        checks.push(await window.webContents.executeJavaScript("globalThis.sessionReferenceBudgetProbe(" + JSON.stringify(language) + ")"));
        if (process.env.PI_E2E_ARTIFACT_DIR) {
          fs.mkdirSync(process.env.PI_E2E_ARTIFACT_DIR, { recursive: true });
          fs.writeFileSync(path.join(process.env.PI_E2E_ARTIFACT_DIR, "reference-budget-" + language + "-" + width + ".png"), (await window.webContents.capturePage()).toPNG());
        }
      }
    }
    console.log("SESSION_REFERENCE_BUDGET_PROBE " + JSON.stringify({ ok: checks.every((check) => check.ok), checks }));
    app.quit();
  } catch (error) {
    console.error("SESSION_REFERENCE_BUDGET_PROBE " + JSON.stringify({ ok: false, error: String(error), stack: error?.stack }));
    app.exit(1);
  }
});
`);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronBinary, [join(temp, "main.cjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (data) => { output += data; });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 90_000);
  let code;
  try {
    code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  } finally { clearTimeout(timeout); }
  const line = output.split(/\r?\n/).find((line) => line.startsWith("SESSION_REFERENCE_BUDGET_PROBE "));
  assert(line, `renderer returned no probe result (exit=${code}): ${output.slice(-6000)}`);
  const result = JSON.parse(line.slice("SESSION_REFERENCE_BUDGET_PROBE ".length));
  console.log("SESSION_REFERENCE_BUDGET_PROBE " + JSON.stringify(result));
  assert.equal(code, 0, output.slice(-6000));
  assert.equal(result.ok, true);
} finally {
  await rm(temp, { recursive: true, force: true });
}
