#!/usr/bin/env node
// E2E-SCHEDULED-cancelled-quit-keeps-runner (issue #2048).
// Real desktop, preload, Host SQLite and agent sidecar; only the model is a local SSE.
// A quit that the user cancels in the D363 confirmation must leave automatic
// scheduled runs working; only the confirmed quit stops the runner.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { Host, resolveHostBinary } from "./e2e/host.mjs";
import { resolveElectronBinary } from "./e2e/boot.mjs";
import { waitFor } from "./e2e/wait.mjs";

const root = mkdtempSync(join(tmpdir(), "pi-scheduled-quit-cancel-e2e-"));
const dataDir = join(root, "data");
const project = join(root, "project");
const home = join(root, "home");
mkdirSync(project);
mkdirSync(home);

let modelCalls = 0;
const server = createServer(async (req, res) => {
  if (req.method === "GET" && req.url?.endsWith("/models")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: [{ id: "fixture", object: "model" }] }));
    return;
  }
  for await (const _ of req);
  modelCalls++;
  const chunk = (delta, finish_reason = null) =>
    res.write(`data: ${JSON.stringify({
      id: `quit-cancel-${modelCalls}`, object: "chat.completion.chunk", created: 1, model: "fixture",
      choices: [{ index: 0, delta, finish_reason }],
    })}\n\n`);
  res.writeHead(200, { "content-type": "text/event-stream" });
  chunk({ role: "assistant" });
  chunk({ content: "Scheduled run after cancelled quit." });
  chunk({}, "stop");
  res.end("data: [DONE]\n\n");
});
server.listen(0, "127.0.0.1");
await once(server, "listening");

const host = new Host(resolveHostBinary(), dataDir, { env: { HOME: home, USERPROFILE: home } });
await host.start();
await host.call("workspace.set", { path: project });
const { provider } = await host.call("providers.create", {
  name: "Quit cancel model", vendorKey: "custom", type: "openai_compatible",
  protocol: "openai_compatible", baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
  authKind: "none", defaultModelId: "fixture", apiStyle: "chat_completions",
});
await host.call("settings.set", {
  ...(await host.call("settings.get")),
  language: "en", onboardingDismissed: true, autoGenerateTitle: false,
  defaultProviderId: provider.id, defaultModelId: "fixture",
  defaultMode: "agent", defaultPermissionMode: "auto",
});
await host.stop();

const { appDir, electronBinary } = resolveElectronBinary();
const env = {
  ...process.env, HOME: home, USERPROFILE: home, PI_DESKTOP_DATA_DIR: dataDir,
  PI_DESKTOP_START_MAXIMIZED: "0", ELECTRON_RENDERER_URL: "",
};
delete env.ELECTRON_RUN_AS_NODE;
delete env.PI_DESKTOP_BOOT_PROBE;
const child = spawn(
  electronBinary,
  // An ephemeral DevTools port: a fixed one could attach this run to another
  // desktop instance that still holds it.
  ["--remote-debugging-port=0", `--user-data-dir=${join(root, "profile")}`, "."],
  { cwd: appDir, env, stdio: ["ignore", "pipe", "pipe"] },
);
let output = "";
child.stdout.on("data", (data) => { output += data; });
child.stderr.on("data", (data) => { output += data; });
const exited = once(child, "exit");
const devtoolsOrigin = () => output.match(/DevTools listening on ws:\/\/(127\.0\.0\.1:\d+)\//)?.[1];

const logLines = (category) => {
  const lines = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.startsWith(`${category}.`) && entry.name.endsWith(".log"))
        lines.push(...readFileSync(path, "utf8").split("\n").filter(Boolean));
    }
  };
  walk(join(dataDir, "logs"));
  return lines;
};
const countLog = (category, text) => logLines(category).filter((line) => line.includes(text)).length;

let ws;
try {
  let target;
  await waitFor(async () => {
    const origin = devtoolsOrigin();
    if (!origin) return false;
    try {
      target = (await (await fetch(`http://${origin}/json/list`)).json()).find(
        (entry) => entry.type === "page" && entry.url.includes("index.html") && !entry.url.includes("plugin-launcher"),
      );
      return !!target;
    } catch {
      return false;
    }
  }, 30_000, "desktop CDP target");
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await once(ws, "open");
  let sequence = 0;
  const pending = new Map();
  ws.onmessage = ({ data }) => {
    const message = JSON.parse(data), entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
    else entry.resolve(message.result);
  };
  ws.onclose = () => {
    for (const entry of pending.values()) entry.reject(new Error("CDP closed"));
    pending.clear();
  };
  const send = (method, params = {}) => new Promise((resolveCall, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve: resolveCall, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails)
      throw new Error(result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const invoke = (name, ...args) => evaluate(
    `(async () => { const r = await window.piDesktop.invoke(window.piDesktop.channels.invoke[${JSON.stringify(name)}], ...${JSON.stringify(args)}); if (!r.ok) throw new Error(JSON.stringify(r.error)); return r.data; })()`,
  );
  const dialogOpen = () => evaluate(`!!document.querySelector('.lifecycle-confirmation-dialog')`);
  // Real pointer input on the dialog button, the same hit-test a user click gets.
  const clickDialogButton = async (label) => {
    const point = await evaluate(`(() => { const b = [...document.querySelectorAll('.lifecycle-confirmation-dialog button')].find(e => e.textContent.trim() === ${JSON.stringify(label)}); if (!b) return null; const r = b.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2; return b.contains(document.elementFromPoint(x, y)) ? { x, y } : null; })()`);
    assert.ok(point, `dialog button hit target: ${label}`);
    await send("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 });
  };
  const requestQuit = async () => {
    await invoke("appQuit");
    await waitFor(dialogOpen, 10_000, "quit confirmation dialog");
  };

  await waitFor(() => evaluate(`!!document.querySelector('.app-shell:not(.app-shell-boot)')`), 60_000, "desktop shell");
  await waitFor(() => countLog("runtime", "scheduled runner started") === 1, 10_000, "runner start log");
  console.log("PASS desktop booted and the scheduled runner logged its start");

  const { task } = await invoke("scheduledCreate", {
    title: "Quit cancel probe", prompt: "Reply OK", cadence: "hourly",
    schedule: { hour: 0, minute: 0, weekday: 0 }, permissionMode: "auto",
  });

  // 1) Explicit quit, then Cancel: the app keeps running.
  await requestQuit();
  await clickDialogButton("Cancel");
  await waitFor(async () => !(await dialogOpen()), 5_000, "dialog dismissed after Cancel");
  assert.equal(child.exitCode, null, "app still running after Cancel");
  assert.equal(countLog("lifecycle", "app shutdown"), 0, "Cancel does not enter shutdown");
  assert.equal(countLog("runtime", "scheduled runner stopped"), 0, "Cancel does not stop the runner");
  console.log("PASS cancelled quit keeps the app running without a shutdown or runner stop");

  // 2) A task that becomes due after the cancelled quit still runs automatically.
  // The runner polls every 30s; the due instant is controlled, not waited for.
  await invoke("scheduledUpdate", { id: task.id, configJson: { nextRunAt: Date.now() } });
  const callsBefore = modelCalls;
  let runs = [];
  await waitFor(async () => {
    runs = (await invoke("scheduledListRuns", { taskId: task.id })).runs;
    return runs[0]?.status === "completed";
  }, 75_000, "automatic run after cancelled quit", 500);
  assert.equal(runs.length, 1, "exactly one automatic run");
  assert.ok(modelCalls > callsBefore, "the automatic run reached the model");
  assert.ok(Date.parse((await invoke("scheduledList")).tasks.find((t) => t.id === task.id).nextRunAt) > Date.now(),
    "nextRunAt advanced past now");
  console.log("PASS task due after the cancelled quit ran automatically and nextRunAt advanced");

  // 3) A second quit prompts again; Confirm runs the ordered shutdown and stops the runner.
  await requestQuit();
  await clickDialogButton("Quit");
  const [code] = await Promise.race([
    exited,
    new Promise((_, reject) => setTimeout(() => reject(new Error("app did not exit after Confirm")), 30_000)),
  ]);
  assert.equal(code, 0, "confirmed quit exits cleanly");
  assert.equal(countLog("lifecycle", "app shutdown"), 1, "one ordered shutdown");
  assert.equal(countLog("runtime", "scheduled runner stopped"), 1, "runner stopped on the confirmed quit");
  assert.equal(countLog("runtime", "quit teardown failed"), 0, "no teardown listener failed");
  console.log("PASS second quit prompts again; Confirm shuts down and stops the runner once");
  console.log(`Isolated profile: ${root}`);
} catch (error) {
  console.error(output.slice(-4000));
  console.error(`Isolated profile kept for diagnosis: ${root}`);
  throw error;
} finally {
  ws?.close();
  // SIGTERM reaches `before-quit`, which holds the quit for the confirmation
  // dialog, so a failed run would otherwise leave the app (and its host-core)
  // running. Kill it outright once the graceful path is no longer expected.
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await exited;
  }
  server.close();
}
