import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DesktopAgentRuntime } from "../packages/agent-runtime/dist/runtime.js";

// Real runtime, Agent and provider transport. Only the remote provider and
// Host tool boundary are fixtures; no account or running Desktop is used.
let scenario;
let sequence = 0;
const until = async (check) => {
  const deadline = Date.now() + 15_000;
  while (!check()) {
    assert.ok(Date.now() < deadline, `scenario timed out: ${scenario?.mode}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
const bounded = async (promise) => {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`runtime prompt timed out: ${scenario.mode}`)), 20_000);
    })]);
  } finally {
    clearTimeout(timer);
  }
};
function reply(res, model, calls, text = "Finished") {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const chunk = (delta, finish_reason) => res.write(`data: ${JSON.stringify({
    id: `fixture-${++sequence}`, object: "chat.completion.chunk", created: 1, model,
    choices: [{ index: 0, delta, finish_reason }],
  })}\n\n`);
  chunk(calls ? { role: "assistant", tool_calls: calls.map((call, index) => ({
    index, id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) },
  })) } : { role: "assistant", content: text }, null);
  chunk({}, calls ? "tool_calls" : "stop");
  res.end("data: [DONE]\n\n");
}
const server = createServer(async (req, res) => {
  try {
    let raw = "";
    for await (const part of req) raw += part;
    const body = JSON.parse(raw);
    const s = scenario;
    assert.ok(s);
    const users = body.messages.filter((message) => message.role === "user");
    const latest = JSON.stringify(users.at(-1)?.content);
    if (body.model === "worker") {
      if (latest.includes("Continue")) {
        s.replayed.push(body);
        reply(res, body.model, null, "Resumed successfully");
      } else if (!body.messages.some((message) => message.role === "tool")) {
        const label = latest.includes("Task A") ? "A" : "B";
        reply(res, body.model, [{ id: `read_${label}`, name: "Read", args: { path: `fixture-${label}.txt` } }]);
      } else {
        s.waiting.add(res);
        res.on("close", () => s.waiting.delete(res));
        // A live provider stream stops cooperatively on the real abort signal.
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(": waiting\n\n");
      }
      return;
    }
    if (latest.includes("Resume")) {
      if (!s.resumeSent) {
        s.resumeSent = true;
        reply(res, body.model, [...s.ids.values()].map((id, index) => ({ id: `resume_${index}`,
          name: "Task", args: { agent: "explorer", task: "Continue", resume: id } })));
      } else reply(res, body.model, null);
      return;
    }
    if (!s.started) {
      s.started = true;
      reply(res, body.model, ["A", "B"].map((label) => ({ id: `task_${label}`, name: "Task",
        args: { agent: "explorer", task: `Task ${label}` } })));
    } else if (s.stopSent) {
      reply(res, body.model, null);
    } else {
      await until(() => s.waiting.size === 2);
      s.parentWaiting = true;
      if (s.mode === "error") {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "fixture parent authentication failure" } }));
      } else if (s.mode === "stop") {
        s.stopSent = true;
        reply(res, body.model, [{ id: "stop_all", name: "TaskStop", args: { delegationIds: [...s.ids.values()] } }]);
      }
      // User-abort case leaves the parent's request open until Stop cancels it.
    }
  } catch (error) {
    scenario.errors.push(error);
    if (!res.headersSent) res.writeHead(500);
    res.end(String(error));
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
const provider = (modelId) => ({ id: "fixture", name: "Fixture", modelId, baseUrl,
  apiKey: "", authKind: "none", apiStyle: "openai-chat", supportsReasoning: false,
  supportedThinkingLevels: ["off"] });
const projectPath = mkdtempSync(join(tmpdir(), "pi-subagent-parent-error-"));
const results = [];
try {
  for (const mode of ["error", "abort", "stop", "direct"]) {
    const s = scenario = { mode, ids: new Map(), settled: new Map(), waiting: new Set(),
      errors: [], replayed: [], rejected: [], parentErrors: [] };
    const runtime = new DesktopAgentRuntime({
      sessionId: `fixture-${mode}`, mode: "agent", provider: provider("parent"), thinkingLevel: "off", projectPath,
      commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
      subagents: [{ name: "explorer", description: "Fixture reader", prompt: "Read the task's file",
        tools: ["Read"], source: "user", model: { providerId: "fixture", modelId: "worker" } }],
      subagentProviders: { "fixture/worker": provider("worker") },
      host: { onNotification: () => () => {}, call: async (method, params) => {
        if (method === "project.instructions.resolve") return { entries: [] };
        if (method === "tools.execute") {
          assert.equal(params.toolName, "Read");
          return { ok: true, content: { path: params.args.path, text: `Finding from ${params.args.path}` } };
        }
        return {};
      } },
      onEvent: ({ event, parentToolCallId }) => {
        if (parentToolCallId) return;
        if (event.type === "error") s.parentErrors.push(event.error);
        if (event.type === "tool_end" && event.result?.details?.delegationId && event.toolCallId.startsWith("task_")) {
          s.ids.set(event.toolCallId, event.result.details.delegationId);
        }
        if (event.type === "tool_end" && event.toolCallId.startsWith("resume_") && event.isError) s.rejected.push(event);
        const message = event.type === "message_end" ? event.message : undefined;
        if (message?.toolName === "Task" && message.toolResult?.details?.status !== "running") {
          s.settled.set(message.toolCallId, message.toolResult.details);
        }
      },
    });
    try {
      const running = bounded(runtime.prompt("Start two delegates"));
      if (mode === "abort") {
        await until(() => s.parentWaiting);
        await runtime.abort();
      }
      if (mode === "direct") {
        await until(() => s.parentWaiting);
        const first = await runtime.stopSubagents([s.ids.get("task_A")]);
        assert.equal(first.details.stopped.length, 1);
        await until(() => s.settled.has("task_A") && s.waiting.size === 1);
        assert.equal(s.settled.has("task_B"), false, "the sibling must remain running");
        assert.equal(runtime.getStatus().isRunning, true, "direct stop must not abort the parent");
        assert.equal((await runtime.stopSubagents()).details.stopped.length, 1);
        await until(() => s.settled.has("task_B"));
        assert.equal(runtime.getStatus().isRunning, true, "stop-all only targets delegates");
        await runtime.abort();
      }
      await running;
      await until(() => ["task_A", "task_B"].every((id) => s.settled.has(id)));
      assert.equal(runtime.getStatus().isRunning, false);
      assert.equal(s.ids.size, 2);
      for (const id of ["task_A", "task_B"]) {
        assert.equal(s.settled.get(id).status, mode === "error" ? "failed" : ["stop", "direct"].includes(mode) ? "stopped" : "aborted");
        if (mode === "error") assert.equal(s.settled.get(id).error.code, "SUBAGENT_PARENT_FAILED");
      }
      if (mode === "error") assert.equal(s.parentErrors.length, 1);
      await bounded(runtime.prompt("Resume both delegates"));
      if (mode === "error") {
        assert.equal(s.replayed.length, 2);
        assert.equal(s.rejected.length, 0);
        const histories = s.replayed.map((body) => JSON.stringify(body.messages));
        assert.ok(histories.some((body) => body.includes("fixture-A.txt") && !body.includes("fixture-B.txt")));
        assert.ok(histories.some((body) => body.includes("fixture-B.txt") && !body.includes("fixture-A.txt")));
      } else {
        assert.equal(s.replayed.length, 0);
        assert.equal(s.rejected.length, 2);
      }
      assert.deepEqual(s.errors, []);
      results.push({ mode, resumed: s.replayed.length, rejected: s.rejected.length });
    } finally {
      await runtime.dispose();
    }
  }
  console.log(JSON.stringify({ ok: true, results }));
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  rmSync(projectPath, { recursive: true, force: true });
}
