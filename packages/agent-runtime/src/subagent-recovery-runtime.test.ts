import { createServer, type ServerResponse } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import type { Agent, AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { AgentEventEnvelope, Mode, SubagentDefinition, UiMessage } from "@pi-desktop/shared";
import { DesktopAgentRuntime } from "./runtime.js";
import type { RuntimeProviderConfig } from "./provider-binding.js";
import { SUBAGENT_STALL_MS } from "./subagent-provider-attempt.js";
import { genericModelConfig } from "./model-capabilities.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
type Request = { model: string; messages: Array<{ role: string; content?: unknown; tool_calls?: unknown[] }>; tools?: Array<{ function: { name: string } }>; max_tokens?: number; max_completion_tokens?: number };
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { vi.useRealTimers(); for (const close of cleanup.splice(0).reverse()) await close(); });
function chunk(res: ServerResponse, model: string, delta: unknown, finish_reason: string | null = null) {
  res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
}
function answer(res: ServerResponse, model: string, text = "Fixture report", tool?: { name: string; args: unknown }) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  chunk(res, model, tool ? { role: "assistant", tool_calls: [{ index: 0, id: `call-${tool.name}`, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] } : { role: "assistant", content: text });
  chunk(res, model, {}, tool ? "tool_calls" : "stop"); res.end("data: [DONE]\n\n");
}
async function server(handle: (body: Request, res: ServerResponse) => void | Promise<void>) {
  const requests: Request[] = [];
  const http = createServer(async (req, res) => {
    let raw = ""; for await (const part of req) raw += part;
    const body: Request = JSON.parse(raw); requests.push(body); await handle(body, res);
  });
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => { http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); });
  const address = http.address(); if (!address || typeof address === "string") throw new Error("Fixture address missing");
  const provider = (id: string): RuntimeProviderConfig => ({ id, name: id, modelId: `${id}-model`,
    baseUrl: `http://127.0.0.1:${address.port}/v1`, apiStyle: "openai-chat", apiKey: "fixture-only", supportsReasoning: false, supportedThinkingLevels: ["off"] });
  return { requests, provider };
}
function fixture(parent: RuntimeProviderConfig, children: RuntimeProviderConfig[], options: {
  authorize?: (key: string) => Promise<RuntimeProviderConfig | undefined>;
  onEvent?: (event: AgentEventEnvelope) => void;
  tool?: () => Promise<string>;
  definition?: Partial<SubagentDefinition>;
  pinAlias?: string;
  mode?: Mode;
} = {}) {
  const events: AgentEventEnvelope[] = [];
  const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const catalog = Object.fromEntries(children.map((child, index) => [`${index === 0 ? options.pinAlias ?? child.id : child.id}/${child.modelId}`, child]));
  const runtime = new DesktopAgentRuntime({
    sessionId: "recovery-fixture", mode: options.mode ?? "agent", provider: parent, thinkingLevel: "off",
    commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
    subagentProviders: catalog, subagentModelKeys: Object.keys(catalog),
    subagents: [{ name: "explorer", description: "Fixture child", prompt: "Inspect fixture", source: "builtin", tools: ["Read"],
      model: { providerId: options.pinAlias ?? children[0].id, modelId: children[0].modelId }, ...options.definition }],
    compactionSettings: { enabled: false, reserveTokens: 0, keepRecentTokens: 0 },
    host: { async call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
      calls.push({ method, params });
      if (method === "tools.fileBatchCapabilities") return { version: 1, supported: false } as T;
      if (method === "provider.resolveSubagentModel") return (options.authorize ? await options.authorize(String(params?.key)) : catalog[String(params?.key)]) as T;
      if (method === "tools.execute") return { ok: true, content: [{ type: "text", text: await options.tool?.() ?? "Completed read output" }] } as T;
      return undefined as T;
    }, onNotification: () => () => {} },
    onEvent(event) { events.push(event); options.onEvent?.(event); },
  });
  cleanup.push(() => runtime.dispose());
  // Invoke actual catalog tools at the nearest service boundary for race tests.
  const tool = (name: string): AgentTool => {
    const tool = (runtime as unknown as { agent: Agent }).agent.state.tools.find(tool => tool.name === name);
    if (!tool) throw new Error(`Fixture tool ${name} is unavailable`);
    return tool;
  };
  return { runtime, events, calls, tool };
}
function details(result: AgentToolResult<unknown>): Record<string, unknown> { return result.details as Record<string, unknown>; }
function delegationId(result: AgentToolResult<unknown>): string { return String(details(result).delegationId); }
function clock() { vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] }); }

it.each([undefined, "catalog-alias"])("parent Task → stalled TaskWait → TaskRecover continues without replaying completed tools (pin alias: %s)", async pinAlias => {
  clock();
  const stuck = deferred(); const waiting = deferred(); const resumed = deferred();
  let id = ""; let parentCalls = 0; let slowCalls = 0; let waitResult: Record<string, unknown> | undefined;
  const s = await server((body, res) => {
    if (body.model === "slow-model") {
      if (++slowCalls === 1) answer(res, body.model, "", { name: "Read", args: { path: "fixture.txt" } });
      else { res.writeHead(200, { "content-type": "text/event-stream" }); chunk(res, body.model, { role: "assistant", reasoning_content: "Waiting for fixture" }); }
    } else if (body.model === "fast-model") { resumed.resolve(); answer(res, body.model, "Recovered child report"); }
    else {
      parentCalls += 1;
      if (parentCalls === 1) answer(res, body.model, "", { name: "Task", args: { agent: "explorer", task: "Read fixture and report" } });
      else if (parentCalls === 2) answer(res, body.model, "", { name: "TaskWait", args: { delegationIds: [id], timeoutSeconds: 300 } });
      else if (parentCalls === 3) answer(res, body.model, "", { name: "TaskRecover", args: { delegationId: id, model: "fast/fast-model" } });
      else if (parentCalls === 4) answer(res, body.model, "", { name: "TaskWait", args: { delegationIds: [id] } });
      else answer(res, body.model, "Integrated child report");
    }
  });
  const f = fixture(s.provider("parent"), [s.provider("slow"), s.provider("fast")], { pinAlias, definition: { inheritTools: true }, onEvent: envelope => {
    const event = envelope.event;
    if (event.type === "tool_end" && event.toolCallId === "call-Task") id = delegationId(event.result as AgentToolResult<unknown>);
    if (event.type === "tool_start" && event.toolName === "TaskWait") waiting.resolve();
    if (event.type === "tool_end" && event.toolCallId === "call-TaskWait" && !waitResult) waitResult = details(event.result as AgentToolResult<unknown>);
    if (envelope.parentToolCallId && (event.type === "message_start" || event.type === "message_update") && event.message.thinking?.includes("Waiting for fixture")) stuck.resolve();
  } });
  const run = f.runtime.prompt("Delegate the fixture and recover if stalled", "user", "turn");
  await stuck.promise; await waiting.promise;
  await vi.advanceTimersByTimeAsync(SUBAGENT_STALL_MS - 1);
  expect(waitResult).toBeUndefined(); expect(s.requests.filter(body => body.model === "fast-model")).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(2);
  await resumed.promise; await run;
  expect(waitResult).toMatchObject({ status: "stalled", delegations: [{ status: "running", phase: "provider", stalled: true }] });
  expect(slowCalls).toBe(2);
  const recovered = s.requests.find(body => body.model === "fast-model");
  expect(JSON.stringify(recovered?.messages)).toContain("Completed read output");
  expect(f.calls.filter(call => call.method === "tools.execute")).toHaveLength(1);
  expect(f.calls.filter(call => call.method === "provider.resolveSubagentModel")).toEqual([{ method: "provider.resolveSubagentModel", params: { key: "fast/fast-model" } }]);
  const result = f.events.find(envelope => envelope.event.type === "tool_end" && envelope.event.toolCallId === "call-TaskRecover");
  expect(result?.event.type === "tool_end" && details(result.event.result as AgentToolResult<unknown>)).toMatchObject({ status: "recovered", oldModelKey: "slow/slow-model", newModelKey: "fast/fast-model" });
  const rows = details(await f.tool("TaskList").execute("list", {}));
  expect(rows.delegations).toMatchObject([{ status: "completed", modelKey: "fast/fast-model", previousModelKey: "slow/slow-model", stalled: false }]);
  expect(s.requests.filter(body => body.model === "parent-model")).toHaveLength(5);
  expect(s.requests.filter(body => body.model !== "parent-model").every(body => !body.tools?.some(tool => tool.function.name === "TaskRecover"))).toBe(true);
  expect(f.events.filter(envelope => envelope.event.type === "agent_end" && !envelope.parentToolCallId)).toHaveLength(1);
  const settlements = f.events.filter(({ event }) => event.type === "message_end" && event.message.role === "tool" &&
    (event.message.toolResult as AgentToolResult<Record<string, unknown>> | undefined)?.details?.status === "completed" && event.message.toolName === "Task");
  expect(settlements).toHaveLength(1);
  expect(JSON.stringify(rows)).not.toContain("fixture-only");
});

async function blocked(options: Parameters<typeof fixture>[2] = {}) {
  clock(); const requested = deferred(); let response: ServerResponse | undefined;
  const s = await server((body, res) => {
    if (body.model === "slow-model") { response = res; res.writeHead(200, { "content-type": "text/event-stream" }); chunk(res, body.model, { role: "assistant", reasoning_content: "Waiting for fixture" }); }
    else answer(res, body.model);
  });
  const slow = s.provider("slow"); const fast = s.provider("fast");
  const f = fixture(s.provider("parent"), [slow, fast], { ...options, onEvent(envelope) {
    options.onEvent?.(envelope);
    const event = envelope.event;
    if ((event.type === "message_start" || event.type === "message_update") && event.message.thinking?.includes("Waiting for fixture")) requested.resolve();
  } });
  const id = delegationId(await f.tool("Task").execute("task", { agent: "explorer", task: "Inspect fixture" }));
  await requested.promise; await vi.advanceTimersByTimeAsync(SUBAGENT_STALL_MS);
  return { ...f, s, slow, fast, id, response: () => { if (!response) throw new Error("Missing response"); return response; },
    recover: (model = "fast/fast-model") => f.tool("TaskRecover").execute("recover", { delegationId: id, model }) };
}

it("reauthorizes every recovery and rejects unknown, revoked, mismatched and unchanged bindings without disturbing the attempt", async () => {
  let authorized: RuntimeProviderConfig | undefined;
  const f = await blocked({ authorize: async () => authorized });
  for (const model of ["missing/model", "fast/fast-model"]) expect(details(await f.recover(model)).error).toMatch(/not available/);
  expect(details(await f.recover("slow/slow-model")).error).toMatch(/different/);
  authorized = f.fast;
  expect(details(await f.recover("wrong/fast-model")).error).toMatch(/exact authorized/);
  expect(f.s.requests).toHaveLength(1);
  expect(details(await f.tool("TaskList").execute("list", {})).delegations).toMatchObject([{ phase: "provider", stalled: true, status: "running" }]);
  // Ordinary Task uses the cached catalog binding; recovery must still ask Main.
  const selected = await f.tool("Task").execute("grant", { agent: "explorer", task: "Another fixture", model: "fast/fast-model" });
  await f.tool("TaskWait").execute("wait-grant", { delegationIds: [delegationId(selected)] });
  authorized = undefined;
  expect(details(await f.recover()).error).toMatch(/not available/);
  expect(f.calls.filter(call => call.method === "provider.resolveSubagentModel" && call.params?.key === "fast/fast-model")).toHaveLength(2);
  authorized = f.fast;
  expect(details(await f.recover())).toMatchObject({ status: "recovered" });
  await f.tool("TaskWait").execute("done", { delegationIds: [f.id] });
  expect(details(await f.recover()).error).toMatch(/live parent-owned/);
});

it.each(["stop", "dispose", "activity", "settled", "mode", "turn", "child"] as const)("rejects late authorization after %s and never starts the replacement", async action => {
  const auth = deferred<RuntimeProviderConfig | undefined>(); const authorizing = deferred();
  const f = await blocked({ authorize: async () => { authorizing.resolve(); return auth.promise; } });
  const recovery = f.recover(); await authorizing.promise;
  expect(details(await f.recover()).error).toMatch(/already pending/);
  if (action === "stop") await f.runtime.stopSubagents([f.id]);
  if (action === "dispose") await f.runtime.dispose();
  if (action === "mode") f.runtime.setMode("plan");
  if (action === "turn") (f.runtime as unknown as { turnEpoch: number }).turnEpoch += 1;
  if (action === "child") (f.runtime as unknown as { delegations: Map<string, unknown> }).delegations.delete(f.id);
  if (action === "activity" || action === "settled") {
    chunk(f.response(), "slow-model", { role: "assistant", reasoning_content: "Still thinking" });
    const event = deferred();
    // Wait for the actual provider event, not an arbitrary delay.
    const progress = (f.runtime as unknown as { delegations: Map<string, { run: { providerAttempt: { snapshot(): { stalled: boolean } } } }> }).delegations.get(f.id)?.run.providerAttempt;
    await vi.waitFor(() => { expect(progress?.snapshot().stalled).toBe(false); event.resolve(); });
    await event.promise;
    if (action === "settled") {
      chunk(f.response(), "slow-model", { content: "Original completed" }); chunk(f.response(), "slow-model", {}, "stop"); f.response().end("data: [DONE]\n\n");
      await f.tool("TaskWait").execute("wait", { delegationIds: [f.id] });
    }
  }
  auth.resolve(f.fast);
  expect(details(await recovery).error).toMatch(/changed|cancelled|live parent-owned|stopped|resumed activity/);
  expect(f.s.requests.every(body => body.model === "slow-model")).toBe(true);
});

it("serializes recovery with ordered user model selections and keeps queued messages in order", async () => {
  clock();
  const thinking = deferred(); const parentRequested = deferred(); const selectedRequested = deferred();
  const authorizing = deferred(); const authorization = deferred<RuntimeProviderConfig>();
  let parentResponse: ServerResponse | undefined; let selectedResponse: ServerResponse | undefined;
  const s = await server((body, res) => {
    if (body.model === "parent-model") { parentResponse = res; parentRequested.resolve(); }
    else if (body.model === "slow-model") {
      res.writeHead(200, { "content-type": "text/event-stream" }); chunk(res, body.model, { role: "assistant", reasoning_content: "Waiting for fixture" });
    } else if (body.model === "selected-model" && !selectedResponse) { selectedResponse = res; selectedRequested.resolve(); }
    else answer(res, body.model);
  });
  const f = fixture(s.provider("parent"), [s.provider("slow"), s.provider("fast"), s.provider("selected")], {
    authorize: async key => {
      if (key === "fast/fast-model") { authorizing.resolve(); return authorization.promise; }
      return s.provider("selected");
    },
    onEvent({ event }) { if ((event.type === "message_start" || event.type === "message_update") && event.message.thinking?.includes("Waiting for fixture")) thinking.resolve(); },
  });
  const parentRun = f.runtime.prompt("Work alongside a child", "user", "parent-turn"); await parentRequested.promise;
  const id = delegationId(await f.tool("Task").execute("task", { agent: "explorer", task: "Original fixture task" }));
  await thinking.promise; await vi.advanceTimersByTimeAsync(SUBAGENT_STALL_MS);
  const send = (operationId: string, content: string, model?: string) => f.runtime.controlSubagent({
    sessionId: "recovery-fixture", operationId, action: "message", delegationId: id, content, model,
  }, "parent-turn");
  expect((await send("first", "First direction", "selected/selected-model")).delivery).toBe("queued");
  const recovery = f.tool("TaskRecover").execute("recover", { delegationId: id, model: "fast/fast-model" });
  await authorizing.promise;
  const second = send("second", "Second direction");
  expect(f.calls.filter(call => call.method === "session.appendMessage")
    .map(call => call.params?.message as UiMessage).filter(message => message.subagentControl)
    .map(message => message.content)).toEqual(["First direction"]);
  authorization.resolve(s.provider("fast"));
  expect(details(await recovery)).toMatchObject({ oldModelKey: "slow/slow-model", newModelKey: "fast/fast-model" });
  expect((await second).delivery).toBe("queued");
  await selectedRequested.promise;
  if (!selectedResponse) throw new Error("Missing selected response");
  answer(selectedResponse, "selected-model");
  await f.tool("TaskWait").execute("wait", { delegationIds: [id] });
  const childRequests = s.requests.filter(body => body.model !== "parent-model");
  expect(childRequests.map(body => body.model)).toEqual(["slow-model", "fast-model", "selected-model", "selected-model"]);
  const users = (body: Request) => body.messages.filter(message => message.role === "user").map(({ content }) =>
    Array.isArray(content) ? content.map((part: { text?: string }) => part.text ?? "").join("") : content);
  expect(users(childRequests[1])).toEqual(["Original fixture task"]);
  expect(users(childRequests[2])).toEqual(["Original fixture task", "First direction"]);
  expect(users(childRequests[3])).toEqual(["Original fixture task", "First direction", "Second direction"]);
  expect(details(await f.tool("TaskList").execute("list", {})).delegations).toMatchObject([{ modelKey: "selected/selected-model", status: "completed" }]);
  if (!parentResponse) throw new Error("Missing parent response");
  answer(parentResponse, "parent-model", "Parent report"); await parentRun;
});

it("recovers a request with no headers or provider events without retrying the abandoned binding", async () => {
  clock(); const requested = deferred();
  const s = await server((body, res) => {
    if (body.model === "slow-model") requested.resolve();
    else answer(res, body.model, "Recovered before first byte");
  });
  const f = fixture(s.provider("parent"), [s.provider("slow"), s.provider("fast")]);
  const id = delegationId(await f.tool("Task").execute("task", { agent: "explorer", task: "Original request" }));
  await requested.promise;
  expect(details(await f.tool("TaskRecover").execute("early", { delegationId: id, model: "fast/fast-model" })).error).toMatch(/no active provider attempt stalled/);
  expect(f.calls.filter(call => call.method === "provider.resolveSubagentModel")).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(SUBAGENT_STALL_MS);
  expect(details(await f.tool("TaskRecover").execute("recover", { delegationId: id, model: "fast/fast-model" }))).toMatchObject({ status: "recovered" });
  expect(details(await f.tool("TaskWait").execute("wait", { delegationIds: [id] })).delegations).toMatchObject([{ status: "completed", report: expect.stringContaining("Recovered before first byte") }]);
  expect(s.requests.map(body => body.model)).toEqual(["slow-model", "fast-model"]);
});

it("preflights carried context against the replacement's smaller budget without replaying completed tools", async () => {
  clock(); const thinking = deferred(); let slowCalls = 0;
  const evidence = "Completed finding with evidence. ".repeat(2_000);
  const s = await server((body, res) => {
    if (body.model === "slow-model") {
      if (++slowCalls === 1) answer(res, body.model, "", { name: "Read", args: { path: "fixture.txt" } });
      else { res.writeHead(200, { "content-type": "text/event-stream" }); chunk(res, body.model, { role: "assistant", reasoning_content: "Waiting for fixture" }); }
    } else answer(res, body.model, "Retained compact evidence");
  });
  const base = s.provider("small");
  const small = { ...base, modelConfig: { ...genericModelConfig(base.modelId, base.baseUrl!), contextWindow: 4096, maxTokens: 512 } };
  const f = fixture(s.provider("parent"), [s.provider("slow"), small], {
    tool: async () => evidence,
    onEvent({ event }) { if ((event.type === "message_start" || event.type === "message_update") && event.message.thinking?.includes("Waiting for fixture")) thinking.resolve(); },
  });
  const id = delegationId(await f.tool("Task").execute("task", { agent: "explorer", task: "Inspect the completed findings" }));
  await thinking.promise; await vi.advanceTimersByTimeAsync(SUBAGENT_STALL_MS);
  expect(details(await f.tool("TaskRecover").execute("recover", { delegationId: id, model: "small/small-model" })).status).toBe("recovered");
  const result = details(await f.tool("TaskWait").execute("wait", { delegationIds: [id] }));
  expect(result.delegations).toMatchObject([{ status: "completed", modelKey: "small/small-model" }]);
  const request = s.requests.filter(body => body.model === "small-model").at(-1);
  expect(request).toBeDefined();
  expect(request?.max_tokens ?? request?.max_completion_tokens).toBeLessThanOrEqual(512);
  expect(JSON.stringify(request?.messages).includes(evidence)).toBe(false);
  expect(f.calls.filter(call => call.method === "tools.execute")).toHaveLength(1);
});

it("does not recover a tool-busy child even after 120 seconds without output", async () => {
  clock(); const started = deferred(); const release = deferred<string>();
  const s = await server((body, res) => answer(res, body.model, "", { name: "Read", args: { path: "fixture.txt" } }));
  const f = fixture(s.provider("parent"), [s.provider("slow"), s.provider("fast")], { tool: async () => { started.resolve(); return release.promise; } });
  const id = delegationId(await f.tool("Task").execute("task", { agent: "explorer", task: "Read fixture" }));
  await started.promise; await vi.advanceTimersByTimeAsync(SUBAGENT_STALL_MS * 2);
  expect(details(await f.tool("TaskList").execute("list", {})).delegations).toMatchObject([{ phase: "tools", stalled: false }]);
  expect(details(await f.tool("TaskRecover").execute("recover", { delegationId: id, model: "fast/fast-model" })).error).toMatch(/no active/);
  expect(f.calls.filter(call => call.method === "provider.resolveSubagentModel")).toHaveLength(0);
  const stopped = f.runtime.stopSubagents([id]); release.resolve("Read finished after Stop"); await stopped;
});

it("limits recovery to Agent-mode, parent-owned live records in this runtime and preserves Task resume rejection", async () => {
  const f = await blocked();
  for (const mode of ["plan", "goal"] as const) {
    const other = fixture(f.s.provider("parent"), [f.slow, f.fast], { mode });
    expect(() => other.tool("TaskRecover")).toThrow(/unavailable/);
  }
  const other = fixture(f.s.provider("parent"), [f.slow, f.fast]);
  expect(details(await other.tool("TaskRecover").execute("foreign", { delegationId: f.id, model: "fast/fast-model" })).error).toMatch(/live parent-owned/);
  expect(details(await f.tool("Task").execute("resume", { agent: "explorer", resume: f.id, task: "Keep going", model: "fast/fast-model" })).error).toMatch(/cannot change its model/);
  const owned = await other.runtime.controlSubagent({ sessionId: "recovery-fixture", operationId: "owned", action: "start", agent: "explorer", task: "Owned fixture" }, "owned-turn");
  expect(details(await other.tool("TaskRecover").execute("owned", { delegationId: owned.delegationId, model: "fast/fast-model" })).error).toMatch(/live parent-owned/);
  expect(other.calls.filter(call => call.method === "provider.resolveSubagentModel")).toHaveLength(0);
});

it("waits only for selected children and preserves timeout and abort semantics with disposable stall listeners", async () => {
  const started = deferred(); let firstId = "";
  const f = await blocked({ onEvent(envelope) {
    const event = envelope.event;
    if (firstId && envelope.parentToolCallId !== "task" && (event.type === "message_start" || event.type === "message_update") && event.message.thinking) started.resolve();
  } });
  firstId = f.id;
  const id = delegationId(await f.tool("Task").execute("fresh-task", { agent: "explorer", task: "New request" }));
  await started.promise;
  // An unselected stalled child must not wake this fresh child's wait.
  const timerCount = vi.getTimerCount();
  const timeout = f.tool("TaskWait").execute("timeout", { delegationIds: [id], timeoutSeconds: 1 });
  await vi.advanceTimersByTimeAsync(1000);
  expect(details(await timeout)).toMatchObject({ status: "timeout", delegations: [{ delegationId: id, status: "running", stalled: false }] });
  expect(vi.getTimerCount()).toBeLessThanOrEqual(timerCount);
  const controller = new AbortController();
  const waiting = f.tool("TaskWait").execute("abort", { delegationIds: [id] }, controller.signal);
  controller.abort();
  expect(details(await waiting)).toMatchObject({ status: "timeout", delegations: [{ status: "running", stalled: false }] });
  expect(vi.getTimerCount()).toBeLessThanOrEqual(timerCount);
  expect(details(await f.tool("TaskWait").execute("already-stalled", { delegationIds: [f.id] })).status).toBe("stalled");
});

it("reports a stalled attempt once and lets repeated waits block until timeout or completion", async () => {
  const f = await blocked();
  expect(details(await f.tool("TaskWait").execute("first-stall", { delegationIds: [f.id] })).status).toBe("stalled");
  let returned = false;
  const repeated = f.tool("TaskWait").execute("repeat-stall", { delegationIds: [f.id], timeoutSeconds: 1 }).then(result => {
    returned = true;
    return result;
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(returned).toBe(false);
  await vi.advanceTimersByTimeAsync(1000);
  expect(details(await repeated)).toMatchObject({ status: "timeout", delegations: [{ status: "running", stalled: true }] });
  const completed = f.tool("TaskWait").execute("after-observation", { delegationIds: [f.id] });
  expect(details(await f.recover()).status).toBe("recovered");
  expect(details(await completed)).toMatchObject({ status: "completed", delegations: [{ status: "completed" }] });
});
