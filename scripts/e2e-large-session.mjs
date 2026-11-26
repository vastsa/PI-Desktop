#!/usr/bin/env node
/** Large synthetic history through production HostProcess and AgentSidecar. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { appendFile, mkdir, mkdtemp, open, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { resolveHostBinary } from "./e2e/host.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "packages/agent-runtime/package.json"));
const { build } = require("esbuild");
const temp = await mkdtemp(join(tmpdir(), "pi-large-session-"));
const dataDir = join(temp, "data");
const workspace = join(temp, "workspace");
const createdAt = "2026-11-26T00:00:00.000Z";
const historyMiB = process.argv.includes("--large") ? 620 : 80;
const responseLimit = 64 * 1024 * 1024;
let host;
let sidecar;
let server;
const requests = [];
const hostReads = [];
const results = {};
const now = performance.now();

async function deadline(promise, label, ms = 30_000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms} ms`)), ms);
    })]);
  } finally { clearTimeout(timer); }
}
const message = (id, content, role = "user") => ({ id, content, role, createdAt, status: "complete" });
try {
  await mkdir(workspace);
  const bundle = join(temp, "transports.cjs");
  await build({
    stdin: { contents: 'export { HostProcess } from "./packages/host-runtime/src/host-process.ts"; export { AgentSidecar } from "./packages/host-runtime/src/agent-sidecar.ts";', resolveDir: root, loader: "ts" },
    outfile: bundle, bundle: true, platform: "node", format: "cjs",
  });
  const { HostProcess, AgentSidecar } = require(bundle);
  const startHost = async () => {
    host = new HostProcess({ binaryPath: resolveHostBinary(), dataDir, onStderr: () => {} });
    await deadline(host.handshake(), "host handshake");
  };
  await startHost();
  const { session: large } = await host.call("session.create", { title: "Synthetic large history", mode: "agent", projectPath: workspace });
  const { session: other } = await host.call("session.create", { title: "Independent session", mode: "agent", projectPath: workspace });
  const { session: legacy } = await host.call("session.create", { title: "No checkpoint history", mode: "agent", projectPath: workspace });
  await host.dispose();

  // Append valid canonical records while the test's Host is stopped. This avoids
  // hundreds of RPC copies and syncs just to construct an isolated fixture.
  await mkdir(join(dataDir, "sessions"), { recursive: true });
  const path = join(dataDir, "sessions", `${large.id}.jsonl`);
  const file = await open(path, "a");
  try {
    const body = "x".repeat(1024 * 1024);
    for (let index = 0; index < historyMiB; index++) {
      await file.write(`${JSON.stringify({ type: "message", id: `old-${index}`, role: "assistant", blocks: [{ type: "text", text: body }], createdAt })}\n`);
    }
    await file.write(`${JSON.stringify({ type: "compaction", id: "checkpoint", summary: "CHECKPOINT_MARKER earlier work completed", throughMessageId: `old-${historyMiB - 1}`, retainedTail: [], tokensBefore: 100000, createdAt })}\n`);
    await file.write(`${JSON.stringify({ type: "message", id: "recent-user", role: "user", blocks: [{ type: "text", text: "RECENT_MARKER 中文🙂" }], createdAt })}\n`);
    await file.write(`${JSON.stringify({ type: "message", id: "recent-assistant", role: "assistant", blocks: [{ type: "text", text: "Recent answer" }], createdAt })}\n`);
  } finally { await file.close(); }
  results.transcriptBytes = (await stat(path)).size;
  assert.ok(results.transcriptBytes > historyMiB * 1024 * 1024);
  // A no-checkpoint session spans several restore pages with ordinary text.
  const legacyPath = join(dataDir, "sessions", `${legacy.id}.jsonl`);
  for (let index = 0; index < 12; index++) {
    await appendFile(legacyPath, `${JSON.stringify({ type: "message", id: `legacy-old-${index}`, role: "assistant", blocks: [{ type: "text", text: "x".repeat(1024 * 1024) }], createdAt })}\n`);
  }
  for (let index = 0; index < 230; index++) {
    await appendFile(legacyPath, `${JSON.stringify({ type: "message", id: `legacy-${index}`, role: index % 2 ? "assistant" : "user", blocks: [{ type: "text", text: `LEGACY_${index} 中文🙂` }], createdAt })}\n`);
  }
  await startHost();
  const started = performance.now();
  const [{ session: tail }, set] = await deadline(Promise.all([
    host.call("session.get", { id: large.id, messageLimit: 100, contentLimit: 65_536 }),
    host.call("workspace.set", { path: workspace }),
  ]), "open large history and switch independent workspace");
  assert.deepEqual(tail.messages.slice(-2).map(row => row.id), ["recent-user", "recent-assistant"]);
  assert.equal(tail.hasMoreBefore, true);
  const { session: previous } = await host.call("session.get", { id: large.id, messageBefore: tail.messageStart, messageLimit: 2, contentLimit: 128 });
  assert.deepEqual(previous.messages.map(row => row.id), [`old-${historyMiB - 100}`, `old-${historyMiB - 99}`]);
  assert.equal(previous.messageEnd, tail.messageStart);
  results.openAndPageMs = Math.round(performance.now() - started);
  assert.ok(set);

  // An uncapped legacy read must fail only its own ID, followed by valid calls
  // over the same production connection. The deadline catches a poisoned pipe.
  const settled = await deadline(Promise.allSettled([
    host.call("session.get", { id: large.id }),
    host.call("session.appendMessage", { sessionId: other.id, message: message("other-1", "Other session still works") }),
  ]), "oversized response isolation", 60_000);
  assert.equal(settled[0].status, "rejected");
  assert.equal(settled[0].reason.errorCode, "LIMIT_EXCEEDED");
  assert.equal(settled[1].status, "fulfilled");
  const { session: independent } = await deadline(host.call("session.get", { id: other.id, messageLimit: 1 }), "subsequent same-connection read");
  assert.equal(independent.messages[0].id, "other-1");
  assert.equal(host.isAvailable(), true);
  results.isolation = "pass";
  const restored = await host.call("session.restoreContext", { id: large.id, excludeMessageIds: [] });
  assert.equal(restored.session.overflow, false);
  assert.ok(restored.session.readBytes < 2 * 1024 * 1024);
  assert.ok(restored.session.messages.length < 8);
  results.contextReadBytes = restored.session.readBytes;
  results.contextRows = restored.session.messages.length;


  server = createServer(async (req, res) => {
    try {
      let body = "";
      for await (const chunk of req) body += chunk;
      const payload = JSON.parse(body);
      requests.push(payload);
      const base = { id: "fixture", object: "chat.completion.chunk", created: 1, model: payload.model };
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Fixture answer 中文🙂" }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 } })}\n\n`);
      res.end("data: [DONE]\n\n");
    } catch { res.writeHead(500); res.end("Fixture failed"); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const launchEntry = join(root, "packages/agent-runtime/dist/sidecar.js");
  const env = { ...process.env, OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", GOOGLE_API_KEY: "", OPENROUTER_API_KEY: "" };
  {
    for (const session of [large, legacy]) {
      sidecar = new AgentSidecar({ launch: { command: process.execPath, args: [launchEntry], env, cwd: root }, onStderr: () => {} });
      sidecar.setHost({
        call(method, params) {
          if (method === "session.restoreContext") hostReads.push(params);
          return host.call(method, params);
        },
        onNotification: callback => host.onNotification(callback),
        onExit: callback => host.onExit(callback),
      });
      const prompt = `NEW_PROMPT_${session.id}`;
      const promptId = `prompt-${session.id}`;
      await host.call("session.appendMessage", { sessionId: session.id, message: message(promptId, prompt) });
      let finish;
      const finished = new Promise(resolve => { finish = resolve; });
      const events = [];
      sidecar.onNotification((method, envelope) => {
        if (method !== "agent.event" || envelope.sessionId !== session.id) return;
        events.push(envelope.event);
        if (envelope.event.type === "agent_end") finish();
      });
      const accepted = await deadline(sidecar.call("agent.prompt", {
        sessionId: session.id, content: prompt, userMessageId: promptId,
        projectPath: workspace, thinkingLevel: "off",
        provider: { id: "fixture", name: "Fixture", modelId: "fixture-model", apiKey: "", authKind: "none", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiStyle: "openai-chat", supportsReasoning: false, supportedThinkingLevels: ["off"] },
        commandShell: { id: process.platform === "win32" ? "windows-pwsh" : "bash", label: "Fixture shell", dialect: process.platform === "win32" ? "powershell" : "posix", available: true, isDefault: true },
      }), "cold restore prompt", 60_000);
      assert.equal(accepted.accepted, true);
      await deadline(finished, "fixture answer", 60_000);
      const sent = JSON.stringify(requests.at(-1)?.messages);
      assert.ok(sent.includes(prompt));
      assert.equal(sent.split(prompt).length - 1, 1, "new prompt sent once");
      if (session.id === large.id) {
        assert.ok(sent.includes("CHECKPOINT_MARKER"), "active summary must survive paginated restore");
        assert.ok(sent.includes("RECENT_MARKER"), "recent complete turn must survive restore");
        assert.ok(Buffer.byteLength(sent) < responseLimit, "old compacted bodies must not be sent to the provider");
      } else {
        assert.ok(sent.includes("LEGACY_0"));
        assert.ok(sent.includes("LEGACY_229"));
      }
      assert.ok(events.some(event => event.type === "message_end" && event.message?.role === "assistant"));
      await sidecar.dispose(); sidecar = undefined;
    }
  }
  assert.ok(hostReads.length > 1);
  assert.ok(hostReads.every(read => Array.isArray(read.excludeMessageIds)), "all restore reads must use bounded active context");
  results.coldResume = "pass";
  results.noCheckpoint = "pass";
  results.restoreReads = hostReads.length;
  results.elapsedMs = Math.round(performance.now() - now);
  console.log("LARGE_SESSION " + JSON.stringify(results));
} finally {
  await sidecar?.dispose();
  await host?.dispose();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await rm(temp, { recursive: true, force: true });
}
