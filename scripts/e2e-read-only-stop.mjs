/** Real sidecar + provider HTTP adapter; hold only the host execution/cancel edge. */
// Build the production sidecar first; --bundle selects an existing baseline artifact.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { OfflineSidecar, fixtureHost } from "./e2e/hosted-search-sidecar.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const { values } = parseArgs({ options: { bundle: { type: "string" } } });
const bundle = values.bundle ? resolve(values.bundle) : join(root, "packages/agent-runtime/dist-bundle/sidecar.js");
const temporary = await mkdtemp(join(tmpdir(), "pi-read-only-stop-"));
const results = [];

async function scenario(toolName) {
  const dir = join(temporary, toolName);
  await mkdir(dir, { recursive: true });
  const execution = Promise.withResolvers();
  const cancellation = Promise.withResolvers();
  let started = false, abortRequested = false, executionReplied = false, abortReplied = false;
  let requests = 0;
  const requestBodies = [];
  const args = toolName === "Grep" ? { query: "needle" }
    : toolName === "Glob" ? { pattern: "**/*.ts" }
    : toolName === "Write" ? { path: "fixture.txt", content: "replacement" } : { path: "fixture.txt" };
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requestBodies.push(Buffer.concat(chunks).toString("utf8"));
    requests++;
    if (request.url !== "/v1/chat/completions" || requests > 2) {
      response.writeHead(400).end("Unexpected provider request");
      return;
    }
    const first = requests === 1;
    const delta = first ? { role: "assistant", tool_calls: [{
      index: 0, id: "fixture-call", type: "function", function: { name: toolName, arguments: JSON.stringify(args) },
    }] } : { role: "assistant", content: "Follow-up completed" };
    const chunk = (value, finish) => `data: ${JSON.stringify({ id: "completion", object: "chat.completion.chunk",
      created: 1, model: "fixture-model", choices: [{ index: 0, delta: value, finish_reason: finish }] })}\n\n`;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(chunk(delta, null) + chunk({}, first ? "tool_calls" : "stop") + "data: [DONE]\n\n");
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const fallback = fixtureHost();
  const host = async (method, params) => {
    if (method === "tools.execute") {
      assert.equal(params.toolName, toolName);
      started = true;
      const result = await execution.promise;
      executionReplied = true;
      return result;
    }
    if (method === "tools.abort") {
      assert.equal(params.toolName, toolName);
      abortRequested = true;
      const result = await cancellation.promise;
      abortReplied = true;
      return result;
    }
    if (method === "plans.abort") return { ok: true };
    return fallback(method, params);
  };
  let sidecar;
  try {
    sidecar = await OfflineSidecar.start(bundle, dir, host, 10_000);
    const params = { sessionId: `stop-${toolName}`, mode: "agent", thinkingLevel: "off",
      infiniteProviderRetry: false, scratchDir: dir, pluginTools: [], pluginSkills: [], trustedExtensions: [],
      commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
      provider: { id: "fixture", name: "Fixture", modelId: "fixture-model",
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "fixture-only", apiStyle: "chat_completions",
        supportsReasoning: false, supportedThinkingLevels: ["off"] } };
    const turnId = `${toolName}-first`;
    await sidecar.call("agent.prompt", { ...params, turnId, userMessageId: `${turnId}-user`, content: "Use the fixture tool" });
    await sidecar.waitFor(() => started, "tool execution started");
    const aborting = sidecar.call("agent.abort", { sessionId: params.sessionId, turnId });
    await sidecar.waitFor(() => abortRequested, "host cancellation requested");
    if (toolName === "Write") {
      assert.equal((await sidecar.call("agent.getStatus", { sessionId: params.sessionId })).status.isRunning, true);
      execution.resolve({ ok: true, content: "written" });
      await sidecar.waitFor(() => executionReplied, "write result returned");
      assert.equal((await sidecar.call("agent.getStatus", { sessionId: params.sessionId })).status.isRunning, true);
      cancellation.resolve({ ok: true });
    }
    await aborting;
    if (toolName !== "Write") assert.equal(abortReplied, false, "local stop waited for a host acknowledgement");
    assert.equal((await sidecar.call("agent.getStatus", { sessionId: params.sessionId })).status.isRunning, false);
    await sidecar.prompt(params, "Continue with a new task");
    assert.equal(requests, 2);
    const followUp = JSON.parse(requestBodies[1]).messages.filter((message) => message.role === "user").at(-1);
    assert.ok(JSON.stringify(followUp.content).includes("Continue with a new task"), "the new prompt did not reach the provider");
    assert.ok([...sidecar.messages.values()].some((message) => message.content === "Follow-up completed"));
    const before = (await sidecar.call("agent.getStatus", { sessionId: params.sessionId })).status;
    execution.resolve({ ok: true, content: "late read result" });
    cancellation.resolve({ ok: true });
    await sidecar.waitFor(() => executionReplied && abortReplied, "late host responses returned");
    const after = (await sidecar.call("agent.getStatus", { sessionId: params.sessionId })).status;
    assert.equal(after.currentTurnId, before.currentTurnId);
    assert.equal(after.isRunning, false);
    sidecar.check();
    results.push({ toolName, passed: true, followUpAccepted: true });
  } finally {
    execution.resolve({ ok: false, content: "cancelled" });
    cancellation.resolve({ ok: true });
    await sidecar?.stop();
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
}

try {
  for (const tool of ["Read", "Glob", "Grep", "Write"]) await scenario(tool);
  console.log(JSON.stringify({ passed: true, results }));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
