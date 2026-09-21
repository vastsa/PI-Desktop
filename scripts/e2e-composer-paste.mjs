#!/usr/bin/env node
/** Composer paste regression with real React hooks, preload, and scratch writer. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
const temp = await mkdtemp(join(tmpdir(), "pi-composer-paste-"));
try {
  await build({
    entryPoints: [join(root, "scripts/e2e/composer-paste.tsx")],
    outfile: join(temp, "renderer.js"),
    bundle: true,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    loader: { ".woff": "file", ".woff2": "file", ".ttf": "file" },
    define: { "process.env.NODE_ENV": '"production"' },
    alias: {
      "@pi-desktop/i18n": join(root, "packages/i18n/src/index.ts"),
      react: join(root, "apps/desktop/node_modules/react"),
      "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
    },
    nodePaths: [join(root, "apps/desktop/node_modules")],
  });
  await build({
    entryPoints: {
      writer: join(root, "apps/desktop/electron/main/composer-paste.ts"),
      reader: join(root, "packages/host-runtime/src/workspace-files.ts"),
    },
    outdir: temp,
    outExtension: { ".js": ".cjs" },
    bundle: true,
    platform: "node",
    format: "cjs",
  });
  await writeFile(
    join(temp, "native-image.png"),
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNo2PDgPwAG1AMQ/5r/oAAAAABJRU5ErkJggg==",
      "base64",
    ),
  );
  await writeFile(join(temp, "native notes.txt"), "native file bytes");
  await writeFile(join(temp, "tokens.css"), (await readFile(join(root, "apps/desktop/src/styles/tokens.css"), "utf8")).replace(/@theme(?: inline)?/g, ":root"));
  await writeFile(
    join(temp, "composer.css"),
    await readFile(join(root, "apps/desktop/src/styles/composer.css")),
  );
  await writeFile(
    join(temp, "index.html"),
    `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:"><link rel="stylesheet" href="tokens.css"><link rel="stylesheet" href="composer.css"><link rel="stylesheet" href="renderer.css"><body><input id="native-files" type="file" multiple hidden><script src="renderer.js"></script>`,
  );
  await writeFile(
    join(temp, "main.cjs"),
    `
const { app, BrowserWindow, ipcMain, nativeImage } = require("electron");
const path = require("node:path");
const fs = require("node:fs/promises");
const assert = require("node:assert/strict");
const { saveComposerPasteFiles } = require("./writer.cjs");
const { readOpenableFile, readOpenableImage } = require("./reader.cjs");
app.setPath("userData", path.join(__dirname, "profile"));
const saved = [];
const history = [];
ipcMain.handle("pi-desktop/composer/pasteFiles", async (_event, input) => {
  const files = await saveComposerPasteFiles(__dirname, input.sessionId, input.files);
  for (let i = 0; i < files.length; i++) {
    assert.deepEqual(await fs.readFile(files[i].path), Buffer.from(input.files[i].data));
  }
  if (input.files.some(file => file.mimeType.startsWith("image/"))) {
    const wide = nativeImage.createFromBuffer(await fs.readFile(path.join(__dirname, "native-image.png"))).resize({ width: 1200, height: 600 }).toPNG();
    await fs.writeFile(path.join(path.dirname(files[0].path), "wide-fixture.png"), wide);
    await fs.writeFile(path.join(path.dirname(files[0].path), "corrupt-fixture.png"), Buffer.from("invalid PNG fixture"));
  }
  saved.push({
    sessionId: input.sessionId,
    files,
    mimeTypes: input.files.map((entry) => entry.mimeType),
  });
  return { ok: true, data: { files } };
});
ipcMain.handle("pi-desktop/fs/readImageDataUrl", async (_event, input) => ({
  ok: true,
  data: await readOpenableImage(input.ref, null, [path.join(__dirname, "scratch")], input.mimeType),
}));
ipcMain.handle("pi-desktop/fs/read", async (_event, input) => ({
  ok: true,
  data: await readOpenableFile(input.path, null, [path.join(__dirname, "scratch")], input.mimeType),
}));
ipcMain.handle("pi-desktop/clipboard/recordPaste", (_event, input) => {
  history.push(input.text);
  return { ok: true, data: null };
});
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: {
    preload: ${JSON.stringify(join(root, "apps/desktop/out/preload/index.cjs"))},
    sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
  } });
  window.webContents.on("console-message", (event) => console.error(event.message));
  try {
    await window.loadFile(path.join(__dirname, "index.html"));
    window.webContents.debugger.attach("1.3");
    const { root } = await window.webContents.debugger.sendCommand("DOM.getDocument");
    const { nodeId } = await window.webContents.debugger.sendCommand("DOM.querySelector", { nodeId: root.nodeId, selector: "#native-files" });
    await window.webContents.debugger.sendCommand("DOM.setFileInputFiles", { nodeId, files: [path.join(__dirname, "native-image.png"), path.join(__dirname, "native notes.txt")] });
    window.webContents.on("console-message", async (event) => {
      if (!event.message.startsWith("PI_PREVIEW_KEY:")) return;
      const key = event.message.slice("PI_PREVIEW_KEY:".length);
      assert(["Escape", "Tab"].includes(key));
      window.webContents.sendInputEvent({ type: "keyDown", keyCode: key });
      window.webContents.sendInputEvent({ type: "keyUp", keyCode: key });
    });
    await window.webContents.executeJavaScript('globalThis.composerPreviewPressKey = key => new Promise(resolve => { document.addEventListener("keyup", () => requestAnimationFrame(resolve), { once: true }); console.log("PI_PREVIEW_KEY:" + key); }); void 0');
    if (process.env.PI_COMPOSER_PREVIEW_SCREENSHOT) {
      window.webContents.on("console-message", async (event) => {
        if (event.message !== "PI_PREVIEW_CAPTURE") return;
        await fs.writeFile(process.env.PI_COMPOSER_PREVIEW_SCREENSHOT, (await window.webContents.capturePage()).toPNG());
        await window.webContents.executeJavaScript("globalThis.composerPreviewCaptureDone()");
      });
      await window.webContents.executeJavaScript('globalThis.composerPreviewCapture = () => new Promise(resolve => { globalThis.composerPreviewCaptureDone = resolve; console.log("PI_PREVIEW_CAPTURE"); }); void 0');
    }
    window.webContents.on("console-message", async (event) => {
      if (!event.message.startsWith("PI_PREVIEW_POINTER:")) return;
      const input = JSON.parse(event.message.slice("PI_PREVIEW_POINTER:".length));
      assert(["mousePressed", "mouseMoved", "mouseReleased"].includes(input.type));
      await window.webContents.debugger.sendCommand("Input.dispatchMouseEvent", {
        ...input, button: "left", buttons: input.type === "mouseReleased" ? 0 : 1, clickCount: 1,
      });
      await window.webContents.executeJavaScript("globalThis.composerPreviewPointerDone()");
    });
    await window.webContents.executeJavaScript('globalThis.composerPreviewPointer = input => new Promise(resolve => { globalThis.composerPreviewPointerDone = resolve; console.log("PI_PREVIEW_POINTER:" + JSON.stringify(input)); }); void 0');
    const result = await window.webContents.executeJavaScript("globalThis.composerPasteProbe()");
    const mimeSets = saved.map((entry) => entry.mimeTypes.join("+"));
    assert.equal(
      saved.length,
      5,
      "unexpected scratch writes (large text, image-only, native image, empty image-only, native files): " + JSON.stringify(mimeSets),
    );
    assert.deepEqual(
      mimeSets.filter((mimes) => mimes === "text/plain"),
      ["text/plain"],
      "Word text must be the only text-only write: " + JSON.stringify(mimeSets),
    );
    assert.equal(
      mimeSets.filter((mimes) => mimes.includes("image/png")).length,
      4,
      "image-only and native-file pastes must keep writing image bytes: " + JSON.stringify(mimeSets),
    );
    assert(history.some(text => text.includes("Word paragraph")), "short text missing from clipboard history");
    console.log("COMPOSER_PASTE_PROBE " + JSON.stringify({ ...result, scratchBytesVerified: true }));
    app.quit();
  } catch (error) {
    console.error("COMPOSER_PASTE_PROBE " + JSON.stringify({ ok: false, error: String(error), stack: error?.stack, savedCount: saved.length }));
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
    .find((line) => line.startsWith("COMPOSER_PASTE_PROBE "));
  assert(
    line,
    `renderer returned no result (exit=${code}): ${output.slice(-3000)}`,
  );
  const result = JSON.parse(line.slice("COMPOSER_PASTE_PROBE ".length));
  console.log("COMPOSER_PASTE_PROBE " + JSON.stringify(result));
  assert.equal(code, 0, output.slice(-4000));
  assert.equal(result.ok, true);
} finally {
  await rm(temp, { recursive: true, force: true });
}
