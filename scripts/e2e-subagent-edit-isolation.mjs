import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { DesktopAgentRuntime } from "../packages/agent-runtime/dist/runtime.js";

// Real Runtime -> pi Agent -> SubagentRun. Only the provider and host tool
// boundary are deterministic fixtures; no production model or Desktop state.
let sequence = 0;
const labels = process.argv.includes("--single") ? ["A"] : ["A", "B"];
const patchCommand = process.argv.includes("--patch");
const toolName = patchCommand ? "Bash" : "Edit";
const aStopped = Promise.withResolvers();
const completed = new Map([...labels.map((label) => `task_${label}`), "resume_A"]
  .map((id) => [id, Promise.withResolvers()]));
async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 15_000);
    })]);
  } finally {
    clearTimeout(timer);
  }
}
const state = { editCalls: new Map(), parentErrors: [], taskResults: new Map(), taskIds: new Map(), errors: [] };
const reply = (res, model, calls, text = "Finished") => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const chunk = (delta, finish_reason) => res.write(`data: ${JSON.stringify({
    id: `fixture-${++sequence}`, object: "chat.completion.chunk", created: 1, model,
    choices: [{ index: 0, delta, finish_reason }],
  })}\n\n`);
  chunk(calls ? { role: "assistant", ...(text ? { content: text } : {}), tool_calls: calls.map((call, index) => ({
    index, id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) },
  })) } : { role: "assistant", content: text }, null);
  chunk({}, calls ? "tool_calls" : "stop");
  res.end("data: [DONE]\n\n");
};
const labelFor = (body) => JSON.stringify(body.messages.find((message) => message.role === "user")?.content).includes("Task A") ? "A" : "B";
const server = createServer(async (req, res) => {
  try {
    let raw = "";
    for await (const part of req) raw += part;
    const body = JSON.parse(raw);
    if (body.model === "worker") {
      const latestUser = JSON.stringify(body.messages.filter((message) => message.role === "user").at(-1)?.content);
      if (latestUser.includes("Continue after the stopped edit")) {
        reply(res, body.model, null, "Resumed and completed successfully.");
        return;
      }
      const label = labelFor(body);
      const count = state.editCalls.get(label) ?? 0;
      if (label === "B" && count >= 2) {
        await bounded(aStopped.promise, "delegate A's third Edit");
        reply(res, body.model, null, "Delegate B continued after A stopped.");
      } else {
        state.editCalls.set(label, count + 1);
        reply(res, body.model, [{
          id: `edit_${label}_${count + 1}`, name: toolName,
          args: patchCommand ? { command: "git apply fixture.patch" }
            : { path: "fixture.go", tag: "ABCD", ops: "PUT 1.=1:" },
        }], count === 0 ? "Preparing to edit the shared file." : "");
      }
      return;
    }
    const latestUser = JSON.stringify(body.messages.filter((message) => message.role === "user").at(-1)?.content);
    if (latestUser.includes("Resume Task A") && !state.resumeSent) {
      state.resumeSent = true;
      reply(res, body.model, [{ id: "resume_A", name: "Task",
        args: { agent: "writer", task: "Continue after the stopped edit", resume: state.taskIds.get("task_A") } }]);
    } else if (!state.started) {
      state.started = true;
      reply(res, body.model, labels.map((label) => ({
        id: `task_${label}`, name: "Task", args: { agent: "writer", task: `Task ${label}` },
      })));
    } else reply(res, body.model, null, "Both delegates finished.");
  } catch (error) {
    state.errors.push(error);
    if (!res.headersSent) res.writeHead(500);
    res.end(String(error));
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
const provider = (modelId) => ({ id: "fixture", name: "Fixture", modelId, baseUrl,
  apiKey: "", authKind: "none", apiStyle: "openai-chat", supportsReasoning: false,
  supportedThinkingLevels: ["off"] });
const artifactRoot = join(process.cwd(), ".artifacts");
mkdirSync(artifactRoot, { recursive: true });
const projectPath = mkdtempSync(join(artifactRoot, "subagent-edit-isolation-"));
const runtime = new DesktopAgentRuntime({
  sessionId: "fixture-edit-isolation", mode: "agent", provider: provider("parent"), thinkingLevel: "off", projectPath,
  commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
  subagents: [{ name: "writer", description: "Fixture writer", prompt: "Edit the task's file",
    tools: [toolName], source: "user", permission: "accept-edits", model: { providerId: "fixture", modelId: "worker" } }],
  subagentProviders: { "fixture/worker": provider("worker") },
  host: { onNotification: () => () => {}, call: async (method, params) => {
    if (method === "project.instructions.resolve") return { entries: [] };
    if (method === "tools.execute") {
      assert.equal(params.toolName, toolName);
      return { ok: false, isError: true, errorCode: patchCommand ? "TOOL_FAILED" : "EDIT_PARSE_FAILED", content: { error: "malformed mutation" } };
    }
    return {};
  } },
  onEvent: ({ event, parentToolCallId }) => {
    if (parentToolCallId) {
      if (event.type === "tool_end" && event.toolCallId === "edit_A_3" && event.result?.terminate) {
        state.aTerminated = true;
        aStopped.resolve();
      }
      return;
    }
    if (event.type === "error") state.parentErrors.push(event.error);
    if (event.type === "tool_end" && event.result?.details?.delegationId && event.toolCallId.startsWith("task_")) {
      state.taskIds.set(event.toolCallId, event.result.details.delegationId);
    }
    if (event.type === "message_end" && event.message?.toolName === "Task" && event.message.toolResult?.details?.status !== "running") {
      state.taskResults.set(event.message.toolCallId, event.message.toolResult.details);
      completed.get(event.message.toolCallId)?.resolve();
    }
  },
});
try {
  await bounded(runtime.prompt(`Start ${labels.map((label) => `Task ${label}`).join(" and ")}`), "parent turn");
  await bounded(Promise.all(labels.map((label) => completed.get(`task_${label}`).promise)), "delegate results");
  console.log(JSON.stringify({ phase: "initial", editCalls: Object.fromEntries(state.editCalls),
    results: Object.fromEntries([...state.taskResults].map(([id, result]) => [id, { status: result.status, error: result.error }])),
    parentErrors: state.parentErrors.map((error) => error.code) }));
  assert.equal(state.editCalls.get("A"), 3, "delegate A reaches its own third failure");
  assert.equal(state.aTerminated, true);
  assert.equal(state.taskResults.get("task_A")?.status, "failed", "delegate A reports its exhausted budget as a failure");
  assert.equal(state.taskResults.get("task_A")?.error?.code, "MUTATION_RETRY_BUDGET_EXHAUSTED");
  if (labels.includes("B")) {
    assert.equal(state.editCalls.get("B"), 2, "delegate B remains below its own limit");
    assert.equal(state.taskResults.get("task_B")?.status, "completed", "delegate B completes after A stops");
  }
  assert.equal(state.parentErrors.some((error) => error.code === "MUTATION_RETRY_BUDGET_EXHAUSTED"), false);
  assert.equal(state.taskIds.has("task_A"), true);
  await bounded(runtime.prompt("Resume Task A"), "parent resume turn");
  await bounded(completed.get("resume_A").promise, "resumed delegate result");
  assert.equal(state.taskResults.get("resume_A")?.status, "completed");
  assert.deepEqual(state.errors, []);
  console.log(JSON.stringify({ ok: true, editCalls: Object.fromEntries(state.editCalls), parentMutationErrors: 0, resumed: "completed" }));
} finally {
  await runtime.dispose();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  // Keep the isolated fixture directory for post-run inspection.
}
