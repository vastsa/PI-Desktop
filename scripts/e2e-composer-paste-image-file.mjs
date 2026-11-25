#!/usr/bin/env node
/**
 * Issue #2529: a screenshot tool (PixPin) puts a temporary image *file* on the
 * OS clipboard. Pasting it into the Composer must attach an image that reaches
 * a vision model as image bytes, even after the tool deletes its temp file.
 *
 * Real Desktop, preload, native clipboard, Host SQLite and agent sidecar; only
 * the model is a local Chat Completions fixture. macOS only: the clipboard is
 * written through NSPasteboard exactly like a Finder/PixPin file copy.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertDesktopBuild, resolveElectronBinary } from "./e2e/boot.mjs";
import { Host, resolveHostBinary } from "./e2e/host.mjs";
import { createSession } from "./e2e/session.mjs";
import { waitFor } from "./e2e/wait.mjs";

if (process.platform !== "darwin") {
  console.log("COMPOSER_PASTE_IMAGE_FILE_E2E skipped: native pasteboard fixture requires macOS");
  process.exit(0);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
assertDesktopBuild(root);
const scratch = await realpath(await mkdtemp(join(tmpdir(), "pi-paste-image-file-")));
const dataDir = join(scratch, "data");
const project = join(scratch, "project");
// Outside the project, like %LOCALAPPDATA%\PixPin\Temp.
const screenshotTemp = join(scratch, "PixPin", "Temp");
const screenshot = join(screenshotTemp, "PixPin_2026-11-23_14-37-54.png");
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4nGP4z8DwHwyBNBMDAwMDAwBn9Qf+5cS6cAAAAABJRU5ErkJggg==",
  "base64",
);
const requests = [];
const checks = [];
let child;
let ws;
let passed = false;

const provider = createServer(async (request, response) => {
  if (!request.url.endsWith("/chat/completions")) {
    response.writeHead(404); response.end("{}"); return;
  }
  let body = "";
  for await (const chunk of request) body += chunk;
  const payload = JSON.parse(body);
  requests.push(payload);
  const base = { id: `paste-image-${requests.length}`, object: "chat.completion.chunk", created: 1, model: payload.model };
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const chunk of [
    { ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Screenshot received." }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } },
  ]) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  response.end("data: [DONE]\n\n");
});

/** Write file URLs to the general pasteboard the way Finder and PixPin do. */
function copyFilesToPasteboard(paths) {
  const script = `ObjC.import("AppKit");
const board = $.NSPasteboard.generalPasteboard;
board.clearContents;
const urls = ${JSON.stringify(paths)}.map(path => $.NSURL.fileURLWithPath(path));
if (!board.writeObjects($(urls))) throw new Error("pasteboard write failed");`;
  execFileSync("/usr/bin/osascript", ["-l", "JavaScript", "-e", script]);
}

function clearPasteboard() {
  execFileSync("/usr/bin/osascript", ["-l", "JavaScript", "-e", 'ObjC.import("AppKit"); $.NSPasteboard.generalPasteboard.clearContents;']);
}

try {
  await mkdir(project, { recursive: true });
  await mkdir(screenshotTemp, { recursive: true });
  await writeFile(screenshot, PNG);
  await new Promise((done, fail) => { provider.once("error", fail); provider.listen(0, "127.0.0.1", done); });

  const hostBin = resolveHostBinary();
  const host = new Host(hostBin, dataDir, { quiet: true, env: { PI_DESKTOP_AGENTS_DIR: join(scratch, "agents") } });
  let sessionId;
  await host.start();
  try {
    const created = await host.call("providers.create", {
      name: "Vision fixture", type: "openai_compatible", apiStyle: "chat_completions",
      baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, authKind: "api_key", secretValue: "vision-fixture-key",
      models: [{ id: "vision-fixture", contextWindow: 128000, maxTokens: 4096, thinkingLevels: ["off"], supportsImages: true }],
      defaultModelId: "vision-fixture",
    });
    await host.call("settings.set", {
      defaultProviderId: created.provider.id, defaultModelId: "vision-fixture", defaultMode: "agent", locale: "en",
    });
    sessionId = (await createSession(host, project, "Pasted screenshot file")).id;
    await host.call("session.configure", { id: sessionId, mode: "agent", permissionMode: "auto" });
  } finally { await host.stop(); }

  const { appDir, electronBinary } = resolveElectronBinary(root);
  const port = Number(process.env.PI_PASTE_IMAGE_CDP_PORT || 9391);
  const env = {
    ...process.env, PI_DESKTOP_DATA_DIR: dataDir, PI_DESKTOP_HOST_BIN: hostBin,
    PI_DESKTOP_AGENTS_DIR: join(scratch, "agents"), PI_CODING_AGENT_DIR: join(scratch, "agent"),
    ELECTRON_RENDERER_URL: "", PI_DESKTOP_START_MAXIMIZED: "0",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(electronBinary, [`--remote-debugging-port=${port}`, `--user-data-dir=${join(scratch, "profile")}`, "."], {
    cwd: appDir, env, stdio: ["ignore", "pipe", "pipe"], detached: true,
  });
  let output = "";
  child.stdout.on("data", (data) => { output += data; });
  child.stderr.on("data", (data) => { output += data; });

  let target;
  await waitFor(async () => {
    try {
      target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json())
        .find((entry) => entry.type === "page" && entry.url.includes("index.html") && !entry.url.includes("plugin-launcher"));
      return !!target;
    } catch { return false; }
  }, 30_000, "desktop CDP target");
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await once(ws, "open");
  let sequence = 0;
  const pending = new Map();
  ws.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
    else entry.resolve(message.result);
  };
  const send = (method, params = {}) => new Promise((done, fail) => {
    const id = ++sequence;
    pending.set(id, { resolve: done, reject: fail });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const key = async (params) => {
    await send("Input.dispatchKeyEvent", { type: "keyDown", ...params });
    await send("Input.dispatchKeyEvent", { type: "keyUp", ...params, commands: undefined, text: undefined });
  };

  await waitFor(() => evaluate("typeof window.__PI_DESKTOP__?.selectSession === 'function' && !!document.querySelector('.app-shell:not(.app-shell-boot):not(.is-booting)')"), 30_000, "desktop shell");
  await evaluate("window.__PI_DESKTOP__.skipStartupOverlays()");
  await evaluate(`window.__PI_DESKTOP__.selectSession(${JSON.stringify(sessionId)})`);
  await waitFor(() => evaluate("!!document.querySelector('.composer-input[contenteditable=\"true\"]')"), 20_000, "composer");
  await evaluate(`(() => {
    window.__pasteProbe = [];
    document.querySelector('.composer-input[contenteditable="true"]').addEventListener("paste", (event) => {
      window.__pasteProbe.push({ types: [...event.clipboardData.types], files: [...event.clipboardData.files].map(file => file.name + ":" + file.type) });
    }, { capture: true });
  })()`);
  const focusComposer = async () => {
    await send("Page.bringToFront");
    await evaluate(`(() => {
      const editor = document.querySelector('.composer-input[contenteditable="true"]');
      editor.focus();
      const range = document.createRange(); range.selectNodeContents(editor); range.collapse(false);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    })()`);
  };

  // The general pasteboard is shared with the rest of the desktop session; a
  // clipboard manager (for example Clipy) can briefly replace it. Retry only
  // when Chromium saw an empty pasteboard, never when the Composer got a file.
  for (let attempt = 1; ; attempt += 1) {
    copyFilesToPasteboard([screenshot]);
    await new Promise((done) => setTimeout(done, 300 * attempt));
    await focusComposer();
    await key({ key: "v", code: "KeyV", windowsVirtualKeyCode: 86, modifiers: 4, commands: ["paste"] });
    await waitFor(() => evaluate("window.__pasteProbe.length > 0"), 5_000, "paste event");
    const probe = await evaluate("window.__pasteProbe.pop()");
    if (probe.types.includes("Files")) break;
    if (attempt === 3) throw new Error(`paste never carried a file: ${JSON.stringify(probe)}`);
    console.log(`paste attempt ${attempt} saw an empty pasteboard; retrying`);
  }
  await waitFor(() => evaluate(`!!document.querySelector('.composer-chip')`), 15_000, "pasted file chip");
  const chip = await evaluate(`(() => {
    const chip = document.querySelector('.composer-chip');
    return { text: chip.textContent, image: chip.dataset.image !== undefined };
  })()`);
  assert(chip.text.includes("PixPin_2026-11-23_14-37-54.png"), `unexpected chip: ${chip.text}`);
  assert.equal(chip.image, true, "pasted image file must render as an image chip, not a file reference");
  checks.push("native pasteboard image file pastes as an image chip");

  // PixPin clears its temp directory; the draft must not depend on the source.
  await rm(screenshot);
  await send("Input.insertText", { text: "What is in this screenshot?" });
  await key({ key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await waitFor(() => requests.length > 0, 30_000, "model request");
  const readSession = async () => {
    const result = await evaluate(`window.piDesktop.invoke(window.piDesktop.channels.invoke.sessionGet, ${JSON.stringify(sessionId)})`);
    assert.equal(result.ok, true, JSON.stringify(result.error));
    return result.data.session;
  };
  await waitFor(async () => JSON.stringify((await readSession()).messages.filter((entry) => entry.role === "assistant"))
    .includes("Screenshot received."), 30_000, "persisted assistant reply");

  const user = [...requests[0].messages].reverse().find((message) => message.role === "user");
  const parts = Array.isArray(user.content) ? user.content : [{ type: "text", text: user.content }];
  const images = parts.filter((part) => part.type === "image_url");
  assert.equal(images.length, 1, `vision model must receive one image part: ${JSON.stringify(parts).slice(0, 600)}`);
  assert.equal(images[0].image_url.url, `data:image/png;base64,${PNG.toString("base64")}`);
  const text = parts.filter((part) => part.type === "text").map((part) => part.text).join("\n");
  assert(!text.includes("Local file references"), "image must not be sent as a local file reference");
  assert(!text.includes(screenshot), "deleted temp path must not be the image source");
  checks.push("vision model receives the exact PNG bytes after the temp file was deleted");

  const message = (await readSession()).messages.find((entry) => entry.role === "user");
  assert.equal(message.attachments.length, 1);
  const [attachment] = message.attachments;
  assert.equal(attachment.kind, "image");
  assert.equal(attachment.localReference, undefined);
  const hash = createHash("sha256").update(PNG).digest("hex");
  assert.equal(attachment.ref, `attachments/${hash}`);
  assert.deepEqual(await readFile(join(dataDir, "attachments", hash)), PNG);
  checks.push("transcript stores a durable content-addressed image attachment");

  passed = true;
  console.log("COMPOSER_PASTE_IMAGE_FILE_E2E " + JSON.stringify({ ok: true, checks }));
} catch (error) {
  if (ws?.readyState === WebSocket.OPEN) {
    console.error("SHELL_STATE", await new Promise((done) => {
      const id = 1e9;
      ws.onmessage = ({ data }) => { const message = JSON.parse(data); if (message.id === id) done(message.result?.result?.value); };
      ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression: "document.body.innerText.slice(-2000)", returnByValue: true } }));
      setTimeout(() => done("<unavailable>"), 3000);
    }));
  }
  throw error;
} finally {
  try { clearPasteboard(); } catch {}
  ws?.close();
  if (child && child.exitCode === null) {
    try { process.kill(-child.pid, "SIGTERM"); } catch {}
    const exited = await Promise.race([once(child, "close").then(() => true), new Promise((done) => setTimeout(() => done(false), 5000))]);
    if (!exited) try { process.kill(-child.pid, "SIGKILL"); } catch {}
  }
  provider.closeAllConnections();
  await new Promise((done) => provider.close(done));
  if (passed && process.env.E2E_KEEP_ARTIFACTS !== "1") await rm(scratch, { recursive: true, force: true });
  else console.log(`Paste image file artifacts: ${scratch}`);
}
