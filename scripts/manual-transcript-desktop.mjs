#!/usr/bin/env node
// Full production Desktop with isolated, synthetic Host-persisted conversations.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Host, resolveHostBinary } from "./e2e/host.mjs";
import { assertDesktopBuild, resolveElectronBinary } from "./e2e/boot.mjs";
import { waitFor } from "./e2e/wait.mjs";
import { verifyFullDesktopTranscript } from "./e2e/full-desktop-transcript.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
assert(process.env.PI_SCRATCH_DIR, "Set PI_SCRATCH_DIR to an isolated test directory");
const directory = await mkdtemp(join(process.env.PI_SCRATCH_DIR, "full-transcript-desktop-"));
const project = join(directory, "Scroll test workspace");
await mkdir(project);
const data = join(directory, "data");
const binary = resolveHostBinary();
assertDesktopBuild(root);
const home = join(directory, "home");
await mkdir(home);
const isolation = { HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
  PI_DESKTOP_AGENTS_DIR: join(home, ".agents"),
  APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local") };
const host = new Host(binary, data, { env: isolation });
const sessions = [];
try {
  await host.start();
  await host.call("workspace.set", { path: project });
  const { servers } = await host.call("mcp.list", { projectPath: project });
  assert.deepEqual(servers, [], "The isolated fixture must not discover user MCP servers");
  await host.call("settings.set", { language: "zh-CN", autoGenerateTitle: false });
  for (const [title, count, long] of [
    ["Scroll test — 1000 messages", 1000, false],
    ["Scroll test — long answers", 80, true],
  ]) {
    const { session } = await host.call("session.create", { title, mode: "agent", projectPath: project });
    sessions.push({ id: session.id, title, count });
    for (let index = 0; index < count; index++) {
      const assistant = index % 2 === 1;
      const paragraphs = long && index === count - 1 ? 1600 : 5 + index % 9;
      const content = assistant
        ? `## Answer ${index + 1}\n\n` + Array.from({ length: paragraphs }, (_, p) =>
          `Paragraph ${p + 1} — message ${index + 1}. This synthetic conversation exercises continuous reading, early history loading and return to latest. Keep this numbered paragraph in view while scrolling. **Stable reading anchor** and inline code \`message-${index + 1}\`.`).join("\n\n") +
          `\n\n\`\`\`typescript\nconst message = ${index + 1};\nconsole.log(message);\n\`\`\`\n\nEnd of answer ${index + 1}.`
        : `Message ${index + 1}: inspect the next answer, scroll rapidly in both directions, then use the down-arrow to return to latest.`;
      await host.call("session.appendMessage", { sessionId: session.id, message: {
        id: randomUUID(), role: assistant ? "assistant" : "user", content,
        createdAt: new Date(1700000000000 + index * 1000).toISOString(), status: "complete",
      } });
    }
    console.log("SEEDED " + JSON.stringify(sessions.at(-1)));
  }
} finally { await host.stop(); }
const server = createServer();
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
await new Promise(resolve => server.close(resolve));
const { appDir, electronBinary } = resolveElectronBinary(root);
const env = { ...process.env, ...isolation, PI_DESKTOP_DATA_DIR: data, PI_DESKTOP_HOST_BIN: binary,
  ELECTRON_RENDERER_URL: "", PI_DESKTOP_START_MAXIMIZED: "0" };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electronBinary, [`--remote-debugging-port=${port}`, `--user-data-dir=${join(directory, "profile")}`, "."],
  { cwd: appDir, env, stdio: ["ignore", "pipe", "pipe"] });
child.on("error", error => { console.error(error); process.exitCode = 1; });
const closed = once(child, "close");
let output = "";
for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { output += chunk; });
await writeFile(join(directory, "instance.json"), JSON.stringify({ directory, port, pid: child.pid, sessions }, null, 2));
let ws;
try {
  let target;
  await waitFor(async () => {
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json())
      .find(entry => entry.type === "page" && entry.url.includes("index.html") && !entry.url.includes("plugin-launcher"));
      return Boolean(target); } catch { return false; }
  }, 45000, "full Desktop page");
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await once(ws, "open");
  let sequence = 0;
  const pending = new Map();
  ws.onmessage = ({ data }) => {
    const response = JSON.parse(data), entry = pending.get(response.id);
    if (!entry) return;
    pending.delete(response.id); clearTimeout(entry.timer);
    if (response.error) entry.reject(new Error(JSON.stringify(response.error)));
    else entry.resolve(response.result);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
    pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const response = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
    return response.result.value;
  };
  const selector = `[data-sidebar-session-row="${sessions[0].id}"]`;
  await waitFor(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`), 45000, "seeded sidebar session");
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  await waitFor(() => evaluate(`Boolean(document.querySelector('.thread-scroll .message-row') && document.querySelector('.composer-shell'))`), 30000, "full transcript and composer");
  const proof = await evaluate(`({ title: document.title, rows: document.querySelectorAll('.thread-scroll .message-row').length, sidebar: Boolean(document.querySelector('[data-sidebar-session-row]')), composer: Boolean(document.querySelector('.composer-shell')), text: document.querySelector('.thread-scroll')?.innerText.slice(-300) })`);
  const screenshot = await send("Page.captureScreenshot", { format: "png" });
  await writeFile(join(directory, "desktop.png"), Buffer.from(screenshot.data, "base64"));
  await writeFile(join(directory, "proof.json"), JSON.stringify(proof, null, 2));
  console.log("FULL_DESKTOP_READY " + JSON.stringify({ directory, port, pid: child.pid, proof }));
  if (process.argv.includes("--interaction-smoke")) {
    const interaction = await verifyFullDesktopTranscript({ send, evaluate, waitFor });
    await writeFile(join(directory, "interaction.json"), JSON.stringify(interaction, null, 2));
  }
  if (process.argv.includes("--smoke") || process.argv.includes("--interaction-smoke")) {
    await evaluate(`window.piDesktop.invoke('pi-desktop/app/quit')`);
    await waitFor(() => evaluate(`Boolean(document.querySelector('.lifecycle-confirmation-actions button:last-child'))`),
      5000, "normal quit confirmation");
    await evaluate(`document.querySelector('.lifecycle-confirmation-actions button:last-child').click(); true`);
  }
} catch (error) {
  console.error(error);
  console.error(output.slice(-6000));
  process.exitCode = 1;
  child.kill("SIGKILL");
} finally { ws?.close(); }
const exitTimer = process.argv.some(arg => arg === "--smoke" || arg === "--interaction-smoke")
  ? setTimeout(() => {
    console.error("Desktop did not close within 20s after the smoke check");
    console.error(output.slice(-6000));
    process.exitCode = 1;
    child.kill("SIGKILL");
  }, 20000) : undefined;
try { await closed; } finally { clearTimeout(exitTimer); }
await writeFile(join(directory, "desktop.log"), output);
