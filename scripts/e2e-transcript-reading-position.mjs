#!/usr/bin/env node
/** Isolated React/Chromium regression; no running Desktop, Host, or provider. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveElectronBinary } from "./e2e/boot.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "packages/agent-runtime/package.json"));
const { build } = require("esbuild");
const { electronBinary } = resolveElectronBinary(root);
const temp = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? root, "reading-position-"));
try {
  await build({
    entryPoints: [join(root, "scripts/e2e/transcript-reading-position.tsx")],
    outfile: join(temp, "renderer.js"), bundle: true, platform: "browser", format: "iife",
    jsx: "automatic", define: { "process.env.NODE_ENV": '"production"', "import.meta.env": JSON.stringify({ DEV: false, MODE: "production" }) },
    loader: { ".css": "empty" },
    alias: { react: join(root, "apps/desktop/node_modules/react"),
      "react-dom": join(root, "apps/desktop/node_modules/react-dom") },
    plugins: [{ name: "url-assets", setup(build) {
      build.onResolve({ filter: /\?url$/ }, ({ path, resolveDir }) => ({
        path: join(resolveDir, path.slice(0, -4)), namespace: "url-asset",
      }));
      build.onLoad({ filter: /.*/, namespace: "url-asset" }, async ({ path }) => ({
        contents: await readFile(path), loader: "file",
      }));
    } }],
    nodePaths: [join(root, "apps/desktop/node_modules")],
  });
  const renderer = join(root, "apps/desktop/out/renderer");
  const html = await readFile(join(renderer, "index.html"), "utf8");
  const css = [...html.matchAll(/href="([^" ]+\.css)"/g)].map((match) => match[1]);
  assert(css.length, "Build Desktop before running this check");
  await cp(join(renderer, "assets"), join(temp, "assets"), { recursive: true });
  await writeFile(join(temp, "index.html"), `<!doctype html><meta charset="utf-8">${css.map((path) =>
    `<link rel="stylesheet" href="${path}">`).join("")}<script src="renderer.js"></script>`);
  await writeFile(join(temp, "main.cjs"), `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 1000, height: 600,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  window.webContents.on("console-message", (event) => console.error(event.message));
  try {
    await window.loadFile(path.join(__dirname, "index.html"));
    const scrolling = await window.webContents.executeJavaScript("globalThis.transcriptReadingPositionProbe()");
    const session = scrolling.ok ? await window.webContents.executeJavaScript("globalThis.sessionReadingPositionProbe()") : null;
    const continuation = session?.ok ? await window.webContents.executeJavaScript("globalThis.transcriptContinuationProbe()") : null;
    const liveTail = continuation?.ok ? await window.webContents.executeJavaScript("globalThis.transcriptLiveTailProbe()") : null;
    const result = { ok: scrolling.ok && session?.ok && continuation?.ok && liveTail?.ok, scrolling, session, continuation, liveTail };
    console.log("READING_POSITION_PROBE " + JSON.stringify(result));
    app.exit(result.ok ? 0 : 1);
  } catch (error) { console.error(error); app.exit(1); }
});`);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronBinary, [join(temp, "main.cjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (data) => { output += data; });
  // Four renderer probes share this process; slower hidden Windows frames can
  // exceed the old single-probe budget even when every assertion passes.
  const timer = setTimeout(() => child.kill("SIGKILL"), 90_000);
  let code;
  try { code = await new Promise((resolve, reject) => {
    child.once("error", reject); child.once("close", resolve);
  }); } finally { clearTimeout(timer); }
  const line = output.split(/\r?\n/).find((line) => line.startsWith("READING_POSITION_PROBE "));
  assert(line, `No probe result (exit=${code}): ${output.slice(-4000)}`);
  const result = JSON.parse(line.slice("READING_POSITION_PROBE ".length));
  console.log(JSON.stringify(result));
  assert.equal(code, 0, result.scrolling?.error ?? result.session?.error ?? result.continuation?.error ?? result.liveTail?.error ?? output.slice(-4000));
  assert.equal(result.ok, true);
} finally {
  await rm(temp, { recursive: true, force: true });
}
