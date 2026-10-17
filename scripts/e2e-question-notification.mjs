#!/usr/bin/env node
/** Isolated React/Chromium user path for question-toast navigation. No provider calls. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveElectronBinary } from "./e2e/boot.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "packages/agent-runtime/package.json"));
const { build } = require("esbuild");
const { electronBinary } = resolveElectronBinary(root);
const temp = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "pi-question-notification-"));
try {
  await build({
    entryPoints: [join(root, "scripts/e2e/question-notification.tsx")],
    outfile: join(temp, "renderer.js"), bundle: true, platform: "browser", format: "iife",
    jsx: "automatic", loader: { ".css": "empty" },
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "false" },
    alias: {
      "@pi-desktop/i18n": join(root, "packages/i18n/src/index.ts"),
      "@pi-desktop/shared/protocol": join(root, "packages/shared/src/protocol.ts"),
      "@pi-desktop/shared": join(root, "packages/shared/src/index.ts"),
      react: join(root, "apps/desktop/node_modules/react"),
      "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
    },
    nodePaths: [join(root, "apps/desktop/node_modules")],
  });
  // Use the production toast rules; no app build or existing user profile required.
  const styles = await Promise.all(["ui-kit.css", "overlays.css"].map((name) =>
    readFile(join(root, "apps/desktop/src/styles", name), "utf8")));
  await writeFile(join(temp, "index.html"), `<!doctype html><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'">
<style>:root { --motion-duration-normal: 200ms; --motion-duration-fast: 150ms;
--motion-ease-in: ease-in; --motion-ease-out: ease-out; }${styles.join("\n")}</style>
<script src="renderer.js"></script>`);
  await writeFile(join(temp, "main.cjs"), `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: true, title: "Question notification regression", width: 1000, height: 800,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.on("console-message", (event) => console.error(event.message));
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    win.focus();
    const result = await win.webContents.executeJavaScript("globalThis.questionNotificationProbe()");
    console.log("QUESTION_POINTER_CHECKS " + JSON.stringify(result));
    for (const keyCode of ["Return", "Space"]) {
      console.log("QUESTION_KEYBOARD_CHECK " + keyCode);
      await win.webContents.executeJavaScript("globalThis.prepareQuestionNotificationKeyboard()");
      win.webContents.sendInputEvent({ type: "keyDown", keyCode });
      win.webContents.sendInputEvent({ type: "char", keyCode: keyCode === "Return" ? "\\r" : " " });
      win.webContents.sendInputEvent({ type: "keyUp", keyCode });
      await win.webContents.executeJavaScript("globalThis.finishQuestionNotificationKeyboard()");
    }
    console.log("QUESTION_NOTIFICATION_PROBE " + JSON.stringify({ ...result, keyboard: true }));
    app.exit(0);
  } catch (error) {
    console.error("QUESTION_NOTIFICATION_PROBE " + JSON.stringify({ ok: false, error: error?.stack ?? String(error) }));
    app.exit(1);
  }
});
`);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronBinary, [join(temp, "main.cjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (data) => { output += data; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 45_000);
  let code;
  try {
    code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
  } finally { clearTimeout(timer); }
  const line = output.split(/\r?\n/).find((item) => item.startsWith("QUESTION_NOTIFICATION_PROBE "));
  assert(line, `No probe result (exit=${code}): ${output.slice(-6000)}`);
  const result = JSON.parse(line.slice("QUESTION_NOTIFICATION_PROBE ".length));
  console.log("QUESTION_NOTIFICATION_PROBE " + JSON.stringify(result));
  assert.equal(code, 0, output.slice(-6000));
  assert.equal(result.ok, true, result.error);
  console.log("question notification navigation: ok");
} finally { await rm(temp, { recursive: true, force: true }); }
