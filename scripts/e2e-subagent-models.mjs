#!/usr/bin/env node
/** E2E-166 and E2E-SUBAGENT-ordered-model-fallback-preserves-work: real sidecar + local transport. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readNdjsonLines } from "../packages/shared/dist/ndjson.js";
import { fileURLToPath } from "node:url";

const requests = [];
const resolutions = [];
const scenarios = new Map();
const events = [];
const pending = new Map();
let sequence = 0;
const server = createServer(async (req, res) => {
  try {
    let body = "";
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body);
    requests.push(payload);
    const user = payload.messages.findLast((m) => m.role === "user");
    const userText = typeof user?.content === "string" ? user.content : JSON.stringify(user?.content);
    const scenario = [...scenarios.values()].find((s) => userText.includes(s.marker));
    const isParent = payload.tools?.some((t) => t.function?.name === "Task");
    if (!isParent && payload.model.startsWith("unavailable-")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "model not found" } }));
      return;
    }
    const first = scenario && isParent && !scenario.called;
    if (first) scenario.called = true;
    const delta = first
      ? { role: "assistant", tool_calls: [{ index: 0, id: `call_${++sequence}`, type: "function", function: { name: "Task", arguments: JSON.stringify(scenario.args) } }] }
      : { role: "assistant", content: "Fixture finished." };
    const base = { id: `chatcmpl-${++sequence}`, object: "chat.completion.chunk", created: 1, model: payload.model };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: first ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
    res.end("data: [DONE]\n\n");
  } catch (error) {
    res.writeHead(500);
    res.end(String(error));
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
const model = (modelId) => ({
  id: "fixture", name: "Fixture", baseUrl, modelId, apiKey: "", authKind: "none",
  apiStyle: "openai-chat", supportsReasoning: false, supportedThinkingLevels: ["off"],
});
const bindings = { "fixture/private": model("private"), "fixture/allowed": model("allowed") };
const INHERIT_DENY_TOOLS = [
  "Task",
  "TaskWait",
  "TaskList",
  "TaskStop",
  "EnterPlanMode",
  "EnterGoalMode",
  "asktool",
  "new_context",
  "ToolSearch",
];
const fixturePluginTools = [
  { name: "plugin_fixture_echo", description: "Deterministic fixture plugin tool." },
];
const fixtureSkills = [
  {
    id: "fixture.skills/release-notes",
    name: "Fixture release notes",
    description: "Use the fixture release-note workflow.",
  },
];
const EXPECTED_INHERITED_PARENT_TOOLS = [
  "Read",
  "Bash",
  "Edit",
  "Write",
  "Glob",
  "Grep",
  "BrowserPreview",
  "PluginCheck",
  "PluginScaffold",
  "PluginPack",
  "plugin_fixture_echo",
  "Skill",
];
const builtinExplorerDefinition = {
  name: "explorer",
  description: "Built-in codebase explorer.",
  tools: ["Read", "Glob", "Grep", "Bash"],
  prompt: "Search the requested files and report exact paths.",
  source: "builtin",
};
const definition = (name, pin, options = {}) => ({
  name, description: "Read-only fixture", tools: options.tools ?? ["Read"], prompt: "Return Fixture finished without using tools.",
  source: "user",
  ...(options.inheritTools ? { inheritTools: true } : {}),
  ...(pin ? { model: { providerId: "fixture", modelId: pin } } : {}),
});
const child = spawn(process.execPath, [fileURLToPath(new URL("../packages/agent-runtime/dist/sidecar.js", import.meta.url))], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, PI_DESKTOP_PLAN_UI_PROBE: "1" },
});
let stderr = "";
child.stderr.on("data", (chunk) => { stderr += chunk; });
const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const lines = readNdjsonLines(child.stdout, (line) => {
  const message = JSON.parse(line);
  if (message.method === "host.proxy") {
    const { method, params } = message.params;
    if (method === "provider.resolveSubagentModel") {
      resolutions.push(params.key);
      send(params.key === "fixture/dynamic"
        ? { id: message.id, result: model("dynamic") }
        : { id: message.id, error: { code: -32000, message: "model is not enabled for delegation" } });
    } else {
      send({ id: message.id, result: method === "session.get" ? { session: { messages: [] } } : {} });
    }
  } else if (message.id != null) {
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
    else entry.resolve(message.result);
  } else if (message.method === "agent.event") events.push(message.params);
});
function rpc(method, params) {
  const id = `test-${++sequence}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`RPC timed out: ${method}`)); }, 10_000);
    pending.set(id, { resolve, reject, timer });
    send({ id, method, params });
  });
}
async function until(predicate) {
  const deadline = Date.now() + 15_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `sidecar scenario timed out\n${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
async function run(id, args, expectedModel, keys = ["fixture/allowed"], sessionId = id, options = {}) {
  const inheritCatalog = options.inheritCatalog === true;
  const fallbackModels = options.fallbackModels;
  const primaryModel = options.primaryModel ?? (fallbackModels ? "unavailable-primary" : "private");
  const subagents = [
    { ...definition("reviewer", primaryModel),
      ...(fallbackModels ? { fallbackModels: fallbackModels.map((modelId) => ({ providerId: "fixture", modelId })) } : {}),
    },
    inheritCatalog ? builtinExplorerDefinition : definition("explorer"),
    ...(inheritCatalog ? [definition("worker", undefined, { inheritTools: true, tools: [] })] : []),
  ];
  const marker = `scenario-${id}`;
  const before = requests.length;
  scenarios.set(id, { marker, args: { ...args, task: `Complete fixture ${id}.` } });
  await rpc("agent.prompt", {
    sessionId, turnId: id, content: marker, mode: "agent", provider: model("parent"), thinkingLevel: "off",
    commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
    subagents,
    pluginTools: inheritCatalog ? fixturePluginTools : undefined,
    pluginSkills: inheritCatalog ? fixtureSkills : undefined,
    subagentProviders: { ...bindings, ...options.bindings }, subagentModelKeys: keys,
  });
  await until(() => events.some((e) => e.sessionId === sessionId && e.turnId === id && e.event.type === "agent_end" && !e.parentToolCallId));
  const captured = requests.slice(before);
  const parent = captured.find((p) => p.tools?.some((t) => t.function?.name === "Task"));
  assert.ok(parent, "parent provider request reached local transport");
  const system = parent.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
  assert.ok(!system.includes("`fixture/private`"), "private pin must not enter override catalog");
  assert.ok(parent.tools.find((t) => t.function?.name === "Task").function.description.includes(`Default model: fixture/${primaryModel}`));
  const delegates = captured.filter((p) => !p.tools?.some((t) => t.function?.name === "Task"));
  if (expectedModel) assert.deepEqual(delegates.map((p) => p.model), options.expectedAttempts ?? [expectedModel]);
  else {
    assert.equal(delegates.length, 0, "forbidden override must not issue a provider request");
    assert.ok(captured.some((p) => p.messages.some((m) => m.role === "tool" && JSON.stringify(m.content).includes("not available for delegation"))));
  }
  if (fallbackModels) {
    for (const pin of fallbackModels) {
      assert.ok(!system.includes(`\`fixture/${pin}\``), "fallback pin stays out of the override catalog");
    }
    const taskMessages = events.filter((e) => e.sessionId === sessionId && e.turnId === id && e.event.type === "message_end")
      .map((e) => e.event.message).filter((m) => m.role === "tool" && m.toolName === "Task");
    const settled = taskMessages.at(-1)?.toolResult?.details;
    const expectedStatus = options.expectedStatus ?? "completed";
    const failures = options.expectedAttempts.filter((name) => name.startsWith("unavailable-"));
    assert.equal(settled?.modelId, expectedModel, "settlement keeps the effective model");
    assert.equal(settled?.status, expectedStatus, "the child must settle, not remain running or report false success");
    assert.deepEqual((settled.modelFailures ?? []).map((failure) => ({ model: failure.model, code: failure.code })),
      failures.map((name) => ({ model: `fixture/${name}`, code: "MODEL_NOT_CONFIGURED" })),
      "settlement preserves every failed model in order");
    if (expectedStatus === "failed") assert.equal(settled.error?.code, "MODEL_NOT_CONFIGURED");
    else assert.equal(settled.error, undefined);
    const reports = events.filter((e) => e.sessionId === sessionId && e.turnId === id && e.parentToolCallId &&
      e.event.type === "message_end" && e.event.message.role === "assistant" &&
      e.event.message.status === "complete" && e.event.message.content === "Fixture finished.");
    assert.deepEqual(reports.map((e) => e.event.message.modelId), expectedStatus === "completed" ? [expectedModel] : [],
      "only the successful child model writes the final report");
    for (const attempted of options.expectedAttempts.slice(1)) {
      assert.ok(taskMessages.some((message) => message.toolResult?.details?.modelId === attempted &&
        message.toolResult?.details?.status === "running"), "live Task metadata changes at every fallback");
    }
    for (const request of delegates) {
      const users = request.messages.filter((message) => message.role === "user");
      assert.equal(users.length, 1, "fallback retains the original task once");
      assert.ok(JSON.stringify(users[0].content).includes(`Complete fixture ${id}.`));
    }
    console.log(`PASS E2E-SUBAGENT-ordered-model-fallback-preserves-work ${id}: ${delegates.map((p) => p.model).join(" -> ")} => ${settled.status}`);
  }
  if (inheritCatalog) {
    const delegated = delegates.find((request) =>
      request.messages.some((message) =>
        message.role === "system" && String(message.content).includes(`\"${args.agent}\" subagent`),
      ),
    );
    assert.ok(delegated, `${args.agent} delegate provider request reached local transport`);
    const delegatedToolNames = delegated.tools.map((tool) => tool.function?.name);
    const delegatedSystem = delegated.messages
      .filter((message) => message.role === "system")
      .map((message) => String(message.content))
      .join("\n");
    if (args.agent === "worker") {
      assert.match(
        parent.tools.find((tool) => tool.function?.name === "Task").function.description,
        /worker \(tools: inherit\)/,
      );
      assert.match(system, /# Skills/);
      assert.match(system, /fixture\.skills\/release-notes/);
      assert.ok(delegatedToolNames.includes("Skill"), "inherit worker receives Skill");
      assert.ok(
        delegatedToolNames.includes("plugin_fixture_echo"),
        "inherit worker receives the fixture plugin tool",
      );
      assert.match(delegatedSystem, /# Skills/);
      assert.match(delegatedSystem, /fixture\.skills\/release-notes/);
      assert.match(delegatedSystem, /You may change files/);
      for (const inherited of EXPECTED_INHERITED_PARENT_TOOLS) {
        assert.ok(
          delegatedToolNames.includes(inherited),
          `inherit worker receives parent catalog tool ${inherited}`,
        );
      }
      for (const denied of INHERIT_DENY_TOOLS) {
        assert.ok(!delegatedToolNames.includes(denied), `${denied} must not be inherited`);
      }
    } else {
      assert.deepEqual(delegatedToolNames, ["Read", "Glob", "Grep", "Bash"]);
      assert.ok(!delegatedToolNames.includes("Skill"), "builtin explorer must not inherit Skill");
      assert.ok(!delegatedSystem.includes("# Skills"), "builtin explorer must not receive Skill guidance");
    }
  }
  if (!fallbackModels) console.log(`PASS E2E-166 ${id}`);
  return rpc("agent.testRuntimeIdentity", { sessionId });
}
try {
  await run("private-cross-definition", { agent: "explorer", model: "fixture/private" });
  assert.deepEqual(resolutions, ["fixture/private"]);
  await run("definition-default", { agent: "reviewer" }, "private");
  await run("own-pin-echo", { agent: "reviewer", model: "fixture/private" }, "private");
  assert.deepEqual(resolutions, ["fixture/private"]);
  await run("allowed-overrides-pin", { agent: "reviewer", model: "fixture/allowed" }, "allowed");
  const demand = await run("on-demand-opt-in", { agent: "explorer", model: "fixture/dynamic" }, "dynamic", ["fixture/allowed"], "demand");
  const demandAgain = await run("on-demand-reuse", { agent: "explorer", model: "fixture/dynamic" }, "dynamic", ["fixture/allowed"], "demand");
  assert.equal(demand.runtimeId, demandAgain.runtimeId, "on-demand grants must not retire an idle runtime");
  await run("session-inheritance", { agent: "explorer", model: "fixture/parent" }, "parent", []);
  const first = await run("before-revocation", { agent: "explorer", model: "fixture/allowed" }, "allowed", ["fixture/allowed"], "reload");
  const second = await run("after-revocation", { agent: "explorer", model: "fixture/allowed" }, undefined, [], "reload");
  assert.notEqual(first.runtimeId, second.runtimeId, "changed opt-in must retire an idle runtime");
  await run(
    "inherit-parent-tools",
    { agent: "worker" },
    "parent",
    ["fixture/allowed"],
    "inherit-tools",
    { inheritCatalog: true },
  );
  await run(
    "builtin-explorer-no-inherit",
    { agent: "explorer" },
    "parent",
    ["fixture/allowed"],
    "inherit-tools",
    { inheritCatalog: true },
  );
  for (const failedCount of [0, 1, 2, 3]) {
    const unavailable = ["unavailable-primary", "unavailable-secondary", "unavailable-third"].slice(0, failedCount);
    const expectedAttempts = [...unavailable, "fallback-private"];
    const chain = [...expectedAttempts, "unused-tail"];
    const id = `model-fallback-${failedCount}-unavailable`;
    await run(id, { agent: "reviewer" }, "fallback-private", [], id, {
      primaryModel: chain[0],
      fallbackModels: chain.slice(1),
      bindings: Object.fromEntries(chain.map((name) => [`fixture/${name}`, model(name)])),
      expectedAttempts,
    });
  }
  const unavailable = ["unavailable-primary", "unavailable-secondary", "unavailable-third", "unavailable-fourth"];
  await run("model-fallback-all-unavailable", { agent: "reviewer" }, "unavailable-fourth", [], "fallback-exhausted", {
    fallbackModels: unavailable.slice(1),
    bindings: Object.fromEntries(unavailable.map((name) => [`fixture/${name}`, model(name)])),
    expectedAttempts: unavailable,
    expectedStatus: "failed",
  });
  console.log("PASS E2E-166 changed opt-in rebuilds the sidecar runtime");
} finally {
  child.kill();
  await new Promise((resolve) => child.once("exit", resolve));
  lines.close();
  for (const entry of pending.values()) clearTimeout(entry.timer);
  await new Promise((resolve) => server.close(resolve));
}
