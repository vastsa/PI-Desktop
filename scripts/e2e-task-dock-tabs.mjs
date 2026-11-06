#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repositoryRoot, resolveElectronBinary } from "./e2e/boot.mjs";

const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");
const temp = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "task-dock-tabs-"));
try {
  await build({ entryPoints: [join(root, "scripts/e2e/task-dock-tabs.tsx")],
    outfile: join(temp, "renderer.js"), bundle: true, platform: "browser", format: "iife", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "false" },
    alias: { "@pi-desktop/i18n": join(root, "packages/i18n/src/index.ts"),
      "@pi-desktop/shared": join(root, "packages/shared/src/index.ts"),
      react: join(root, "apps/desktop/node_modules/react"),
      "react-dom": join(root, "apps/desktop/node_modules/react-dom") },
    nodePaths: [join(root, "apps/desktop/node_modules")],
  });
  const styles = await Promise.all(["tokens.css", "composer.css"].map((name) =>
    readFile(join(root, "apps/desktop/src/styles", name), "utf8")));
  await writeFile(join(temp, "styles.css"), styles.join("\n"));
  await writeFile(join(temp, "index.html"), `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'"><link rel="stylesheet" href="styles.css"></head><body><div id="root"></div><script src="renderer.js"></script></body></html>`);
  await writeFile(join(temp, "main.cjs"), `
const { app, BrowserWindow } = require("electron");
const { join } = require("node:path");
app.setPath("userData", join(__dirname, "profile"));
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: {
    sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  try {
    await win.loadFile(join(__dirname, "index.html"));
    const result = await win.webContents.executeJavaScript("globalThis.taskDockTabsProbe()");
    console.log("TASK_DOCK_TABS " + JSON.stringify(result));
    app.exit(result.ok ? 0 : 1);
  } catch (error) { console.error(error); app.exit(1); }
}).catch(error => { console.error(error); app.exit(1); });
`);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const { electronBinary } = resolveElectronBinary(root);
  const child = spawn(electronBinary, [join(temp, "main.cjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { output += chunk; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 30000);
  let code;
  try {
    code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
  } finally { clearTimeout(timer); }
  assert.equal(code, 0, output);
  assert.match(output, /TASK_DOCK_TABS .*"ok":true/);
  console.log(output.trim());
} finally { await rm(temp, { recursive: true, force: true }); }
