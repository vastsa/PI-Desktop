#!/usr/bin/env node
/** Native Electron interaction while an isolated renderer receives large deltas. */
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
const temp = await mkdtemp(join(tmpdir(), "pi-renderer-responsiveness-"));

try {
  await build({
    entryPoints: [join(root, "scripts/e2e/renderer-responsiveness.tsx")],
    outfile: join(temp, "renderer.js"),
    bundle: true,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    define: {
      "process.env.NODE_ENV": '"production"',
      "import.meta.env": '{"DEV":false,"MODE":"production"}',
    },
    loader: { ".css": "empty" },
    alias: {
      "@pi-desktop/i18n": join(root, "packages/i18n/src/index.ts"),
      react: join(root, "apps/desktop/node_modules/react"),
      "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
    },
    nodePaths: [join(root, "apps/desktop/node_modules")],
    plugins: [{
      name: "local-url-assets",
      setup(build) {
        build.onResolve({ filter: /\?url$/ }, ({ path, resolveDir }) => ({
          path: join(resolveDir, path.slice(0, -4)),
          namespace: "local-url-asset",
        }));
        build.onLoad({ filter: /.*/, namespace: "local-url-asset" }, async ({ path }) => ({
          contents: await readFile(path),
          loader: "file",
        }));
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
    `<!doctype html><meta charset="utf-8"><title>Renderer responsiveness</title>${css
      .map((path) => `<link rel="stylesheet" href="${path}">`)
      .join("")}<style>body{margin:0;padding:16px}header{display:flex;gap:8px}#large-tool-result,#streaming-tool-result{max-height:200px;overflow:auto}#scroll-area{height:360px;overflow:auto;border:1px solid #777;margin-top:12px}#message{min-height:600px}.markdown-plain-fallback pre{white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word}</style><div id="root"></div><script src="renderer.js"></script>`,
  );

  const mainSource = `
const { app, BrowserWindow } = require("electron");
const { spawn } = require("node:child_process");
const readline = require("node:readline");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
let windowRef;
let producer;
const timeout = setTimeout(() => fail(new Error("external interaction deadline exceeded")), 25000);
function fail(error) {
  console.error("RENDERER_RESPONSIVENESS " + JSON.stringify({ ok: false, error: error?.stack ?? String(error) }));
  try { producer?.kill(); } catch {}
  app.exit(1);
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function evaluate(source) {
  return windowRef.webContents.executeJavaScript(source, true);
}
async function until(predicate, label, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await evaluate("(() => " + predicate + ")()")) return;
    await wait(15);
  }
  const details = await evaluate("({ body: document.body.innerText.slice(0, 500), tool: document.querySelector('#large-tool-result')?.innerHTML.slice(0, 1200) })");
  throw new Error("timed out waiting for " + label + ": " + JSON.stringify(details));
}
async function nativeClick(id) {
  const rect = await evaluate("(() => { const r = document.getElementById(" + JSON.stringify(id) + ").getBoundingClientRect(); return { x:r.left+r.width/2, y:r.top+r.height/2 }; })()");
  windowRef.webContents.sendInputEvent({ type: "mouseMove", x: Math.round(rect.x), y: Math.round(rect.y) });
  windowRef.webContents.sendInputEvent({ type: "mouseDown", x: Math.round(rect.x), y: Math.round(rect.y), button: "left", clickCount: 1 });
  windowRef.webContents.sendInputEvent({ type: "mouseUp", x: Math.round(rect.x), y: Math.round(rect.y), button: "left", clickCount: 1 });
}
async function nativeClickByLabel(label, containerId) {
  const rect = await evaluate("(() => { const root = " + JSON.stringify(containerId) + " ? document.getElementById(" + JSON.stringify(containerId) + ") : document; const e = [...root.querySelectorAll('button[aria-label]')].find(button => button.getAttribute('aria-label') === " + JSON.stringify(label) + "); if (!e) throw new Error('missing button: ' + " + JSON.stringify(label) + "); const r = e.getBoundingClientRect(); return { x:r.left+r.width/2, y:r.top+r.height/2 }; })()");
  windowRef.webContents.sendInputEvent({ type: "mouseMove", x: Math.round(rect.x), y: Math.round(rect.y) });
  windowRef.webContents.sendInputEvent({ type: "mouseDown", x: Math.round(rect.x), y: Math.round(rect.y), button: "left", clickCount: 1 });
  windowRef.webContents.sendInputEvent({ type: "mouseUp", x: Math.round(rect.x), y: Math.round(rect.y), button: "left", clickCount: 1 });
}
async function nativeAction(label, action, predicate) {
  const before = await evaluate("window.readRendererProbe()");
  if (!before.streaming || before.receivedSource.length < 32768) throw new Error(label + " did not start under large streaming load");
  const started = performance.now();
  await action();
  await until(predicate, label + " acknowledgement", 1500);
  const durationMs = performance.now() - started;
  if (durationMs > 250) throw new Error(label + " took " + durationMs.toFixed(1) + "ms");
  await until("window.readRendererProbe().sequence > " + before.sequence, label + " concurrent data progress", 1500);
  return { action: label, durationMs, streamingAtSend: before.streaming, sourceLengthAtSend: before.receivedSource.length };
}
app.whenReady().then(async () => {
  windowRef = new BrowserWindow({
    show: true,
    width: 1200,
    height: 900,
    resizable: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  windowRef.on("closed", () => { windowRef = undefined; });
  windowRef.webContents.on("console-message", (event) => console.error(event.message));
  await windowRef.loadFile(path.join(__dirname, "index.html"));
  windowRef.show();
  windowRef.focus();
  await until("document.getElementById('native-action') !== null", "fixture mount");
  await until("document.querySelector('#large-tool-result .large-text-preview[data-page-count]') !== null", "large tool output page");
  await until("document.querySelector('#streaming-tool-result .large-text-preview[data-page-count]') !== null", "streaming tool output page");
  await evaluate("window.startRendererStream()");

  let expected = "";
  let lastSequence = 0;
  const pending = [];
  let delivery = Promise.resolve();
  let producerError;
  producer = spawn(${JSON.stringify(process.execPath)}, [${JSON.stringify(join(root, "scripts/e2e/renderer-load-producer.mjs"))}], { stdio: ["ignore", "pipe", "pipe"] });
  const lines = readline.createInterface({ input: producer.stdout });
  lines.on("line", (line) => {
    try {
      const item = JSON.parse(line);
      if (item.sequence !== lastSequence + 1) throw new Error("producer sequence gap");
      lastSequence = item.sequence;
      expected += item.delta;
      pending.push(item);
    } catch (error) { producerError = error; }
  });
  producer.stderr.on("data", (chunk) => { producerError = new Error(String(chunk)); });
  const flush = () => {
    if (!pending.length) return delivery;
    const batch = pending.splice(0);
    delivery = delivery.then(async () => {
      for (const item of batch) {
        await evaluate("window.pushRendererDelta(" + item.sequence + "," + JSON.stringify(item.delta) + ")");
      }
    });
    return delivery;
  };
  const flushTimer = setInterval(() => { void flush().catch((error) => { producerError = error; }); }, 35);
  await until("window.readRendererProbe().receivedSource.length >= 36864", "large renderer load", 6000);

  const timings = [];
  timings.push(await nativeAction("button click", () => nativeClick("native-action"), "window.readRendererProbe().nativeClicks === 1"));
  const streamingToolPageCount = await evaluate("Number(document.querySelector('#streaming-tool-result .large-text-preview')?.dataset.pageCount ?? 0)");
  timings.push(await nativeAction("previous live tool output page", () => nativeClickByLabel("Previous part", "streaming-tool-result"), "document.querySelector('#streaming-tool-result .large-text-preview')?.dataset.pageIndex === " + JSON.stringify(String(streamingToolPageCount - 2))));
  timings.push(await nativeAction("return live tool output to newest page", () => nativeClickByLabel("Next part", "streaming-tool-result"), "document.querySelector('#streaming-tool-result .large-text-preview')?.dataset.pageIndex === " + JSON.stringify(String(streamingToolPageCount - 1))));
  const liveDelta = String.fromCharCode(10) + ("tool-stream-line" + String.fromCharCode(10)).repeat(2048) + "streaming-tool-final-marker";
  await evaluate("window.appendStreamingToolOutput(" + JSON.stringify(liveDelta) + ")");
  await until("Number(document.querySelector('#streaming-tool-result .large-text-preview')?.dataset.pageIndex) === Number(document.querySelector('#streaming-tool-result .large-text-preview')?.dataset.pageCount) - 1 && document.querySelector('#streaming-tool-result .large-text-preview pre')?.textContent?.includes('streaming-tool-final-marker') === true", "newest streaming tool output page");
  timings.push(await nativeAction("next tool output page", () => nativeClickByLabel("Next part"), "document.querySelector('#large-tool-result .large-text-preview')?.dataset.pageIndex === '1'"));
  timings.push(await nativeAction("previous tool output page", () => nativeClickByLabel("Previous part"), "document.querySelector('#large-tool-result .large-text-preview')?.dataset.pageIndex === '0'"));
  timings.push(await nativeAction("text input", async () => {
    await nativeClick("native-input");
    for (const event of [
      { type: "keyDown", keyCode: "X" },
      { type: "char", keyCode: "x" },
      { type: "keyUp", keyCode: "X" },
    ]) windowRef.webContents.sendInputEvent(event);
  }, "window.readRendererProbe().inputValue === 'x'"));
  timings.push(await nativeAction("session switch", () => nativeClick("switch-session"), "window.readRendererProbe().activeSession === 'session-b'"));
  timings.push(await nativeAction("return to streaming session", () => nativeClick("switch-session"), "window.readRendererProbe().activeSession === 'session-a'"));
  timings.push(await nativeAction("collapse transcript", () => nativeClick("toggle-collapse"), "window.readRendererProbe().collapsed === true"));
  timings.push(await nativeAction("expand transcript", () => nativeClick("toggle-collapse"), "window.readRendererProbe().collapsed === false"));
  const toolPageCount = await evaluate("Number(document.querySelector('#large-tool-result .large-text-preview')?.dataset.pageCount ?? 0)");
  for (let page = 2; page <= toolPageCount; page += 1) {
    await nativeClickByLabel("Next part");
    await until(
      "document.querySelector('#large-tool-result .large-text-preview')?.dataset.pageIndex === " + JSON.stringify(String(page - 1)),
      "tool output page " + page,
    );
  }
  const toolOutputTailMarker = await evaluate("document.querySelector('#large-tool-result .large-text-preview pre')?.textContent?.includes('tool-result-final-marker') === true");
  if (!toolOutputTailMarker) throw new Error("last tool-output page lost its final marker");
  timings.push(await nativeAction("transcript scroll", async () => {
    await nativeClick("scroll-area");
    windowRef.webContents.sendInputEvent({ type: "keyDown", keyCode: "PageDown" });
    windowRef.webContents.sendInputEvent({ type: "keyUp", keyCode: "PageDown" });
  }, "document.getElementById('scroll-area').scrollTop > 0"));
  const scrollTop = await evaluate("document.getElementById('scroll-area').scrollTop");

  const producerCode = await new Promise((resolve, reject) => {
    producer.once("error", reject);
    producer.once("close", resolve);
  });
  clearInterval(flushTimer);
  if (producerError) throw producerError;
  await flush();
  await delivery;
  if (producerCode !== 0 || lastSequence !== 180) throw new Error("independent producer did not finish all ordered deltas");
  await evaluate("window.finishRendererStream()");
  await wait(100);
  await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  const sourceMatches = await evaluate("window.verifyRendererSource(" + JSON.stringify(expected) + ")");
  const finalSnapshot = await evaluate("({ ...window.readRendererProbe(), finalMarker: document.getElementById('message').textContent.includes('final-sequence-180'), largeToolOutputPaged: window.verifyLargeToolOutput(), streamingToolTracksLatest: Number(document.querySelector('#streaming-tool-result .large-text-preview')?.dataset.pageIndex) === Number(document.querySelector('#streaming-tool-result .large-text-preview')?.dataset.pageCount) - 1 })");
  const sorted = timings.map((item) => item.durationMs).sort((a, b) => a - b);
  const p95Ms = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
  const result = {
    ok: sourceMatches && finalSnapshot.sequence === 180 && !finalSnapshot.streaming && finalSnapshot.finalMarker && finalSnapshot.largeToolOutputPaged && finalSnapshot.streamingToolTracksLatest && toolOutputTailMarker && scrollTop > 0 && p95Ms <= 100,
    sourceMatches,
    sequence: finalSnapshot.sequence,
    finalSourceLength: finalSnapshot.receivedSource.length,
    finalMarker: finalSnapshot.finalMarker,
    toolOutputTailMarker,
    scrollTop,
    timings,
    p95Ms,
    producerCode,
    environment: { electron: process.versions.electron, chromium: process.versions.chrome, node: process.versions.node, platform: process.platform },
  };
  clearTimeout(timeout);
  console.log("RENDERER_RESPONSIVENESS " + JSON.stringify(result));
  app.quit();
}).catch(fail);
`;
  await writeFile(join(temp, "main.cjs"), mainSource);

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronBinary, [join(temp, "main.cjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (data) => { output += data; });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 35_000);
  let code;
  try {
    code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
  } finally {
    clearTimeout(timeout);
  }
  const line = output.split(/\r?\n/).find((entry) => entry.startsWith("RENDERER_RESPONSIVENESS "));
  assert(line, `Electron returned no responsiveness result (exit=${code}): ${output.slice(-4000)}`);
  const result = JSON.parse(line.slice("RENDERER_RESPONSIVENESS ".length));
  console.log("RENDERER_RESPONSIVENESS " + JSON.stringify(result));
  assert.equal(code, 0, output.slice(-6000));
  assert.equal(result.ok, true, JSON.stringify(result));
} finally {
  await rm(temp, { recursive: true, force: true });
}
