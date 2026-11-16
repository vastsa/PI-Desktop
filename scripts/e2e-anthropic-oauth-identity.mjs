#!/usr/bin/env node
// Real desktop, preload, Host SQLite and agent sidecar with a signed-in
// Anthropic (Claude Pro/Max) account. Only api.anthropic.com is local: the
// fixture answers like Anthropic does for subscription-only models and
// rejects Claude Code identities older than 2.1.290 with
// `claude_code_version_too_old` (issue #2239).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveElectronBinary } from "./e2e/boot.mjs";
import { Host, resolveHostBinary } from "./e2e/host.mjs";
import { waitFor } from "./e2e/wait.mjs";

const MINIMUM_CLAUDE_CODE = [2, 1, 290];
const MODEL_ID = "claude-sonnet-4-5";
const REPLY = "Fixture reply from Claude.";

const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-anthropic-oauth-identity-e2e-")));
const dataDir = join(root, "data");
const project = join(root, "project");
mkdirSync(project);

const requests = [];
const versionOf = (userAgent) => /^claude-cli\/(\d+)\.(\d+)\.(\d+)$/u.exec(userAgent ?? "")?.slice(1).map(Number);
const atLeast = (version, minimum) => {
  for (let index = 0; index < minimum.length; index++) {
    if (version[index] !== minimum[index]) return version[index] > minimum[index];
  }
  return true;
};
const sse = (res, events) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  res.end();
};
const server = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const url = new URL(req.url ?? "/", "http://fixture");
  requests.push({ method: req.method, path: url.pathname, headers: req.headers });
  if (req.method !== "POST" || url.pathname !== "/v1/messages") {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "fixture" } }));
    return;
  }
  const version = versionOf(req.headers["user-agent"]);
  if (!version || !atLeast(version, MINIMUM_CLAUDE_CODE)) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error",
      message: "claude_code_version_too_old: Claude Code 2.1.290 or later is required" } }));
    return;
  }
  const { stream } = JSON.parse(body);
  assert.equal(stream, true, "the desktop streams model replies");
  sse(res, [
    { type: "message_start", message: { id: "msg_fixture", type: "message", role: "assistant", model: MODEL_ID,
      content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: REPLY } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } },
    { type: "message_stop" },
  ]);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const fixtureOrigin = `http://127.0.0.1:${server.address().port}`;

// Send every Anthropic request to the fixture, in Electron main (whose
// global fetch becomes net.fetch) and in the sidecar (whose global fetch may
// be replaced by the proxy-aware undici fetch). The accessor keeps
// redirecting whichever fetch the process installs later, so no request can
// reach the real service.
const fetchHook = join(root, "anthropic-fixture-fetch.mjs");
writeFileSync(fetchHook, `const FIXTURE = ${JSON.stringify(fixtureOrigin)};
const ANTHROPIC_HOSTS = new Set(["api.anthropic.com", "platform.claude.com", "claude.ai", "console.anthropic.com"]);
let inner = globalThis.fetch;
const redirecting = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (!ANTHROPIC_HOSTS.has(url.hostname)) return inner(input, init);
  const target = FIXTURE + url.pathname + url.search;
  return input instanceof Request ? inner(new Request(target, input), init) : inner(target, init);
};
Object.defineProperty(globalThis, "fetch", {
  configurable: true,
  enumerable: true,
  get: () => redirecting,
  set: (value) => { if (value !== redirecting) inner = value; },
});
`);

const host = new Host(resolveHostBinary(), dataDir);
await host.start();
await host.call("workspace.set", { path: project });
const { provider } = await host.call("providers.create", {
  name: "Claude",
  vendorKey: "anthropic",
  type: "native",
  authKind: "oauth",
  baseUrl: "https://api.anthropic.com",
});
// The row as a completed Claude sign-in leaves it (VendorOAuth.completeRow).
await host.call("providers.update", {
  id: provider.id,
  oauthAccountLabel: "e2e@example.com",
  apiStyle: "anthropic_messages",
  protocol: "anthropic",
  defaultModelId: MODEL_ID,
  models: [{ id: MODEL_ID, contextWindow: 200_000, maxTokens: 8_192, thinkingLevels: ["off"], defaultThinkingLevel: "off" }],
});
await host.call("secrets.set", {
  secretRef: `secret:provider:${provider.id}:oauth`,
  value: JSON.stringify({ type: "oauth", access: "sk-ant-oat01-e2e-fixture", refresh: "e2e-fixture-refresh",
    expires: Date.now() + 24 * 60 * 60 * 1000 }),
});
await host.call("settings.set", {
  language: "en",
  defaultProviderId: provider.id,
  defaultModelId: MODEL_ID,
  defaultMode: "agent",
  defaultPermissionMode: "auto",
});
await host.stop();

const { appDir, electronBinary } = resolveElectronBinary();
const port = Number(process.env.PI_ANTHROPIC_OAUTH_CDP_PORT || 9391);
const env = {
  ...process.env,
  PI_DESKTOP_DATA_DIR: dataDir,
  PI_DESKTOP_START_MAXIMIZED: "0",
  ELECTRON_RENDERER_URL: "",
  NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${fetchHook}`.trim(),
};
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electronBinary, [
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${join(root, "profile")}`,
  "--host-resolver-rules=MAP api.anthropic.com ~NOTFOUND, MAP platform.claude.com ~NOTFOUND, MAP claude.ai ~NOTFOUND",
  ".",
], { cwd: appDir, env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
const childClose = new Promise((resolve) => child.once("close", resolve));
let output = "";
child.stdout.on("data", (data) => { output += data; });
child.stderr.on("data", (data) => { output += data; });

let ws;
try {
  let target;
  await waitFor(async () => {
    try {
      target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((entry) =>
        entry.type === "page" && entry.url.includes("index.html") && !entry.url.includes("plugin-launcher"));
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
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails));
    }
    return result.result.value;
  };
  const key = async (name, code) => {
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: name, code: name, windowsVirtualKeyCode: code,
      ...(name === "Enter" ? { text: "\r" } : {}) });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: name, code: name, windowsVirtualKeyCode: code });
  };

  await waitFor(() => evaluate(`!!document.querySelector('[data-nav="settings"]') && !document.querySelector('.startup-splash')`),
    30_000, "desktop ready");
  await waitFor(() => evaluate(`!!document.querySelector('.composer-input[contenteditable="true"]')`), 15_000, "composer ready");
  await evaluate(`document.querySelector('.composer-input').focus()`);
  await send("Input.insertText", { text: "Say hello." });
  await key("Enter", 13);

  try {
    await waitFor(() => evaluate(`document.body.innerText.includes(${JSON.stringify(REPLY)})
      || /claude_code_version_too_old/.test(document.body.innerText)`), 60_000, "assistant reply or provider error");
  } catch (error) {
    console.error("WINDOW_TEXT", (await evaluate("document.body.innerText")).slice(-3000));
    throw error;
  }
  const transcript = await evaluate(`document.body.innerText`);
  const inference = requests.filter((request) => request.path === "/v1/messages");
  assert.ok(inference.length >= 1, "the sidecar reached the Anthropic fixture");
  for (const request of inference) {
    assert.equal(request.headers.authorization, "Bearer sk-ant-oat01-e2e-fixture", "OAuth credential is sent as a bearer token");
    assert.equal(request.headers["x-app"], "cli");
    const version = versionOf(request.headers["user-agent"]);
    assert.ok(version, `Claude Code identity missing: ${request.headers["user-agent"]}`);
    assert.ok(atLeast(version, MINIMUM_CLAUDE_CODE),
      `Claude Code identity ${request.headers["user-agent"]} is older than ${MINIMUM_CLAUDE_CODE.join(".")}`);
  }
  assert.doesNotMatch(transcript, /claude_code_version_too_old/u, "the chat must not show the version rejection");
  assert.ok(transcript.includes(REPLY), "the assistant reply is shown in the chat");
  console.log("FIXTURE_REQUESTS", JSON.stringify(requests.map((request) => `${request.method} ${request.path} ${request.headers["user-agent"]}`)));
  console.log(`PASS: a signed-in Claude account chat sends ${inference[0].headers["user-agent"]} and shows the reply`);
} catch (error) {
  console.error("FIXTURE_REQUESTS", JSON.stringify(requests.map((request) => ({ method: request.method, path: request.path,
    userAgent: request.headers["user-agent"] }))));
  console.error(output.slice(-4000));
  throw error;
} finally {
  ws?.close();
  try {
    if (process.platform === "win32") child.kill("SIGTERM");
    else process.kill(-child.pid, "SIGTERM");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
  const exited = await Promise.race([childClose.then(() => true), new Promise((resolve) => setTimeout(resolve, 5000, false))]);
  if (!exited) {
    try {
      if (process.platform === "win32") child.kill("SIGKILL");
      else process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  rmSync(root, { recursive: true, force: true });
}
