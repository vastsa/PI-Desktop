#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveElectronBinary } from "./e2e/boot.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(join(root, "packages/agent-runtime/package.json"));
const { build } = require("esbuild");
const baselineIndex = process.argv.indexOf("--baseline");
const baseline = baselineIndex >= 0 ? process.argv[baselineIndex + 1] : undefined;
assert(baselineIndex < 0 || (baseline && !baseline.startsWith("-")), "--baseline requires a Git revision");
const artifacts = join(root, ".cache", `background-tasks-e2e${baseline ? "-baseline" : ""}`);
const original = (path) => execFileSync("git", ["show", `${baseline}:${path}`], { cwd: root, encoding: "utf8" });
await mkdir(artifacts, { recursive: true });
await build({
  entryPoints: [join(root, "scripts/e2e/background-tasks.tsx")],
  outfile: join(artifacts, "renderer.js"),
  bundle: true, platform: "browser", format: "iife", jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "false" },
  loader: { ".css": "empty" },
  alias: {
    "@pi-desktop/i18n": join(root, "packages/i18n/src/index.ts"),
    react: join(root, "apps/desktop/node_modules/react"),
    "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
  },
  nodePaths: [join(root, "apps/desktop/node_modules")],
  plugins: baseline ? [{
    name: "baseline-background-tasks",
    setup(build) {
      build.onLoad({ filter: /[\\/]BackgroundTasksBar\.tsx$/ }, () => ({
        contents: original("apps/desktop/src/components/BackgroundTasksBar.tsx"),
        loader: "tsx",
        resolveDir: join(root, "apps/desktop/src/components"),
      }));
    },
  }] : [],
});
let styles;
if (baseline) {
  styles = ["tokens.css", "globals.css", "ui-kit.css", "composer.css", "messages.css", "overlays.css"]
    .map((name) => original(`apps/desktop/src/styles/${name}`));
} else {
  const renderer = join(root, "apps/desktop/out/renderer");
  const html = await readFile(join(renderer, "index.html"), "utf8");
  const paths = [...html.matchAll(/href="([^"]+\.css)"/g)].map((match) => match[1]);
  assert(paths.length, "Build the Desktop stylesheet before running the renderer probe");
  styles = await Promise.all(paths.map((path) => readFile(join(renderer, path), "utf8")));
}
await writeFile(join(artifacts, "styles.css"), styles.join("\n"));
await writeFile(join(artifacts, "index.html"), `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:">
<link rel="stylesheet" href="styles.css">
<style>body { margin: 0; } textarea { display: block; width: 100%; min-height: 60px; box-sizing: border-box; }</style>
</head><body><script src="renderer.js"></script></body></html>`);
await writeFile(join(artifacts, "main.cjs"), `
const { app, BrowserWindow } = require("electron");
const { join } = require("node:path");
const { writeFile } = require("node:fs/promises");
app.setPath("userData", join(__dirname, "profile"));
app.disableHardwareAcceleration();
app.on("window-all-closed", () => {});
app.whenReady().then(async () => {
  const results = [];
  for (const [width, height] of [[1280, 800], [700, 800], [390, 844]]) {
    const window = new BrowserWindow({ show: false, width, height, useContentSize: true,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    window.webContents.on("console-message", event => console.error(event.message));
    try {
      await window.loadFile(join(__dirname, "index.html"));
      const result = await window.webContents.executeJavaScript("globalThis.backgroundTasksProbe()");
      results.push(result);
      await writeFile(join(__dirname, "tasks-" + width + ".png"), (await window.webContents.capturePage()).toPNG());
    } finally { window.destroy(); }
  }
  console.log("BACKGROUND_TASKS_PROBE " + JSON.stringify(results));
  app.exit(results.every(result => result.ok) ? 0 : 1);
}).catch(error => { console.error(error); app.exit(1); });
`);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const { electronBinary } = resolveElectronBinary(root);
const child = spawn(electronBinary, [join(artifacts, "main.cjs")], {
  env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { output += chunk; });
const timer = setTimeout(() => child.kill("SIGKILL"), 90_000);
let code;
try {
  code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
} finally { clearTimeout(timer); }
const line = output.split(/\r?\n/).find((line) => line.startsWith("BACKGROUND_TASKS_PROBE "));
assert(line, `renderer probe did not finish (exit ${code}): ${output.slice(-6000)}`);
const results = JSON.parse(line.slice("BACKGROUND_TASKS_PROBE ".length));
await writeFile(join(artifacts, "results.json"), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
assert.equal(code, 0, `background task interaction failed; artifacts: ${artifacts}`);
