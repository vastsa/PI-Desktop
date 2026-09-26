#!/usr/bin/env node
/** Real React/Chromium layout regression for the composer slash menu (E2E-088b). */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveElectronBinary } from "./e2e/boot.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(
  join(root, "packages/agent-runtime/package.json"),
);
const { build } = require("esbuild");
const { electronBinary } = resolveElectronBinary(root);
const temp = await mkdtemp(join(tmpdir(), "pi-autocomplete-layout-"));
try {
  await build({
    entryPoints: [join(root, "scripts/e2e/composer-autocomplete-layout.tsx")],
    outfile: join(temp, "renderer.js"),
    bundle: true,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    alias: {
      "@pi-desktop/i18n": join(root, "packages/i18n/src/index.ts"),
      // The fixture lives outside the desktop package; use its React instance.
      react: join(root, "apps/desktop/node_modules/react"),
      "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
    },
    nodePaths: [join(root, "apps/desktop/node_modules")],
  });
  // Use the built app's complete CSS, including the Tailwind reset.
  const renderer = join(root, "apps/desktop/out/renderer");
  const appHtml = await readFile(join(renderer, "index.html"), "utf8");
  const css = [...appHtml.matchAll(/href="([^" ]+\.css)"/g)].map((match) => match[1]);
  assert(css.length, "Build the app with pnpm build:js before running this check");
  await cp(join(renderer, "assets"), join(temp, "assets"), { recursive: true });
  await writeFile(join(temp, "index.html"), `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:"><title>Composer autocomplete layout</title>${css.map((path) => `<link rel="stylesheet" href="${path}">`).join("")}<body><script src="renderer.js"></script>`);
  await writeFile(
    join(temp, "main.cjs"),
    `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 1040, height: 760, webPreferences: { backgroundThrottling: false, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  window.webContents.on("console-message", (event) => console.error(event.message));
  try {
    await window.loadFile(path.join(__dirname, "index.html"));
    const checks = [];
    for (const [viewport, width] of [[1040, 320], [1680, 640]]) {
      window.setContentSize(viewport, 760);
      // slash, "@" file-only, and "@" with the Agents group (ADR 0308).
      for (const [fileMode, agentMode] of [[false, false], [true, false], [true, true]]) {
        const label = fileMode ? (agentMode ? "agents" : "file") : "slash";
        checks.push(await window.webContents.executeJavaScript("globalThis.autocompleteLayoutProbe(" + width + "," + fileMode + "," + agentMode + ")"));
        if (process.env.PI_E2E_ARTIFACT_DIR) {
          const fs = require("node:fs");
          fs.mkdirSync(process.env.PI_E2E_ARTIFACT_DIR, { recursive: true });
          fs.writeFileSync(path.join(process.env.PI_E2E_ARTIFACT_DIR, "autocomplete-" + width + "-" + label + ".png"), (await window.webContents.capturePage()).toPNG());
        }
      }
    }
    console.log("AUTOCOMPLETE_LAYOUT_PROBE " + JSON.stringify({ ok: checks.every((check) => check.ok), checks }));
    app.quit();
  } catch (error) {
    console.error("AUTOCOMPLETE_LAYOUT_PROBE " + JSON.stringify({ ok: false, error: String(error) }));
    app.exit(1);
  }
});
`,
  );
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronBinary, [join(temp, "main.cjs")], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (data) => {
      output += data;
    });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 45_000);
  let code;
  try {
    code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
  } finally {
    clearTimeout(timeout);
  }
  const line = output
    .split(/\r?\n/)
    .find((line) => line.startsWith("AUTOCOMPLETE_LAYOUT_PROBE "));
  assert(
    line,
    `renderer returned no probe result (exit=${code}): ${output.slice(-2000)}`,
  );
  const result = JSON.parse(line.slice("AUTOCOMPLETE_LAYOUT_PROBE ".length));
  console.log("AUTOCOMPLETE_LAYOUT_PROBE " + JSON.stringify(result));
  assert.equal(code, 0, output.slice(-6000));
  assert.equal(result.ok, true);
} finally {
  await rm(temp, { recursive: true, force: true });
}
