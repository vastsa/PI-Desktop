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
    define: { "process.env.NODE_ENV": '"production"' },
    alias: {
      "@pi-desktop/i18n": join(root, "packages/i18n/src/index.ts"),
      react: join(root, "apps/desktop/node_modules/react"),
      "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
    },
    nodePaths: [join(root, "apps/desktop/node_modules")],
  });
  await build({
    entryPoints: [join(root, "apps/desktop/electron/main/composer-paste.ts")],
    outfile: join(temp, "writer.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
  });
  await writeFile(
    join(temp, "native-image.png"),
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jNnsAAAAASUVORK5CYII=",
      "base64",
    ),
  );
  await writeFile(join(temp, "native notes.txt"), "native file bytes");
  await writeFile(
    join(temp, "composer.css"),
    await readFile(join(root, "apps/desktop/src/styles/composer.css")),
  );
  await writeFile(
    join(temp, "index.html"),
    `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'"><link rel="stylesheet" href="composer.css"><body><input id="native-files" type="file" multiple hidden><script src="renderer.js"></script>`,
  );
  await writeFile(
    join(temp, "main.cjs"),
    `
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("node:path");
const fs = require("node:fs/promises");
const assert = require("node:assert/strict");
const { saveComposerPasteFiles } = require("./writer.cjs");
app.setPath("userData", path.join(__dirname, "profile"));
const saved = [];
const history = [];
ipcMain.handle("pi-desktop/composer/pasteFiles", async (_event, input) => {
  const files = await saveComposerPasteFiles(__dirname, input.sessionId, input.files);
  for (let i = 0; i < files.length; i++) {
    assert.deepEqual(await fs.readFile(files[i].path), Buffer.from(input.files[i].data));
  }
  saved.push({
    sessionId: input.sessionId,
    files,
    mimeTypes: input.files.map((entry) => entry.mimeType),
  });
  return { ok: true, data: { files } };
});
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
    const result = await window.webContents.executeJavaScript("globalThis.composerPasteProbe()");
    const mimeSets = saved.map((entry) => entry.mimeTypes.join("+"));
    assert.equal(
      saved.length,
      4,
      "unexpected scratch writes (large text, image-only, native image, native files): " + JSON.stringify(mimeSets),
    );
    assert.deepEqual(
      mimeSets.filter((mimes) => mimes === "text/plain"),
      ["text/plain"],
      "Word text must be the only text-only write: " + JSON.stringify(mimeSets),
    );
    assert.equal(
      mimeSets.filter((mimes) => mimes.includes("image/png")).length,
      3,
      "image-only and native-file pastes must keep writing image bytes: " + JSON.stringify(mimeSets),
    );
    assert(history.some(text => text.includes("Word paragraph")), "short text missing from clipboard history");
    console.log("COMPOSER_PASTE_PROBE " + JSON.stringify({ ...result, scratchBytesVerified: true }));
    app.quit();
  } catch (error) {
    console.error("COMPOSER_PASTE_PROBE " + JSON.stringify({ ok: false, error: String(error), savedCount: saved.length }));
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
