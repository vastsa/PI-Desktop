#!/usr/bin/env node
/** Real React/Electron interaction regression for Composer model defaults. */
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
const temp = await mkdtemp(join(tmpdir(), "pi-composer-model-selection-"));
try {
  await build({
    entryPoints: [join(root, "scripts/e2e/composer-model-selection.tsx")],
    outfile: join(temp, "renderer.js"),
    bundle: true,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    alias: {
      "@pi-desktop/i18n": join(root, "packages/i18n/src/index.ts"),
      react: join(root, "apps/desktop/node_modules/react"),
      "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
    },
    nodePaths: [join(root, "apps/desktop/node_modules")],
    plugins: [{
      name: "composer-model-selection-store",
      setup(buildApi) {
        buildApi.onResolve({ filter: /stores\/app-store$/ }, (args) =>
          args.path.endsWith("stores/app-store")
            ? { path: join(root, "scripts/e2e/fixtures/composer-model-selection-store.ts") }
            : undefined,
        );
      },
    }],
  });

  const renderer = join(root, "apps/desktop/out/renderer");
  const appHtml = await readFile(join(renderer, "index.html"), "utf8");
  const css = [...appHtml.matchAll(/href="([^" ]+\.css)"/g)].map((match) => match[1]);
  assert(css.length, "Build the app with pnpm build:js before running this check");
  await cp(join(renderer, "assets"), join(temp, "assets"), { recursive: true });
  await writeFile(
    join(temp, "index.html"),
    `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:"><title>Composer model selection</title>${css.map((path) => `<link rel="stylesheet" href="${path}">`).join("")}<body><script src="renderer.js"></script>`,
  );
  await writeFile(
    join(temp, "main.cjs"),
    `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { offscreen: true, backgroundThrottling: false, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  try {
    await window.loadFile(path.join(__dirname, "index.html"));
    const result = await window.webContents.executeJavaScript("globalThis.composerModelSelectionProbe()");
    console.log("COMPOSER_MODEL_SELECTION " + JSON.stringify(result));
    app.quit();
  } catch (error) {
    console.error("COMPOSER_MODEL_SELECTION_ERROR " + String(error?.stack || error));
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
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (data) => { output += data; });
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

  const line = output.split(/\r?\n/).find((item) => item.startsWith("COMPOSER_MODEL_SELECTION "));
  assert(line, `renderer returned no result (exit=${code}): ${output.slice(-3000)}`);
  const result = JSON.parse(line.slice("COMPOSER_MODEL_SELECTION ".length));
  assert.equal(code, 0, output.slice(-5000));
  assert.deepEqual(
    { model: result.model, switchedLevel: result.switchedLevel, level: result.level },
    { model: "model-b", switchedLevel: "high", level: "low" },
  );
  assert.deepEqual(
    result.writes.map(({ modelId, thinkingLevel }) => ({ modelId, thinkingLevel })),
    [
      { modelId: "model-b", thinkingLevel: "high" },
      { modelId: "model-b", thinkingLevel: "low" },
      { modelId: "model-b", thinkingLevel: "low" },
    ],
  );
  console.log("PASS Composer applies a switched model default and preserves same-model manual thinking");
} finally {
  await rm(temp, { recursive: true, force: true });
}
