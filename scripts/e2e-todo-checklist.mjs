#!/usr/bin/env node
/** Real SQLite/stdiorpc host and production TodoDock in an isolated Electron renderer. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { IPC } from "../packages/shared/dist/index.js";
import { repositoryRoot, resolveElectronBinary } from "./e2e/boot.mjs";
import { resolveHostBinary } from "./e2e/host.mjs";

const root = repositoryRoot();
const hostBinary = resolveHostBinary();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");
const temp = await mkdtemp(join(tmpdir(), "pi-todo-checklist-"));
try {
  await build({ entryPoints: [join(root, "scripts/e2e/todo-checklist.tsx")],
    outfile: join(temp, "renderer.js"), bundle: true, platform: "browser", format: "esm", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "false" },
    alias: { "@pi-desktop/i18n": join(root, "packages/i18n/src/index.ts"),
      "@pi-desktop/shared": join(root, "packages/shared/src/index.ts"),
      react: join(root, "apps/desktop/node_modules/react"),
      "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
      i18next: join(root, "apps/desktop/node_modules/i18next"),
      "react-i18next": join(root, "apps/desktop/node_modules/react-i18next") },
    nodePaths: [join(root, "apps/desktop/node_modules")],
  });
  const renderer = join(root, "apps/desktop/out/renderer");
  const html = await readFile(join(renderer, "index.html"), "utf8");
  const css = [...html.matchAll(/href="([^" ]+\.css)"/g)].map((match) => match[1]);
  assert(css.length, "Run pnpm build:js before this test");
  await cp(join(renderer, "assets"), join(temp, "assets"), { recursive: true });
  await writeFile(join(temp, "index.html"), `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:">${css.map((path) => `<link rel="stylesheet" href="${path}">`).join("")}</head><body><div id="root"></div><script type="module" src="renderer.js"></script></body></html>`);
  await writeFile(join(temp, "preload.cjs"), `
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("piDesktop", {
  platform: process.platform,
  invoke: (channel, input) => ipcRenderer.invoke("fixture:invoke", channel, input),
  on: (channel, listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
});
contextBridge.exposeInMainWorld("todoFixture", { action: (name, input) => ipcRenderer.invoke("fixture:action", name, input) });
`);
  await writeFile(join(temp, "main.cjs"), `
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("node:path");
const channels = ${JSON.stringify({ get: IPC.invoke.todosGet, changed: IPC.event.todosChanged, host: IPC.event.hostStatus })};
app.setPath("userData", path.join(__dirname, "profile"));
let DesktopAgentRuntime, createAssistantMessageEventStream, host, win, failRead = false, suppressEvents = false, readCount = 0, readFailures = 0;
function forwardNotifications() {
  host.notifications.push = function (...notes) {
    for (const note of notes) if (!suppressEvents && note.method === "todos.changed") win.webContents.send(channels.changed, note.params);
    return Array.prototype.push.apply(this, notes);
  };
}
app.whenReady().then(async () => {
  try {
    const { Host } = await import(${JSON.stringify(pathToFileURL(join(root, "scripts/e2e/host.mjs")).href)});
    ({ DesktopAgentRuntime } = await import(${JSON.stringify(pathToFileURL(join(root, "packages/agent-runtime/dist/index.js")).href)}));
    ({ createAssistantMessageEventStream } = await import(${JSON.stringify(pathToFileURL(join(root, "packages/agent-runtime/node_modules/@earendil-works/pi-ai/dist/index.js")).href)}));
    host = new Host(${JSON.stringify(hostBinary)}, path.join(__dirname, "host-data"));
    await host.start();
    win = new BrowserWindow({ show: false, width: 1000, height: 720,
      webPreferences: { preload: path.join(__dirname, "preload.cjs"), sandbox: true,
        contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    win.webContents.on("console-message", (event) => console.error(event.message));
    forwardNotifications();
    ipcMain.handle("fixture:invoke", async (_event, channel, input) => {
      if (channel !== channels.get) throw new Error("Unexpected fixture IPC: " + channel);
      readCount++;
      if (failRead) { failRead = false; readFailures++; return { ok: false, error: { code: "HOST_NOT_READY", message: "Injected first read failure" } }; }
      try { return { ok: true, data: await host.call("todos.get", input, 10000) }; }
      catch (error) { return { ok: false, error: { code: error.errorCode || "INTERNAL", message: error.message } }; }
    });
    ipcMain.handle("fixture:action", async (_event, name, input) => {
      switch (name) {
        case "create": return (await host.call("session.create", { title: input, mode: "agent" }, 10000)).session.id;
        case "write": {
          const { turnId } = await host.call("session.beginTurn", { sessionId: input.sessionId }, 10000);
          const requests = [];
          let round = 0;
          const runtime = new DesktopAgentRuntime({ host, sessionId: input.sessionId, turnId, mode: "agent",
            provider: { id: "todo-fixture", name: "Deterministic Todo fixture", baseUrl: "http://127.0.0.1:1/v1",
              modelId: "local-model", apiKey: "", authKind: "none", supportsReasoning: false, supportedThinkingLevels: ["off"] },
            commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
            thinkingLevel: "off", onEvent: () => undefined,
          });
          // Replace only the external model transport. Discovery, argument validation,
          // execution, host RPC, SQLite, notifications and result replay stay real.
          runtime.models = { streamSimple: (_model, context) => {
            requests.push({ ...context, messages: [...context.messages] });
            round++;
            const toolCall = round === 1
              ? { type: "toolCall", id: "discover-todos", name: "ToolSearch", arguments: { query: "TodoWrite" } }
              : round === 2 ? { type: "toolCall", id: "write-todos", name: "TodoWrite", arguments: { todos: input.todos } } : undefined;
            const message = { role: "assistant", api: "openai-completions", provider: "todo-fixture", model: "local-model",
              content: toolCall ? [toolCall] : [{ type: "text", text: "Checklist updated." }],
              usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
              stopReason: toolCall ? "toolUse" : "stop", timestamp: round };
            const stream = createAssistantMessageEventStream();
            queueMicrotask(() => { stream.push({ type: "start", partial: message });
              stream.push({ type: "done", reason: toolCall ? "toolUse" : "stop", message }); stream.end(message); });
            return stream;
          } };
          try {
            await runtime.prompt("Track the requested implementation checklist.", "fixture-user-" + Date.now(), turnId);
            const result = requests.at(-1)?.messages.find(message => message.role === "toolResult" && message.toolCallId === "write-todos");
            if (!result || result.isError) throw new Error("Agent TodoWrite did not replay a successful tool result: " + JSON.stringify(result));
            const stored = await host.call("todos.get", { sessionId: input.sessionId }, 10000);
            return { ...stored, toolResultText: result.content.filter(block => block.type === "text").map(block => block.text).join(" ") };
          } finally {
            await runtime.dispose();
            await host.call("session.endTurn", { turnId, status: "completed", createNotification: false }, 10000);
          }
        }
        case "restart": await host.restart(); forwardNotifications(); return;
        case "ready": win.webContents.send(channels.host, { ok: false, component: "host" }); win.webContents.send(channels.host, { ok: true, component: "host", restarted: true }); return;
        case "event": win.webContents.send(channels.changed, input); return;
        case "failRead": failRead = true; return;
        case "suppressEvents": suppressEvents = input; return;
        case "readCount": return readCount;
        case "readFailures": return readFailures;
        default: throw new Error("Unknown action: " + name);
      }
    });
    const watchdog = setTimeout(async () => { console.error("Todo checklist scenario timed out"); await host.stop(); app.exit(1); }, 50000);
    await win.loadFile(path.join(__dirname, "index.html"));
    const result = await win.webContents.executeJavaScript("window.todoChecklistProbe()");
    console.log("TODO_CHECKLIST " + JSON.stringify(result));
    clearTimeout(watchdog);
    await host.stop(); app.exit(0);
  } catch (error) { console.error(error); await host?.stop(); app.exit(1); }
});
`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(resolveElectronBinary(root).electronBinary, [join(temp, "main.cjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { output += chunk; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
  let code;
  try { code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); }); }
  finally { clearTimeout(timer); }
  assert.equal(code, 0, output);
  const result = output.split(/\r?\n/).find((line) => line.startsWith("TODO_CHECKLIST "));
  assert(result, output);
  console.log(result);
} finally { await rm(temp, { recursive: true, force: true }); }
