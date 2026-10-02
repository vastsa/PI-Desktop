#!/usr/bin/env node
/**
 * Real React/Chromium regression for E2E-ASKTOOL-compact-card-interaction:
 * the compact AskTool card keeps its select / skip / submit paths working
 * after the header absorbed every confirmation affordance.
 */
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
const temp = await mkdtemp(join(tmpdir(), "pi-asktool-card-"));
try {
  await build({
    entryPoints: [join(root, "scripts/e2e/asktool-card.tsx")],
    outfile: join(temp, "renderer.js"),
    bundle: true,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    define: {
      "process.env.NODE_ENV": '"production"',
      "import.meta.env.DEV": "false",
    },
    // Styles come from the app's built stylesheet below; the component and its
    // hook are the real modules under test.
    loader: { ".css": "empty" },
    alias: {
      "@pi-desktop/i18n": join(root, "packages/i18n/src/index.ts"),
      // The fixture lives outside the desktop package; use its React instance.
      react: join(root, "apps/desktop/node_modules/react"),
      "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
    },
    nodePaths: [join(root, "apps/desktop/node_modules")],
    plugins: [
      {
        name: "local-url-assets",
        setup(build) {
          build.onResolve({ filter: /\?url$/ }, ({ path, resolveDir }) => ({
            path: join(resolveDir, path.slice(0, -4)),
            namespace: "local-url-asset",
          }));
          build.onLoad(
            { filter: /.*/, namespace: "local-url-asset" },
            async ({ path }) => ({
              contents: await readFile(path),
              loader: "file",
            }),
          );
        },
      },
    ],
  });
  // The card is styled by the app's own stylesheet, so the page has to carry
  // the built one rather than a bare document.
  const renderer = join(root, "apps/desktop/out/renderer");
  const appHtml = await readFile(join(renderer, "index.html"), "utf8");
  const css = [...appHtml.matchAll(/href="([^" ]+\.css)"/g)].map(
    (match) => match[1],
  );
  assert(css.length, "Build the app with pnpm build:js before running this check");
  await cp(join(renderer, "assets"), join(temp, "assets"), { recursive: true });
  await writeFile(
    join(temp, "index.html"),
    `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:"><title>AskTool card regression</title>${css
      .map((path) => `<link rel="stylesheet" href="${path}">`)
      .join("")}<script src="renderer.js"></script>`,
  );
  await writeFile(
    join(temp, "main.cjs"),
    `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 1000, height: 800, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  window.webContents.on("console-message", (event) => console.error(event.message));
  try {
    await window.loadFile(path.join(__dirname, "index.html"));
    await window.webContents.executeJavaScript("window.addEventListener('error', event => console.error(event.error?.stack ?? event.message)); window.addEventListener('unhandledrejection', event => console.error(event.reason?.stack ?? String(event.reason)));");
    const result = await window.webContents.executeJavaScript("globalThis.asktoolCardProbe()");
    console.log("ASKTOOL_CARD_PROBE " + JSON.stringify(result));
    app.quit();
  } catch (error) {
    console.error("ASKTOOL_CARD_PROBE " + JSON.stringify({ ok: false, error: error?.stack ?? String(error) }));
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
    .find((line) => line.startsWith("ASKTOOL_CARD_PROBE "));
  assert(
    line,
    `renderer returned no probe result (exit=${code}): ${output.slice(-2000)}`,
  );
  const result = JSON.parse(line.slice("ASKTOOL_CARD_PROBE ".length));
  console.log("ASKTOOL_CARD_PROBE " + JSON.stringify(result));
  assert.equal(code, 0, output.slice(-6000));
  assert.equal(result.ok, true, result.error ?? "asktool card probe failed");
  console.log("asktool card: ok");
} finally {
  await rm(temp, { recursive: true, force: true });
}
