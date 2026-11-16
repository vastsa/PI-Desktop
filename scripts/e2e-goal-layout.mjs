#!/usr/bin/env node
/** Isolated production-component/Chromium geometry; no Desktop instance, Host or provider. */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveElectronBinary } from "./e2e/boot.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktop = join(root, "apps/desktop");
const scratch = process.env.PI_SCRATCH_DIR;
assert(scratch && isAbsolute(scratch), "PI_SCRATCH_DIR must name an absolute isolated scratch directory");
for (const key of ["TMP", "TEMP", "TMPDIR"]) process.env[key] = scratch;
await mkdir(scratch, { recursive: true });
const renderer = join(desktop, "out/renderer");
assert(existsSync(join(renderer, "index.html")), "Task renderer CSS is not built yet: apps/desktop/out/renderer/index.html");
const html = await readFile(join(renderer, "index.html"), "utf8");
const styles = [...html.matchAll(/<link\b[^>]*>/g)].map(([tag]) => {
  if (!/\brel=["']stylesheet["']/.test(tag)) return null;
  return /\bhref=["']([^"']+)["']/.exec(tag)?.[1];
}).filter(Boolean);
assert(styles.length > 0, "No built stylesheet is linked by the task renderer");
// Modes are lazy-loaded by the app, so their CSS need not be linked by index.html.
for (const name of await readdir(join(renderer, "assets"))) {
  const href = `assets/${name}`;
  if (name.endsWith(".css") && !styles.includes(href) &&
    (await readFile(join(renderer, href), "utf8")).includes(".mode-run-bar")) styles.push(href);
}
const temp = await mkdtemp(join(scratch, "goal-layout-"));
const cssEvidence = [];
for (const [index, href] of styles.entries()) {
  assert(!/^[a-z]+:/i.test(href), "Remote stylesheets are not allowed");
  const source = resolve(renderer, href.replace(/^\//, ""));
  assert(!relative(renderer, source).startsWith(".."), "Stylesheet is outside the task renderer");
  const bytes = await readFile(source);
  await writeFile(join(temp, `built-${index}.css`), bytes);
  cssEvidence.push({ path: relative(root, source), sha256: createHash("sha256").update(bytes).digest("hex"), modifiedAt: (await stat(source)).mtime.toISOString() });
}
const require = createRequire(join(desktop, "package.json"));
const { build } = require("esbuild");
const candidate = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const base = execFileSync("git", ["rev-parse", "origin/main"], { cwd: root, encoding: "utf8" }).trim();
await build({
  entryPoints: [join(root, "scripts/e2e/goal-layout.tsx")],
  outfile: join(temp, "renderer.js"), bundle: true, platform: "browser", format: "iife", jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"', "import.meta.env": "{}" },
  loader: { ".css": "empty" },
  alias: {
    "@pi-desktop/shared": join(root, "packages/shared/src/index.ts"),
    "@pi-desktop/i18n": join(root, "packages/i18n/src/index.ts"),
    react: dirname(require.resolve("react/package.json")),
    "react-dom": dirname(require.resolve("react-dom/package.json")),
  },
  nodePaths: [join(desktop, "node_modules"), join(root, "node_modules")],
  plugins: [{ name: "goal-layout-application-services", setup(api) {
    api.onResolve({ filter: /stores\/app-store$/ }, () => ({ path: join(root, "scripts/e2e/fixtures/goal-layout-store.ts") }));
  } }],
});
console.log(`Goal layout fixture bundled; artifacts: ${temp}`);
const electronBinary = process.env.PI_DESKTOP_ELECTRON_BIN ?? resolveElectronBinary(root).electronBinary;
assert(existsSync(electronBinary), `Electron binary missing: ${electronBinary}`);
await writeFile(join(temp, "index.html"), `<!doctype html><html lang="en" data-theme="dark"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'">${styles.map((_, index) => `<link rel="stylesheet" href="built-${index}.css">`).join("")}<title>Goal layout regression</title></head><body><script src="renderer.js"></script></body></html>`);
await writeFile(join(temp, "main.cjs"), String.raw`
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
app.setPath("sessionData", path.join(__dirname, "session"));
app.setPath("crashDumps", path.join(__dirname, "crashes"));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-background-networking");
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 1120, height: 1000,
    frame: false, useContentSize: true,
    webPreferences: { offscreen: true, backgroundThrottling: false, sandbox: true,
      contextIsolation: true, nodeIntegration: false, partition: "goal-layout-isolated" } });
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith("file:") }));
  window.webContents.on("console-message", (event) => console.error(event.message));
  window.webContents.on("render-process-gone", (_event, details) => { console.error(JSON.stringify(details)); app.exit(2); });
  const cases = [];
  const call = (method, ...args) => window.webContents.executeJavaScript("globalThis.goalLayout." + method + "(" + args.map((value) => JSON.stringify(value)).join(",") + ")");
  async function click(key, action = true) {
    const point = await call("target", key);
    window.webContents.sendInputEvent({ type: "mouseMove", ...point });
    window.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...point });
    window.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...point });
    if (action) await call("after", key);
  }
  async function typeBudget(index, value) {
    await click("budget:" + index, false);
    await call("inputReady", index);
    const modifiers = process.platform === "darwin" ? ["meta"] : ["control"];
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "A", modifiers });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "A", modifiers });
    await call("inputSelected", index);
    await window.webContents.insertText(String(value));
    await call("inputEdited", index, value);
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Return" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Return" });
    await call("inputSaved", index, value);
  }
  for (const language of ["en", "zh-CN"]) for (const width of [320, 480, 720, 1120]) {
    const entry = { language, width };
    try {
      window.setContentSize(width, 1000);
      await window.loadFile(path.join(__dirname, "index.html"));
      // Pin CSS pixels independently from Windows native frame rounding.
      window.webContents.enableDeviceEmulation({ screenPosition: "desktop", viewSize: { width, height: 1000 }, deviceScaleFactor: 1, scale: 1 });
      entry.mount = await call("mount", language);
      if (entry.mount.viewport[0] !== width) throw new Error("Wrong Chromium viewport: " + entry.mount.viewport[0]);
      fs.writeFileSync(path.join(__dirname, language + "-" + width + ".png"), (await window.webContents.capturePage()).toPNG());
      for (const key of ["resume", "pause", "edit", "cancelEdit", "stop", "cancel", "remove", "cancel"]) {
        await click(key);
        if (key === "edit") fs.writeFileSync(path.join(__dirname, language + "-" + width + "-objective.png"), (await window.webContents.capturePage()).toPNG());
      }
      await typeBudget(0, 37);
      await typeBudget(1, 123456);
      await call("clockStart");
      await click("pause");
      await call("frozen");
      await click("resume");
      Object.assign(entry, await call("cleanup"));
    } catch (error) {
      entry.error = String(error);
      fs.writeFileSync(path.join(__dirname, language + "-" + width + "-error.png"), (await window.webContents.capturePage()).toPNG());
    }
    cases.push(entry);
  }
  const result = { ok: cases.every((entry) => !entry.error && entry.failures.length === 0),
    versions: process.versions, cases };
  fs.writeFileSync(path.join(__dirname, "probe.json"), JSON.stringify(result, null, 2));
  console.log("GOAL_LAYOUT_RESULT " + JSON.stringify(result));
  window.destroy();
  app.exit(result.ok ? 0 : 1);
}).catch((error) => { console.error(error); app.exit(2); });
`);
const env = { ...process.env, TMP: scratch, TEMP: scratch, TMPDIR: scratch, PI_DESKTOP_MCP_CONTROL: "0" };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_RENDERER_URL;
const child = spawn(electronBinary, [join(temp, "main.cjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
let output = "";
for (const stream of [child.stdout, child.stderr]) stream.on("data", (data) => { output += data; });
const timeout = setTimeout(() => child.kill("SIGKILL"), 90_000);
let code;
try {
  code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
} finally {
  clearTimeout(timeout);
  await writeFile(join(temp, "electron.log"), output);
}
const line = output.split(/\r?\n/).find((value) => value.startsWith("GOAL_LAYOUT_RESULT "));
assert(line, `No Goal layout result (exit ${code}); artifacts: ${temp}\n${output.slice(-2500)}`);
const result = { ...JSON.parse(line.slice("GOAL_LAYOUT_RESULT ".length)), candidate, base, dirtyCandidate: true, electronBinary, cssEvidence, artifacts: temp };
await writeFile(join(temp, "result.json"), JSON.stringify(result, null, 2));
const failures = result.cases.flatMap((entry) => (entry.error ? [entry.error] : entry.failures).map((failure) => `${entry.language}/${entry.width}: ${failure}`));
console.log(JSON.stringify({ ok: result.ok, cases: result.cases.length, checks: result.cases.reduce((sum, entry) => sum + (entry.checks ?? 0), 0), failures, artifacts: temp }, null, 2));
assert.equal(result.ok, true, `Goal layout defects; see ${join(temp, "result.json")}`);
assert.equal(code, 0);
