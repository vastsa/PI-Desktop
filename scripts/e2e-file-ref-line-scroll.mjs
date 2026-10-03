#!/usr/bin/env node
/** Follow a real transcript path:line chip into the production host file viewer. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repositoryRoot, resolveElectronBinary } from "./e2e/boot.mjs";

const root = repositoryRoot();
const require = createRequire(join(root, "packages/agent-runtime/package.json"));
const { build } = require("esbuild");
const temp = await mkdtemp(join(tmpdir(), "pi-file-ref-line-scroll-"));
try {
  await build({
    entryPoints: [join(root, "scripts/e2e/file-ref-line-scroll.tsx")],
    outfile: join(temp, "renderer.js"),
    bundle: true,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "false" },
    loader: { ".css": "empty" },
    alias: {
      "@pi-desktop/i18n": join(root, "packages/i18n/src/index.ts"),
      react: join(root, "apps/desktop/node_modules/react"),
      "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
    },
    nodePaths: [join(root, "apps/desktop/node_modules")],
  });
  const viewerStyles = await readFile(join(root, "apps/desktop/src/styles/work-panel.css"), "utf8");
  await writeFile(join(temp, "work-panel.css"), `${viewerStyles}\nhtml,body,#root{height:100%;margin:0}#root{display:flex;flex-direction:column}.fixture-chat{flex:0 0 auto;padding:8px}`);
  await writeFile(
    join(temp, "index.html"),
    '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="work-panel.css"><div id="root"></div><script src="renderer.js"></script>',
  );
  await writeFile(
    join(temp, "main.cjs"),
    `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
app.disableHardwareAcceleration();
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 900, height: 420,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  window.webContents.on("console-message", (event) => console.error(event.message));
  try {
    await window.loadFile(path.join(__dirname, "index.html"));
    const result = await window.webContents.executeJavaScript("window.fileRefLineScrollProbe()");
    console.log("FILE_REF_LINE_SCROLL " + JSON.stringify(result));
    app.exit(0);
  } catch (error) {
    console.error("FILE_REF_LINE_SCROLL " + (error?.stack ?? String(error)));
    app.exit(1);
  }
});
`,
  );
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(resolveElectronBinary(root).electronBinary, [
    "--headless=new",
    "--disable-gpu",
    join(temp, "main.cjs"),
  ], { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => { output += chunk; });
  }
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
  const line = output.split(/\r?\n/).find((item) => item.startsWith("FILE_REF_LINE_SCROLL {"));
  assert(line, `renderer returned no file reference result (exit=${code}): ${output.slice(-4000)}`);
  const result = JSON.parse(line.slice("FILE_REF_LINE_SCROLL ".length));
  console.log(line);
  assert.equal(code, 0, output.slice(-4000));
  assert.equal(result.fileManagerAvailable, true, "fixture must use the normal project-file setup");
  assert.deepEqual(result.resolveRefs, ["src/scroll-target.txt", "src/scroll-target.txt"]);
  assert.deepEqual(result.readPaths, ["src/scroll-target.txt"]);
  assert.equal(result.selectedPath, "src/scroll-target.txt");
  assert.deepEqual(result.request, { path: "src/scroll-target.txt", seq: 1, line: 65, column: 4 });
  assert.deepEqual(result.scrollCall, { line: "65", block: "center" });
  assert.ok(result.scrollTop > 0, "host file viewer did not scroll away from the top");
  assert.equal(result.targetLineVisible, true, "requested line is outside the visible viewer area");
} finally {
  await rm(temp, { recursive: true, force: true });
}
