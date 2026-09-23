#!/usr/bin/env node
/** Production React/CSS scroll regression in an isolated, offscreen Chromium. */
import { execFile, spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { resolveElectronBinary } from "./e2e/boot.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = resolve(process.env.PI_SCRATCH_DIR || tmpdir());
const marker = "SCROLL_PROBE ";
const wheelChannel = "transcript-scroll-probe:wheel";
const timeoutMs = 90_000;
const execFileAsync = promisify(execFile);

async function copyBuiltStyles(temp) {
  const renderer = process.env.PI_SCROLL_RENDERER_DIR
    ? resolve(process.env.PI_SCROLL_RENDERER_DIR)
    : join(root, "apps/desktop/out/renderer");
  const htmlPath = join(renderer, "index.html");
  let html;
  try {
    html = await readFile(htmlPath, "utf8");
  } catch (error) {
    throw new Error(`Missing built renderer: ${htmlPath}. Run pnpm build:js first.`, { cause: error });
  }
  const links = [...html.matchAll(/<link\b[^>]*>/gi)]
    .map(([tag]) => ({
      rel: tag.match(/\brel\s*=\s*["']([^"']+)["']/i)?.[1],
      href: tag.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1],
    }))
    .filter(({ rel }) => rel?.toLowerCase().split(/\s+/).includes("stylesheet"));
  if (!links.length) {
    throw new Error(`No built stylesheets linked by ${htmlPath}. Run pnpm build:js first.`);
  }
  const styles = [];
  for (const { href } of links) {
    if (!href || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href)) {
      throw new Error(`Expected a local built stylesheet in ${htmlPath}: ${href}`);
    }
    const asset = decodeURIComponent(href.split(/[?#]/)[0]).replace(/^\/+/, "");
    const source = resolve(renderer, asset);
    const localPath = relative(renderer, source);
    if (isAbsolute(localPath) || localPath.split(sep).includes("..") || !localPath.endsWith(".css")) {
      throw new Error(`Stylesheet escapes the built renderer or is not CSS: ${href}`);
    }
    try {
      const css = await readFile(source, "utf8");
      if (!css.trim()) throw new Error("Stylesheet is empty");
    } catch (error) {
      throw new Error(`Missing or empty built stylesheet: ${source}. Run pnpm build:js first.`, { cause: error });
    }
    styles.push({ source, localPath });
  }
  // Keep CSS-relative images, fonts, and other assets alongside the real CSS.
  try {
    await cp(join(renderer, "assets"), join(temp, "assets"), { recursive: true });
  } catch (error) {
    throw new Error(`Missing or unreadable built assets in ${renderer}. Run pnpm build:js first.`, { cause: error });
  }
  return Promise.all(styles.map(async ({ source, localPath }) => {
    const target = join(temp, localPath);
    await mkdir(dirname(target), { recursive: true });
    await cp(source, target);
    const href = "./" + localPath.split(sep).map(encodeURIComponent).join("/");
    return `<link rel="stylesheet" href="${href}">`;
  }));
}

async function writeFixture(temp, styles) {
  const require = createRequire(join(root, "packages/agent-runtime/package.json"));
  const { build } = require("esbuild");
  await build({
    entryPoints: [join(root, "scripts/e2e/transcript-scroll.tsx")],
    outfile: join(temp, "renderer.js"),
    bundle: true,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    // Geometry comes from the linked current app build, not a CSS test shim.
    loader: { ".css": "empty" },
    alias: {
      "@pi-desktop/i18n": join(root, "packages/i18n/src/index.ts"),
      react: join(root, "apps/desktop/node_modules/react"),
      "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
    },
    nodePaths: [join(root, "apps/desktop/node_modules")],
  });
  await writeFile(join(temp, "index.html"), `<!doctype html>
<html lang="en" data-theme="dark"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'none'; base-uri 'none'; form-action 'none'">
<title>Transcript scroll regression</title>${styles.join("\n")}
</head><body><div id="root"></div><script src="renderer.js"></script></body></html>`);
  // This is the only renderer bridge. No production preload, host, or API.
  await writeFile(join(temp, "preload.cjs"), `
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("scrollProbeDriver", {
  wheel: async ({ x, y, deltaY }) => {
    await ipcRenderer.invoke(${JSON.stringify(wheelChannel)}, { x, y, deltaY });
  },
});
`);
  await writeFile(join(temp, "main.cjs"), String.raw`
const { app, BrowserWindow, ipcMain } = require("electron");
const { mkdirSync } = require("node:fs");
const path = require("node:path");
const wheelChannel = ${JSON.stringify(wheelChannel)};
app.setName("transcript-scroll-probe");
app.setAppUserModelId("net.aiuo.pi-desktop.transcript-scroll-probe");
app.setPath("temp", __dirname);
const dpr = Number(process.env.PI_SCROLL_PROBE_DPR || 1);
if (!Number.isFinite(dpr) || dpr < 0.5 || dpr > 4) throw new Error("Invalid probe DPR");
const width = Number(process.env.PI_SCROLL_PROBE_WIDTH || 1100);
const height = Number(process.env.PI_SCROLL_PROBE_HEIGHT || 760);
if (![width, height].every(value => Number.isInteger(value) && value >= 320 && value <= 4096)) {
  throw new Error("Invalid probe viewport dimensions");
}
const scenario = process.env.PI_SCROLL_PROBE_SCENARIO || "all";
if (!["all", "underfilled"].includes(scenario)) throw new Error("Invalid probe scenario");
for (const name of ["userData", "sessionData", "logs", "crashDumps"]) {
  const directory = path.join(__dirname, name);
  mkdirSync(directory, { recursive: true });
  app.setPath(name, directory);
}
let window;
let viewport = null;
let finished = false;
function finish(result) {
  if (finished) return;
  const output = "SCROLL_PROBE " + JSON.stringify({ ...result, scenario, requestedDpr: dpr, viewport }) + "\n";
  finished = true;
  ipcMain.removeHandler(wheelChannel);
  if (window && !window.isDestroyed() && !window.webContents.isDestroyed() && window.webContents.debugger.isAttached()) {
    window.webContents.debugger.detach();
  }
  // Flush the result before Electron terminates its renderer process tree.
  process.stdout.write(output, () => {
    app.exit(result.ok === true ? 0 : 1);
  });
}
function fail(error) {
  finish({ ok: false, error: error?.stack || String(error) });
}
process.on("uncaughtException", fail);
process.on("unhandledRejection", fail);
app.whenReady().then(async () => {
  window = new BrowserWindow({
    width,
    height,
    useContentSize: true,
    show: false,
    webPreferences: {
      offscreen: true,
      backgroundThrottling: false,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });
  const contents = window.webContents;
  contents.on("console-message", (event) => console.error("Renderer: " + event.message));
  contents.on("preload-error", (_event, _path, error) => fail(error));
  contents.on("render-process-gone", (_event, details) => fail(new Error("Renderer exited: " + JSON.stringify(details))));
  window.on("closed", () => { if (!finished) fail(new Error("Probe window closed before completion")); });
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (event) => event.preventDefault());
  contents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  contents.session.setPermissionCheckHandler(() => false);
  contents.debugger.attach("1.3");
  ipcMain.handle(wheelChannel, async (event, input) => {
    if (event.sender !== contents || event.senderFrame !== contents.mainFrame) {
      throw new Error("Wheel input is only allowed from the probe's main frame");
    }
    const { x, y, deltaY } = input || {};
    if (![x, y, deltaY].every(Number.isFinite) || x < 0 || x >= width || y < 0 || y >= height) {
      throw new Error("Wheel input requires finite viewport x/y and deltaY");
    }
    // CDP dispatches trusted input in the view's pre-zoom coordinates. Convert
    // the fixture's CSS coordinates/delta without replacing native scrolling.
    const inputScale = contents.getZoomFactor();
    await contents.debugger.sendCommand("Input.dispatchMouseEvent", {
      type: "mouseWheel", x: x * inputScale, y: y * inputScale,
      deltaX: 0, deltaY: deltaY * inputScale,
    });
  });
  await window.loadFile(path.join(__dirname, "index.html"));
  // Windows offscreen Electron can ignore force-device-scale-factor, while CDP
  // device emulation can crash its render widget. Native page zoom changes the
  // real raster scale; resize the backing window to keep the CSS viewport fixed.
  const baseDpr = await contents.executeJavaScript("devicePixelRatio");
  if (!Number.isFinite(baseDpr) || baseDpr <= 0) throw new Error("Invalid native renderer DPR: " + baseDpr);
  const zoom = dpr / baseDpr;
  contents.setZoomFactor(zoom);
  window.setContentSize(Math.round(width * zoom), Math.round(height * zoom));
  viewport = await contents.executeJavaScript(
    "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve({" +
    "dpr: devicePixelRatio, width: innerWidth, height: innerHeight" +
    "}))))"
  );
  console.error("Probe viewport: " + JSON.stringify(viewport));
  if (!Number.isFinite(viewport.dpr) || Math.abs(viewport.dpr - dpr) > 0.001 ||
      viewport.width !== width || viewport.height !== height) {
    throw new Error("Renderer scale/viewport mismatch: " + JSON.stringify(viewport));
  }
  const result = await contents.executeJavaScript(
    "(async () => {" +
    "const links = Array.from(document.querySelectorAll('link[rel=stylesheet]'));" +
    "if (!links.length || links.some(link => !link.sheet)) throw new Error('Built app CSS failed to load');" +
    "if (typeof globalThis.transcriptScrollProbe !== 'function') throw new Error('Fixture must expose globalThis.transcriptScrollProbe()');" +
    "await document.fonts.ready;" +
    "return globalThis.transcriptScrollProbe(" + JSON.stringify(scenario) + ");" +
    "})()"
  );
  if (!result || typeof result.ok !== "boolean") {
    throw new Error("transcriptScrollProbe() must return an object with a boolean ok");
  }
  if (Math.abs(result.dpr - dpr) > 0.001 || !Number.isFinite(result.dpr)) {
    throw new Error("Renderer DPR does not match requested scale: " + result.dpr + " != " + dpr);
  }
  finish(result);
}).catch(fail);
`);
}

async function killChildTree(child) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    // Never kill by image name: another Desktop or Electron may be running.
    await execFileAsync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      timeout: 10_000,
    });
  } else {
    try {
      // The detached child owns this process group, not the caller's group.
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
}

async function runElectron(electronBinary, temp) {
  const env = { ...process.env, PI_SCRATCH_DIR: scratch, TMP: temp, TEMP: temp, TMPDIR: temp };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronBinary, [join(temp, "main.cjs")], {
    cwd: temp,
    env,
    detached: process.platform !== "win32",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (data) => { stdout = (stdout + data).slice(-4 * 1024 * 1024); });
  child.stderr.on("data", (data) => { stderr = (stderr + data).slice(-64 * 1024); });
  const closed = new Promise((resolve) => {
    child.once("error", (error) => resolve({ error: String(error) }));
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  let timer;
  const outcome = await Promise.race([
    closed,
    new Promise((resolve) => { timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs); }),
  ]);
  clearTimeout(timer);
  if (outcome.timedOut) {
    try {
      await killChildTree(child);
    } catch (error) {
      stderr += "\nCould not terminate the probe process tree: " + String(error);
      child.kill("SIGKILL");
    }
    // Even a failed tree kill must not leave the runner waiting on inherited pipes.
    let closeTimer;
    const exit = await Promise.race([
      closed,
      new Promise((resolve) => { closeTimer = setTimeout(() => resolve({}), 5_000); }),
    ]);
    clearTimeout(closeTimer);
    child.stdout.destroy();
    child.stderr.destroy();
    child.unref();
    return { ...exit, timedOut: true, stdout, stderr };
  }
  return { ...outcome, stdout, stderr };
}

let temp;
let execution;
let result = { ok: false };
try {
  await mkdir(scratch, { recursive: true });
  temp = await mkdtemp(join(scratch, "transcript-scroll-"));
  const styles = await copyBuiltStyles(temp);
  await writeFixture(temp, styles);
  const { electronBinary } = resolveElectronBinary(root);
  execution = await runElectron(electronBinary, temp);
  const lines = execution.stdout.split(/\r?\n/).filter((line) => line.startsWith(marker));
  if (lines.length === 1) {
    const parsed = JSON.parse(lines[0].slice(marker.length));
    if (!parsed || typeof parsed.ok !== "boolean") throw new Error("Invalid SCROLL_PROBE result");
    result = parsed;
  }
  if (execution.timedOut) throw new Error(`Transcript scroll probe timed out after ${timeoutMs}ms`);
  if (execution.error) throw new Error(`Electron launch failed: ${execution.error}`);
  if (lines.length !== 1) throw new Error(`Expected one SCROLL_PROBE result, got ${lines.length} (exit=${execution.code})`);
  if (execution.code !== 0) throw new Error(`Electron probe failed (exit=${execution.code}, signal=${execution.signal})`);
  if (result.ok !== true) throw new Error("Transcript scroll regression failed; see probe result");
} catch (error) {
  result = { ...result, ok: false, runnerError: error?.stack || String(error) };
  process.exitCode = 1;
  console.error(result.runnerError);
  if (execution?.stderr) console.error("Electron stderr:\n" + execution.stderr);
  if (execution?.stdout) console.error("Electron stdout:\n" + execution.stdout);
} finally {
  console.log(marker + JSON.stringify(result));
  const log = join(scratch, (temp ? basename(temp) : `transcript-scroll-${Date.now()}-${process.pid}`) + ".json");
  try {
    await writeFile(log, JSON.stringify({ ...result, runner: execution }, null, 2) + "\n");
    console.error("Transcript scroll result: " + log);
  } catch (error) {
    console.error("Could not retain transcript scroll result: " + String(error));
  }
  if (temp) {
    try {
      await rm(temp, { recursive: true, force: true, maxRetries: 6, retryDelay: 150 });
    } catch (error) {
      // Windows may hold profile files briefly; never replace the probe failure.
      console.error(`Could not clean probe scratch directory ${temp}: ${error}`);
    }
  }
}
