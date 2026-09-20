#!/usr/bin/env node
/** Real stdio transports, isolated storage, and no external model calls. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "packages/agent-runtime/package.json"));
const { build } = require("esbuild");
const temp = await mkdtemp(join(tmpdir(), "pi-rpc-unicode-"));
const previousBinary = process.env.PI_DESKTOP_HOST_BIN;
let host;
let sidecar;
let server;
const requests = [];
const text = "before\u2028中🙂\u2029after\r\nend";
async function deadline(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Unicode RPC did not settle within 10 seconds")), 10_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
try {
  const bundle = join(temp, "transports.cjs");
  await build({
    stdin: {
      contents: 'export { HostProcess } from "./apps/desktop/electron/main/host-process"; export { AgentSidecar } from "./apps/desktop/electron/main/agent-sidecar";',
      resolveDir: root,
      loader: "ts",
    },
    outfile: bundle,
    bundle: true,
    platform: "node",
    format: "cjs",
    // Keep production development-path resolution pointed at this candidate.
    define: { __dirname: JSON.stringify(join(root, "apps/desktop/electron/main")) },
  });
  const { HostProcess, AgentSidecar } = require(bundle);
  process.env.PI_DESKTOP_HOST_BIN ??= join(root, "target/debug", `pi-desktop-host-core${process.platform === "win32" ? ".exe" : ""}`);
  host = new HostProcess(join(temp, "data"), () => {});
  await deadline(host.handshake());
  const created = await deadline(host.call("session.create", { title: "Unicode regression", mode: "agent", projectPath: temp }));
  const sessionId = created.session.id;
  await deadline(host.call("session.appendMessage", {
    sessionId,
    message: { id: "unicode-message", role: "user", content: `history ${text}`, createdAt: new Date().toISOString(), status: "complete" },
  }));
  const readSession = async () => {
    const result = await deadline(host.call("session.get", { id: sessionId }));
    assert.equal(result.session.messages[0].content, `history ${text}`);
  };
  await readSession();
  await host.dispose();
  host = new HostProcess(join(temp, "data"), () => {});
  await deadline(host.handshake());
  await readSession();
  console.log("PASS session append/get/restart preserves Unicode separators");

  sidecar = new AgentSidecar(() => {});
  sidecar.setHost(host);
  const unknownMethod = `unknown.${text}`;
  await assert.rejects(deadline(sidecar.call(unknownMethod)), (error) => error.message === `method not found: ${unknownMethod}`);
  const events = [];
  let finish;
  const finished = new Promise((resolve) => { finish = resolve; });
  sidecar.onNotification((method, envelope) => {
    if (method !== "agent.event" || envelope.sessionId !== sessionId) return;
    events.push(envelope.event);
    if (envelope.event.type === "agent_end") finish();
  });
  server = createServer(async (req, res) => {
    try {
      let body = "";
      for await (const chunk of req) body += chunk;
      const payload = JSON.parse(body);
      requests.push(payload);
      const base = { id: "unicode-reply", object: "chat.completion.chunk", created: 1, model: payload.model };
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
      res.end("data: [DONE]\n\n");
    } catch {
      res.writeHead(500);
      res.end("Invalid fixture request");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const accepted = await deadline(sidecar.call("agent.prompt", {
    sessionId, content: text, projectPath: temp, thinkingLevel: "off",
    provider: {
      id: "fixture", name: "Fixture", modelId: "fixture-model", apiKey: "", authKind: "none",
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiStyle: "openai-chat",
      supportsReasoning: false, supportedThinkingLevels: ["off"],
    },
    commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
  }));
  assert.equal(accepted.accepted, true);
  await deadline(finished);
  assert.equal(requests.length, 1);
  const wireMessages = JSON.stringify(requests[0].messages);
  assert.ok(wireMessages.includes(JSON.stringify(`history ${text}`).slice(1, -1)), "history crossed the parent host proxy unchanged");
  assert.ok(wireMessages.includes(JSON.stringify(text).slice(1, -1)), "prompt reached the local provider unchanged");
  assert.ok(JSON.stringify(events).includes(JSON.stringify(text).slice(1, -1)), "streamed Unicode answer reached main");
  const answer = events.find((event) => event.type === "message_end" && event.message?.role === "assistant")?.message;
  assert.equal(answer?.content, text);
  // Main owns persistence; exercise its HostProcess boundary with the received row.
  await deadline(host.call("session.appendMessage", { sessionId, message: answer }));
  const stored = await deadline(host.call("session.get", { id: sessionId }));
  assert.ok(stored.session.messages.some((message) => message.role === "assistant" && message.content === text));
  console.log("PASS prompt, history proxy, streamed answer, and saved answer preserve Unicode");
  await deadline(sidecar.call("sidecar.health"));
  console.log("PASS sidecar requests, error replies, and subsequent health request");
} finally {
  await sidecar?.dispose();
  await host?.dispose();
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  if (previousBinary === undefined) delete process.env.PI_DESKTOP_HOST_BIN;
  else process.env.PI_DESKTOP_HOST_BIN = previousBinary;
  await rm(temp, { recursive: true, force: true });
}
