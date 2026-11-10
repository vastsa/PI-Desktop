import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

const sessionId = "restored-taskread-fixture";
const stamp = (n) => new Date(Date.UTC(2026, 10, 1, 0, 0, n)).toISOString();
const task = (n, id, agent = "explorer", resume) => ({
  id: `task-row-${id}`, role: "tool", content: "", createdAt: stamp(n),
  toolCallId: `task-call-${id}`, toolName: "Task", toolStatus: "success",
  toolArgs: { agent, task: "Inspect the owned fixture", ...(resume ? { resume } : {}) },
  toolResult: { content: [{ type: "text", text: "Fixture report only" }],
    details: { delegationId: id, agent, status: "completed", modelId: "fixture-model" } },
});
const childRow = (n, id, parent, content, extra = {}) => ({
  id, role: "assistant", content, status: "complete", createdAt: stamp(n),
  parentToolCallId: `task-call-${parent}`, agentName: "explorer", ...extra,
});
const history = Array.from({ length: 380 }, (_, n) => ({
  id: `parent-${n}`, role: n === 0 ? "user" : "assistant",
  content: "Parent fixture row", status: "complete", createdAt: stamp(n),
}));
history[1] = task(1, "alpha-1");
history[2] = childRow(2, "initial-step", "alpha-1", "OWNED-INITIAL-STEP");
history[3] = { ...childRow(3, "owned-tool", "alpha-1", ""), role: "tool",
  toolName: "Read", toolCallId: "read-owned", toolStatus: "success",
  toolArgs: { path: "src/owned-fixture.ts" },
  toolResult: { content: [{ type: "text", text: "OWNED-TOOL-RESULT" }] } };
history[4] = childRow(4, "reasoning-only", "alpha-1", "", { thinking: "REASONING-SENTINEL" });
history[110] = task(110, "beta", "reviewer");
history[111] = childRow(111, "parallel-step", "beta", "PARALLEL-SENTINEL", { agentName: "reviewer" });
history[230] = task(230, "alpha-2", "explorer", "alpha-1");
history[231] = childRow(231, "resumed-step", "alpha-2", "OWNED-RESUMED-STEP", { agentName: "agents/explorer" });
history[232] = childRow(232, "legacy-step", "alpha-2", "OWNED-LEGACY-STEP");
delete history[232].agentName;
history[233] = childRow(233, "foreign-agent-step", "alpha-2", "FOREIGN-AGENT-SENTINEL", { agentName: "reviewer" });

function sse(res, delta, finish) {
  const chunk = (value, reason) => `data: ${JSON.stringify({
    id: "fixture-completion", object: "chat.completion.chunk", created: 1,
    model: "fixture-model", choices: [{ index: 0, delta: value, finish_reason: reason }],
  })}\n\n`;
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(chunk(delta, null) + chunk({}, finish) + "data: [DONE]\n\n");
}
function toolCall(res, name, id, args) {
  sse(res, { role: "assistant", tool_calls: [{ index: 0, id, type: "function",
    function: { name, arguments: JSON.stringify(args) } }] }, "tool_calls");
}
function toolOutput(body, id) {
  const row = body.messages.find((message) => message.role === "tool" && message.tool_call_id === id);
  assert.equal(typeof row?.content, "string", `Missing tool output ${id}`);
  return row.content;
}

// A fresh process reconstructs its runtime through the real sidecar RPC entry.
// Only the external Host and loopback provider are mocked; no real data is read.
test("fresh sidecar restores subagent steps for paged parent inspection without cross-session access", {
  timeout: 60_000,
}, async () => {
  const temp = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "taskread-sidecar-"));
  let complete;
  let fail;
  const finished = new Promise((resolve, reject) => { complete = resolve; fail = reject; });
  // Failure may arrive while the admission RPC is resolving; it is awaited below.
  void finished.catch(() => {});
  const requests = [];
  const hostCalls = [];
  const pages = [];
  const server = createServer(async (req, res) => {
    try {
      let text = "";
      for await (const chunk of req) {
        text += chunk;
        assert.ok(text.length <= 1_048_576, "Fixture provider input exceeded its budget");
      }
      const body = JSON.parse(text);
      requests.push(body);
      assert.ok(requests.length <= 4, "Unexpected provider loop");
      if (requests.length === 1) {
        assert.ok(body.tools.some((tool) => tool.function?.name === "TaskRead"), "Restored-only TaskRead is undeclared");
        for (const marker of ["OWNED-INITIAL-STEP", "OWNED-TOOL-RESULT", "OWNED-RESUMED-STEP", "PARALLEL-SENTINEL", "REASONING-SENTINEL"]) {
          assert.ok(!text.includes(marker), `Child content replayed into the default parent context: ${marker}`);
        }
        toolCall(res, "TaskRead", "inspect-first", { delegationId: "alpha-2", limit: 1 });
      } else if (requests.length === 2) {
        const page = JSON.parse(toolOutput(body, "inspect-first"));
        pages.push(page);
        assert.equal(page.source, "chain");
        assert.equal(page.agent, "explorer");
        assert.equal(page.status, "completed");
        assert.equal(page.total, 6);
        assert.equal(page.returned, 1);
        assert.equal(page.nextOffset, 1);
        assert.equal(page.steps[0].role, "user");
        assert.equal(page.steps[0].text, "Inspect the owned fixture");
        toolCall(res, "TaskRead", "inspect-next", { delegationId: "alpha-2", offset: page.nextOffset, limit: 100 });
      } else if (requests.length === 3) {
        const page = JSON.parse(toolOutput(body, "inspect-next"));
        pages.push(page);
        assert.equal(page.returned, 5);
        assert.equal(page.hasMore, false);
        assert.equal(page.nextOffset, null);
        assert.equal(page.unattributedRows, 1);
        assert.deepEqual(page.steps.map((step) => step.id), ["initial-step", "owned-tool", "task-row-alpha-2", "resumed-step", "legacy-step"]);
        assert.equal(page.steps[0].text, "OWNED-INITIAL-STEP");
        assert.equal(page.steps[1].toolName, "Read");
        assert.ok(page.steps[1].args.includes("src/owned-fixture.ts"));
        assert.equal(page.steps[1].result, "OWNED-TOOL-RESULT");
        assert.equal(page.steps[2].role, "user");
        assert.equal(page.steps[2].text, "Inspect the owned fixture");
        toolCall(res, "TaskRead", "inspect-foreign", { delegationId: "other-conversation-only" });
      } else {
        assert.ok(toolOutput(body, "inspect-foreign").includes("SUBAGENT_CONTENT_UNKNOWN_DELEGATION"));
        sse(res, { role: "assistant", content: "Recorded steps reviewed." }, "stop");
      }
    } catch (error) {
      res.writeHead(500); res.end(); fail(error);
    }
  });
  let child;
  let lines;
  let closed;
  let stderr = "";
  const responses = new Map();
  const deadline = setTimeout(() => fail(new Error(`Sidecar completion deadline: ${stderr}`)), 35_000);
  try {
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    child = spawn(process.execPath, [fileURLToPath(new URL("../../../packages/agent-runtime/dist/sidecar.js", import.meta.url))], {
      cwd: temp, stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, HOME: temp, USERPROFILE: temp, PI_CODING_AGENT_DIR: join(temp, "agent") },
    });
    closed = new Promise((resolve) => child.once("close", resolve));
    child.once("error", fail);
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-16_000); });
    const send = (value) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
    lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      try {
        const value = JSON.parse(line);
        if (value.method === "host.proxy") {
          hostCalls.push(value.params);
          if (value.params.method === "session.get") {
            assert.deepEqual(value.params.params, { id: sessionId }, "Restore must read complete history, not the visible window");
            send({ id: value.id, result: { session: { id: sessionId, messages: history } } });
          } else if (value.params.method === "tools.fileBatchCapabilities") {
            send({ id: value.id, result: { version: 1, supported: false } });
          } else if (value.params.method === "session.appendMessage") {
            assert.equal(value.params.params.sessionId, sessionId, "System journal escaped its fictional session");
            assert.ok(value.params.params.message?.modelSystem, "Only the normal model-system journal is expected");
            send({ id: value.id, result: { ok: true } });
          } else {
            throw new Error(`Unexpected Host side effect: ${value.params.method}`);
          }
        } else if (value.id) {
          const settle = responses.get(value.id); responses.delete(value.id); settle?.(value);
        } else if (value.method === "agent.event" && value.params.sessionId === sessionId) {
          if (value.params.event.type === "error") fail(new Error(JSON.stringify(value.params.event.error)));
          if (value.params.event.type === "agent_end" && !value.params.parentToolCallId) complete();
        }
      } catch (error) { fail(error); }
    });
    const admission = new Promise((resolve) => { responses.set("admit", resolve); });
    send({ id: "admit", method: "agent.prompt", params: {
      sessionId, mode: "agent", content: "Inspect this session's retained subagent work", userMessageId: "inspection-user",
      subagents: [], thinkingLevel: "off",
      commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
      provider: { id: "fixture", modelId: "fixture-model", authKind: "none", apiStyle: "openai-chat",
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`, modelConfig: { input: ["text"] } },
    } });
    const response = await Promise.race([admission, finished.then(() => { throw new Error("Turn ended before admission"); })]);
    assert.equal(response.result?.accepted, true, JSON.stringify(response));
    await finished;
    assert.equal(requests.length, 4);
    assert.equal(hostCalls.filter((call) => call.method === "session.get").length, 1);
    const readText = JSON.stringify(pages);
    for (const marker of ["PARALLEL-SENTINEL", "FOREIGN-AGENT-SENTINEL", "REASONING-SENTINEL"]) {
      assert.ok(!readText.includes(marker), `Read crossed its projection boundary: ${marker}`);
    }
  } finally {
    clearTimeout(deadline);
    if (child) { if (child.exitCode === null) child.kill(); await closed; }
    lines?.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
