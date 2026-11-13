import { createServer } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentEventEnvelope, AgentSubagentControlRequest, AgentSubagentControlResponse, SessionThinkingLevel, SubagentDefinition, UiMessage } from "@pi-desktop/shared";
import { DesktopAgentRuntime } from "./runtime.js";
import { genericModelConfig } from "./model-capabilities.js";
import type { RuntimeProviderConfig } from "./provider-binding.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
function answer(content: string, model = "fixture-model") {
  const chunk = (delta: unknown, reason: string | null) => `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`;
  return new Response(chunk({ role: "assistant", content }, null) + chunk({}, "stop") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
}
const provider = { id: "fixture", name: "Fixture", modelId: "fixture-model", baseUrl: "http://provider.invalid/v1", apiKey: "fixture-only", apiStyle: "chat_completions" as const, supportsReasoning: false, supportedThinkingLevels: ["off" as const] };
const definition = { name: "explorer", description: "Inspect the fixture", tools: ["Read", "Skill"], prompt: "Fixture child guidance", source: "builtin" as const };
const commandShell = { id: "bash" as const, label: "Bash", dialect: "posix" as const, available: true, isDefault: true };
const runtimes: DesktopAgentRuntime[] = [];
const servers: Array<() => Promise<void>> = [];
type ProviderRequest = {
  path: string; authorization?: string; account?: string;
  body: { model: string; messages: Array<{ role: string; content: unknown }>; reasoning_effort?: string; max_tokens?: number; max_completion_tokens?: number };
};
function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part: unknown) => {
    if (!part || typeof part !== "object" || !("type" in part) || part.type !== "text" || !("text" in part)) return "";
    return typeof part.text === "string" ? part.text : "";
  }).join("");
}
function userMessages(request: ProviderRequest): string[] {
  return request.body.messages.filter(message => message.role === "user").map(message => messageText(message.content));
}

async function loopback(handle: (request: ProviderRequest, index: number) => Promise<Response> = async request => answer("Recorded result", request.body.model)) {
  const requests: ProviderRequest[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const part of req) raw += part;
    const request: ProviderRequest = {
      path: req.url ?? "", authorization: req.headers.authorization,
      account: String(req.headers["x-fixture-account"] ?? ""), body: JSON.parse(raw),
    };
    requests.push(request);
    const response = await handle(request, requests.length);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(await response.text());
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  servers.push(() => new Promise<void>((resolve, reject) => {
    server.closeAllConnections();
    server.close(error => error ? reject(error) : resolve());
  }));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  const provider = (id: string, modelId = `${id}-model`): RuntimeProviderConfig => ({
    id, name: id, modelId, baseUrl: `http://127.0.0.1:${address.port}/${id}/v1`,
    apiKey: `fixture-${id}`, apiStyle: "openai-chat", headers: { "x-fixture-account": id },
    supportsReasoning: false, supportedThinkingLevels: ["off"],
  });
  return { requests, provider };
}
function modelCatalog(...providers: RuntimeProviderConfig[]) {
  const subagentProviders = Object.fromEntries(providers.map(provider => [`${provider.id}/${provider.modelId}`, provider]));
  return { subagentProviders, subagentModelKeys: Object.keys(subagentProviders) };
}
function fixture(history: UiMessage[] = [], options: {
  pluginSkills?: Array<{ id: string; name: string }>;
  persist?: (message: UiMessage) => Promise<void>;
  provider?: RuntimeProviderConfig;
  subagentProviders?: Record<string, RuntimeProviderConfig>;
  subagentModelKeys?: string[];
  subagents?: SubagentDefinition[];
  thinkingLevel?: SessionThinkingLevel;
  resolveModel?: (key: string) => Promise<RuntimeProviderConfig | undefined>;
  toolOutput?: () => Promise<string>;
  onEvent?: (envelope: AgentEventEnvelope) => void;
} = {}) {
  const activeProvider = options.provider ?? provider;
  const events: AgentEventEnvelope[] = [];
  const rows = new Map(history.map((row) => [row.id, row]));
  const settled = deferred();
  const turnEnds = new Map<string, ReturnType<typeof deferred<void>>>();
  const waitForTurn = (turnId: string) => {
    let ended = turnEnds.get(turnId);
    if (!ended) { ended = deferred(); turnEnds.set(turnId, ended); }
    return ended.promise;
  };
  const hostCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const runtime = new DesktopAgentRuntime({
    sessionId: "control-fixture", mode: "agent", thinkingLevel: options.thinkingLevel ?? "off",
    provider: activeProvider, commandShell, subagents: options.subagents ?? [definition], history,
    subagentProviders: options.subagentProviders ?? { [`${activeProvider.id}/${activeProvider.modelId}`]: activeProvider },
    subagentModelKeys: options.subagentModelKeys,
    pluginSkills: options.pluginSkills,
    compactionSettings: { enabled: false, reserveTokens: 0, keepRecentTokens: 0 },
    host: { async call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
      hostCalls.push({ method, params: params ?? {} });
      if (method === "tools.fileBatchCapabilities") return { version: 1, supported: false } as T;
      if (method === "provider.resolveSubagentModel") {
        const key = String(params?.key);
        if (options.resolveModel) return await options.resolveModel(key) as T;
        return (options.subagentModelKeys?.includes(key) ? options.subagentProviders?.[key] : undefined) as T;
      }
      if (method === "session.appendMessage") { const message = params?.message as UiMessage; await options.persist?.(message); rows.set(message.id, message); }
      if (method === "tools.execute") return { ok: true, content: [{ type: "text", text: await options.toolOutput?.() ?? "Fixture output" }] } as T;
      return undefined as T;
    }, onNotification: () => () => {} },
    onEvent(envelope) {
      events.push(envelope);
      options.onEvent?.(envelope);
      const event = envelope.event;
      if (event.type === "message_end") rows.set(event.message.id, { ...event.message, parentToolCallId: envelope.parentToolCallId ?? event.message.parentToolCallId, agentName: envelope.agentName ?? event.message.agentName });
      if (event.type === "turn_end" && !envelope.parentToolCallId) {
        settled.resolve();
        if (envelope.turnId) {
          void waitForTurn(envelope.turnId);
          turnEnds.get(envelope.turnId)?.resolve();
        }
      }
    },
  });
  runtimes.push(runtime);
  return { runtime, events, rows, settled, waitForTurn, hostCalls };
}
async function control(runtime: DesktopAgentRuntime, request: AgentSubagentControlRequest, turnId = "host-turn"): Promise<AgentSubagentControlResponse> {
  expect(runtime.controlSubagent).toBeTypeOf("function");
  return runtime.controlSubagent(request, turnId);
}
const start: AgentSubagentControlRequest = { sessionId: "control-fixture", operationId: "start-1", action: "start", agent: "explorer", task: "Inspect fixture code" };
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose();
  for (const close of servers.splice(0)) await close();
  vi.unstubAllGlobals();
});

it("starts, accepts a live direction once, and keeps the child conversation out of the parent provider input", async () => {
  const requested = deferred(); const release = deferred();
  const bodies: Array<{ messages: Array<{ role: string; content?: unknown }> }> = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body)); bodies.push(body);
    if (bodies.length === 1) { requested.resolve(); await release.promise; }
    return answer(bodies.length === 1 ? "Initial report" : "Followed the direction");
  }));
  const f = fixture();
  const first = await control(f.runtime, start);
  await requested.promise;
  expect(f.hostCalls.some((call) => call.method === "session.appendMessage")).toBe(true);
  const message: AgentSubagentControlRequest = { sessionId: "control-fixture", operationId: "message-1", action: "message", delegationId: first.delegationId, content: "Only inspect tests" };
  const response = await control(f.runtime, message);
  expect(await control(f.runtime, message)).toEqual(response);
  release.resolve(); await f.settled.promise;
  expect(bodies).toHaveLength(2);
  expect(JSON.stringify(bodies[1])).toContain("Only inspect tests");
  expect([...f.rows.values()].filter((row) => row.subagentControl?.operationId === "message-1")).toHaveLength(1);
  await f.runtime.prompt("Main question", "main-user", "main-turn");
  expect(JSON.stringify(bodies.at(-1))).not.toContain("Inspect fixture code");
  expect(JSON.stringify(bodies.at(-1))).not.toContain("Only inspect tests");
  expect(f.events.filter((event) => event.event.type === "tool_start" && !event.parentToolCallId)).toHaveLength(0);
});

it("safely steers an active child at its next model request after the current tool batch", async () => {
  const toolEntered = deferred(); const releaseTool = deferred();
  const nextRequest = deferred(); const releaseNext = deferred();
  let toolFinished = false;
  const server = await loopback(async (request, index) => {
    if (index === 1) {
      const chunk = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({ id: "steering-tool", object: "chat.completion.chunk", created: 1, model: request.body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      return new Response(chunk({ role: "assistant", tool_calls: [{ index: 0, id: "read-before-direction", type: "function", function: { name: "Read", arguments: JSON.stringify({ path: "fixture.txt", offset: 0, limit: 5 }) } }] }, null) + chunk({}, "tool_calls") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    }
    if (index === 2) { nextRequest.resolve(); await releaseNext.promise; }
    return answer("Followed the revised direction", request.body.model);
  });
  const f = fixture([], { provider: server.provider("primary"), toolOutput: async () => {
    toolEntered.resolve(); await releaseTool.promise; toolFinished = true; return "Completed read result";
  } });
  const root = await control(f.runtime, start);
  try {
    const phase = await Promise.race([toolEntered.promise.then(() => "tool"), nextRequest.promise.then(() => "next-request"), f.settled.promise.then(() => "settled")]);
    expect(phase, JSON.stringify({ rows: [...f.rows.values()], hostCalls: f.hostCalls, requests: server.requests })).toBe("tool");
  } catch (error) { releaseTool.resolve(); releaseNext.resolve(); throw error; }
  const direction: AgentSubagentControlRequest = { sessionId: "control-fixture", operationId: "safe-direction-1", action: "message", delegationId: root.delegationId, content: "Stop exploring; focus only on the failing test" };
  const accepted = await control(f.runtime, direction);
  expect(accepted.delivery).toBe("queued");
  expect(await control(f.runtime, direction)).toEqual(accepted);
  await control(f.runtime, { ...direction, operationId: "safe-direction-2", content: "Do not modify any source files" });
  expect(toolFinished).toBe(false);
  expect(server.requests).toHaveLength(1);
  try {
    releaseTool.resolve(); await nextRequest.promise;
    expect(toolFinished).toBe(true);
    expect(userMessages(server.requests[1])).toEqual([start.task, direction.content, "Do not modify any source files"]);
    expect(JSON.stringify(server.requests[1].body.messages)).toContain("Completed read result");
  } finally { releaseTool.resolve(); releaseNext.resolve(); }
  await f.settled.promise;
  expect(server.requests).toHaveLength(2);
  expect([...f.rows.values()].filter(row => row.subagentControl?.operationId === direction.operationId)).toHaveLength(1);
  expect(f.rows.get(root.messageId)?.subagentControl?.status).toBe("completed");
  await f.runtime.prompt("Unrelated parent prompt", "parent-after-steering", "parent-after-steering-turn");
  expect(JSON.stringify(server.requests.at(-1)?.body.messages)).not.toContain(direction.content);
});

it.each(["commit", "reject", "stop"] as const)("keeps safe steering behind persistence at the tool boundary: %s", async outcome => {
  const toolEntered = deferred(); const releaseTool = deferred(); const toolEnded = deferred();
  const writeEntered = deferred(); const releaseWrite = deferred();
  let committed = false;
  const server = await loopback(async (request, index) => {
    if (index !== 1) return answer("Finished after the safe boundary", request.body.model);
    const chunk = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({ id: "persist-tool", object: "chat.completion.chunk", created: 1, model: request.body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    return new Response(chunk({ role: "assistant", tool_calls: [{ index: 0, id: "persist-read", type: "function", function: { name: "Read", arguments: JSON.stringify({ path: "fixture.txt" }) } }] }, null) + chunk({}, "tool_calls") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  });
  const f = fixture([], { provider: server.provider("primary"),
    toolOutput: async () => { toolEntered.resolve(); await releaseTool.promise; return "Tool completed without cancellation"; },
    persist: async message => {
      if (message.subagentControl?.operationId !== "persist-direction") return;
      writeEntered.resolve(); await releaseWrite.promise;
      if (outcome === "reject") throw new Error("Fixture direction persistence failed");
      committed = true;
    },
    onEvent: envelope => { if (envelope.event.type === "tool_end") toolEnded.resolve(); },
  });
  const root = await control(f.runtime, start); await toolEntered.promise;
  const direction = "Only use the saved instruction";
  const acceptance = control(f.runtime, { sessionId: "control-fixture", operationId: "persist-direction", action: "message", delegationId: root.delegationId, content: direction }).then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
  try {
    await writeEntered.promise; releaseTool.resolve(); await toolEnded.promise;
    expect(committed).toBe(false); expect(server.requests).toHaveLength(1);
    const stopped = outcome === "stop" ? f.runtime.stopSubagents([root.delegationId]) : undefined;
    releaseWrite.resolve(); const result = await acceptance; await stopped; await f.settled.promise;
    if (outcome === "commit") {
      expect(result.value?.delivery).toBe("queued"); expect(server.requests).toHaveLength(2);
      expect(userMessages(server.requests[1])).toEqual([start.task, direction]);
    } else {
      expect(result.error).toBeInstanceOf(Error);
      expect(server.requests).toHaveLength(outcome === "stop" ? 1 : 2);
      expect(server.requests.every(request => !userMessages(request).includes(direction))).toBe(true);
    }
  } finally { releaseTool.resolve(); releaseWrite.resolve(); }
});

it("does not execute an unpersisted task, and rejects a reused operation id with different content", async () => {
  const fetch = vi.fn(async () => answer("report")); vi.stubGlobal("fetch", fetch);
  const f = fixture();
  const saved = await control(f.runtime, start); await f.settled.promise;
  await expect(control(f.runtime, { ...start, task: "Different objective" }, "another-turn")).rejects.toThrow(/operation/i);
  expect(await control(f.runtime, start, "another-turn")).toMatchObject({ delegationId: saved.delegationId });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("restores a user-created chain after a fresh runtime and continues its own model binding", async () => {
  const bodies: unknown[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return answer("Recorded result"); }));
  const first = fixture(); const response = await control(first.runtime, start); await first.settled.promise;
  const restored = fixture([...first.rows.values()]);
  const resumed = await control(restored.runtime, { sessionId: "control-fixture", operationId: "resume-1", action: "message", delegationId: response.delegationId, content: "Continue with the tests" }, "resumed-turn");
  expect(resumed.delegationId).not.toBe(response.delegationId);
  await restored.settled.promise;
  expect(JSON.stringify(bodies.at(-1))).toContain("Recorded result");
  expect(JSON.stringify(bodies.at(-1))).toContain("Continue with the tests");
  expect([...restored.rows.values()].filter((row) => row.subagentControl?.action === "start")).toHaveLength(2);
});

it.each(["wrapped", "direct", "namespaced", "call-id-link", "report", "key-only", "out-of-order"] as const)("continues a completed legacy Task after restart with its recorded account and history: %s", async format => {
  const server = await loopback();
  const parent = server.provider("parent");
  const recorded = server.provider("recorded", "deepseek-fixture");
  const stamp = (second: number) => new Date(Date.UTC(2026, 10, 3, 0, 0, second)).toISOString();
  const details = { delegationId: "legacy-id", status: "completed",
    ...(format === "key-only" ? { modelKey: `${recorded.id}/${recorded.modelId}` } : {}) };
  const history: UiMessage[] = [{
    id: "legacy-task", role: "tool", content: "", createdAt: stamp(0),
    toolName: format === "namespaced" ? "functions.Task" : "Task", toolCallId: "legacy-call",
    toolArgs: { agent: "explorer", task: "Original bounded fixture brief" }, toolStatus: "success",
    toolResult: format === "report" ? { ...details, content: [{ type: "text", text: "Saved child finding" }] }
      : format === "direct" ? details : { details },
  }, {
    id: "legacy-reply", role: "assistant", content: "Saved child finding", createdAt: stamp(1),
    parentToolCallId: "legacy-call", agentName: "explorer", status: "complete",
    ...(format === "key-only" ? {} : { providerId: recorded.id, modelId: recorded.modelId }),
  }];
  const hasContinuation = format === "call-id-link" || format === "out-of-order";
  if (hasContinuation) history.push({
    id: "legacy-followup", role: "tool", content: "", createdAt: stamp(2),
    toolName: "Task", toolCallId: "followup-call", toolStatus: "success",
    toolArgs: { agent: "explorer", task: "Earlier continuation", resume: "legacy-call" },
    toolResult: { details: { delegationId: "followup-id", status: "completed",
      modelId: recorded.modelId, modelKey: `${recorded.id}/${recorded.modelId}` } },
  }, {
    id: "followup-reply", role: "assistant", content: "Saved continuation finding", createdAt: stamp(3),
    parentToolCallId: "followup-call", agentName: "explorer", status: "complete",
    providerId: recorded.id, modelId: recorded.modelId,
  });
  if (format === "out-of-order") history.reverse();
  const before = JSON.stringify(history);
  const f = fixture(history, { provider: parent, ...modelCatalog(recorded) });
  const selected = hasContinuation ? "followup-id" : "legacy-id";
  const resumed = await control(f.runtime, { sessionId: "control-fixture", operationId: `legacy-${format}`,
    action: "message", delegationId: selected, content: "Continue from the saved finding" }, "legacy-resume-turn");
  await f.waitForTurn("legacy-resume-turn");
  expect(resumed.delivery).toBe("started");
  expect(resumed.delegationId).not.toBe(selected);
  expect(server.requests).toHaveLength(1);
  expect(server.requests[0].account).toBe(recorded.id);
  expect(server.requests[0].body.model).toBe(recorded.modelId);
  expect(userMessages(server.requests[0])[0]).toBe("Original bounded fixture brief");
  expect(userMessages(server.requests[0]).at(-1)).toBe("Continue from the saved finding");
  expect(JSON.stringify(server.requests[0].body.messages)).toContain("Saved child finding");
  if (hasContinuation) expect(JSON.stringify(server.requests[0].body.messages)).toContain("Saved continuation finding");
  expect(f.rows.get(resumed.messageId)?.subagentControl).toMatchObject({
    resume: selected, status: "completed", modelId: recorded.modelId, modelKey: `${recorded.id}/${recorded.modelId}`,
  });
  expect(JSON.stringify(history)).toBe(before);
});

it("continues a user-selected interrupted chain after restart and releases the main conversation", async () => {
  const requested = deferred();
  const bodies: Array<{ model: string; messages: unknown[] }> = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    if (bodies.length !== 2) return answer(bodies.length === 1 ? "Saved child checkpoint" : "Recovered child result");
    requested.resolve();
    return new Promise<Response>((_resolve, reject) => {
      const abort = () => reject(new DOMException("Fixture process ended", "AbortError"));
      if (init.signal?.aborted) abort();
      else init.signal?.addEventListener("abort", abort, { once: true });
    });
  }));
  const first = fixture();
  const original = await control(first.runtime, start);
  await first.settled.promise;
  const inFlight = await control(first.runtime, {
    sessionId: "control-fixture", operationId: "before-exit", action: "message",
    delegationId: original.delegationId, content: "Finish the remaining child work",
  }, "before-exit-turn");
  await requested.promise;
  // A crash leaves the durable snapshot running; cleanup of the old fixture
  // must not rewrite the snapshot used to launch the replacement runtime.
  const saved = structuredClone([...first.rows.values()]);
  expect(saved.find(row => row.id === inFlight.messageId)?.subagentControl?.status).toBe("running");
  await first.runtime.dispose();
  const restored = fixture(saved);
  expect(restored.runtime.getStatus().isRunning).toBe(false);
  expect(bodies).toHaveLength(2);
  const resumed = await control(restored.runtime, {
    sessionId: "control-fixture", operationId: "after-exit", action: "message",
    delegationId: original.delegationId, content: "Continue from the saved child checkpoint",
  }, "after-exit-turn");
  await restored.waitForTurn("after-exit-turn");
  expect(resumed.delivery).toBe("started");
  expect(resumed.delegationId).not.toBe(inFlight.delegationId);
  expect(bodies).toHaveLength(3);
  expect(bodies[2].model).toBe(provider.modelId);
  expect(JSON.stringify(bodies[2].messages)).toContain("Saved child checkpoint");
  expect(JSON.stringify(bodies[2].messages)).toContain("Continue from the saved child checkpoint");
  expect(restored.rows.get(resumed.messageId)?.subagentControl).toMatchObject({
    resume: inFlight.delegationId, status: "completed",
  });
  expect(restored.runtime.getStatus().isRunning).toBe(false);
  await restored.runtime.prompt("A new parent question", "parent-after-restart", "parent-after-restart-turn");
  expect(bodies).toHaveLength(4);
  expect(JSON.stringify(bodies[3].messages)).not.toContain("Continue from the saved child checkpoint");
  expect(restored.runtime.getStatus().isRunning).toBe(false);
});

it("does not start the provider when committing the user task fails, and a retry can use the same operation id", async () => {
  const fetch = vi.fn(async () => answer("report")); vi.stubGlobal("fetch", fetch);
  let fails = true;
  const f = fixture([], { persist: async () => { if (fails) throw new Error("Fixture write failed"); } });
  await expect(control(f.runtime, start)).rejects.toThrow("Fixture write failed");
  expect(fetch).not.toHaveBeenCalled();
  expect(f.runtime.getStatus().isRunning).toBe(false);
  fails = false;
  await control(f.runtime, start, "retry-turn");
  await f.waitForTurn("retry-turn");
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("stops a live child and explicitly continues the stopped chain without changing its model", async () => {
  const requested = deferred(); let calls = 0;
  const bodies: Array<{ model: string; messages: unknown[] }> = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    calls += 1;
    if (calls > 1) return answer("Continued after stop");
    requested.resolve();
    return new Promise<Response>((_resolve, reject) => {
      const signal = init.signal;
      const abort = () => reject(new DOMException("Fixture stopped", "AbortError"));
      if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
    });
  }));
  const f = fixture(); const response = await control(f.runtime, start); await requested.promise;
  await f.runtime.stopSubagents([response.delegationId]);
  await f.settled.promise;
  expect(f.events.filter(event => !event.parentToolCallId && event.event.type === "agent_end")).toHaveLength(1);
  expect([...f.rows.values()].find(row => row.subagentControl?.action === "start")?.subagentControl?.status).toBe("stopped");
  const continued = await control(f.runtime, { sessionId: "control-fixture", operationId: "after-stop", action: "message", delegationId: response.delegationId, content: "Continue now" }, "continued-turn");
  expect(continued.delivery).toBe("started");
  await f.waitForTurn("continued-turn");
  expect(calls).toBe(2);
  expect(bodies[1].model).toBe(provider.modelId);
  expect(JSON.stringify(bodies[1].messages)).toContain("Continue now");
});

it.each([false, true])("continues the selected model despite an unavailable definition pin (restart=%s)", async (restart) => {
  const requested = deferred();
  const bodies: Array<{ model: string; messages: unknown[] }> = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    if (bodies.length > 1) return answer("Continued on the selected model");
    requested.resolve();
    return new Promise<Response>((_resolve, reject) => {
      const abort = () => reject(new DOMException("Fixture stopped", "AbortError"));
      if (init.signal?.aborted) abort();
      else init.signal?.addEventListener("abort", abort, { once: true });
    });
  }));
  const options = {
    ...modelCatalog(provider),
    subagents: [{ ...definition, model: { providerId: "unconfigured", modelId: "missing-model" } }],
  };
  const first = fixture([], options);
  const started = await control(first.runtime, { ...start, model: "fixture/fixture-model" });
  await requested.promise;
  await first.runtime.stopSubagents([started.delegationId]);
  await first.settled.promise;
  const target = restart ? fixture([...first.rows.values()], options) : first;
  if (restart) await first.runtime.dispose();
  const resumed = await control(target.runtime, {
    sessionId: "control-fixture", operationId: "continue-selected", action: "message",
    delegationId: started.delegationId, content: "Continue with the original selected model",
  }, "continued-selected-turn");
  expect(resumed.delivery).toBe("started");
  await target.waitForTurn("continued-selected-turn");
  expect(bodies).toHaveLength(2);
  expect(bodies[1].model).toBe("fixture-model");
  expect(JSON.stringify(bodies[1].messages)).toContain("Continue with the original selected model");
  expect([...target.rows.values()].some(row => row.role === "assistant" && row.content === "Continued on the selected model")).toBe(true);
});

it.each(["running", "authorizing"] as const)("keeps the parent turn until its user child is settled while %s", async boundary => {
  const parentRequested = deferred(); const releaseParent = deferred();
  const childRequested = deferred(); const releaseChild = deferred();
  const authorizing = deferred(); const releaseAuthorization = deferred();
  const child = { ...provider, id: "child", modelId: "child-model" };
  const bodies: Array<{ model: string; messages: unknown[] }> = [];
  const f = fixture([], {
    subagents: [{ ...definition, model: { providerId: child.id, modelId: child.modelId } }],
    subagentProviders: { "child/child-model": child },
    resolveModel: async () => { authorizing.resolve(); await releaseAuthorization.promise; return child; },
  });
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body)); bodies.push(body);
    if (body.model === provider.modelId) { parentRequested.resolve(); await releaseParent.promise; return answer("Parent completed"); }
    childRequested.resolve(); await releaseChild.promise; return answer("User child completed", child.modelId);
  }));
  const parentRun = f.runtime.prompt("Parent task", "parent-user", "parent-turn");
  await parentRequested.promise;
  const command = control(f.runtime, { ...start, operationId: "child-during-parent",
    ...(boundary === "authorizing" ? { model: "selected/child-model" } : {}) }, "parent-turn");
  try {
    await (boundary === "authorizing" ? authorizing.promise : childRequested.promise);
    releaseParent.resolve();
    await vi.waitFor(() => expect([...f.rows.values()].some(row => row.content === "Parent completed")).toBe(true));
    const parentEnds = () => f.events.filter(event => !event.parentToolCallId && event.turnId === "parent-turn" && event.event.type === "agent_end");
    expect(parentEnds()).toHaveLength(0);
    expect(f.runtime.getStatus().isRunning).toBe(true);
    releaseAuthorization.resolve();
    const accepted = await command;
    await childRequested.promise;
    releaseChild.resolve();
    await parentRun;
    await vi.waitFor(() => expect(f.rows.get(accepted.messageId)?.subagentControl?.status).toBe("completed"));
    expect(parentEnds()).toHaveLength(1);
    expect(f.runtime.getStatus().isRunning).toBe(false);
    expect(bodies.map(body => body.model)).toEqual([provider.modelId, child.modelId]);
    const childEnd = f.events.findIndex(event => event.event.type === "message_end" && event.event.message.subagentControl?.status === "completed");
    expect(f.events.indexOf(parentEnds()[0])).toBeGreaterThan(childEnd);
  } finally {
    releaseParent.resolve(); releaseAuthorization.resolve(); releaseChild.resolve();
    await Promise.allSettled([command, parentRun]);
  }
});

it.each(["live", "restored"] as const)("continues a stopped child outside the bounded model resume list in a %s runtime", async phase => {
  const requested = deferred();
  const bodies: Array<{ model: string; messages: unknown[] }> = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    if (bodies.length > 1) return answer("Continued the selected child");
    requested.resolve();
    return new Promise<Response>((_resolve, reject) => {
      const abort = () => reject(new DOMException("Fixture stopped", "AbortError"));
      if (init.signal?.aborted) abort(); else init.signal?.addEventListener("abort", abort, { once: true });
    });
  }));
  const first = fixture();
  const stopped = await control(first.runtime, start, "old-turn");
  await requested.promise;
  await first.runtime.stopSubagents([stopped.delegationId]);
  await first.waitForTurn("old-turn");
  for (let index = 0; index < 2; index += 1) {
    const turnId = `newer-turn-${index}`;
    await control(first.runtime, { ...start, operationId: `newer-${index}`, task: `Unrelated child ${index}` }, turnId);
    await first.waitForTurn(turnId);
  }
  const target = phase === "restored" ? fixture([...first.rows.values()]) : first;
  const resumed = await control(target.runtime, { sessionId: "control-fixture", operationId: "resume-old-stopped", action: "message",
    delegationId: stopped.delegationId, content: "Continue the old stopped task" }, "resume-old-turn");
  expect(resumed.delivery).toBe("started");
  expect(resumed.delegationId).not.toBe(stopped.delegationId);
  await target.waitForTurn("resume-old-turn");
  expect(bodies).toHaveLength(4);
  expect(JSON.stringify(bodies.at(-1)?.messages)).toContain(start.task);
  expect(JSON.stringify(bodies.at(-1)?.messages)).toContain("Continue the old stopped task");
  expect(JSON.stringify(bodies.at(-1)?.messages)).not.toContain("Unrelated child");
  expect(target.rows.get(resumed.messageId)?.subagentControl).toMatchObject({ resume: stopped.delegationId, status: "completed" });
});

it("rejects a delegation absent from this session without starting a provider", async () => {
  const fetch = vi.fn(async () => answer("Must not run")); vi.stubGlobal("fetch", fetch);
  const f = fixture();
  await expect(control(f.runtime, { sessionId: "control-fixture", operationId: "foreign", action: "message",
    delegationId: "another-session-delegation", content: "Do not cross sessions" })).rejects.toThrow("Subagent does not belong to this session");
  expect(fetch).not.toHaveBeenCalled();
  expect(f.rows.size).toBe(0);
  expect(f.runtime.getStatus().isRunning).toBe(false);
});

it("cancels a deferred parent turn without waiting for child model authorization", async () => {
  const parentRequested = deferred(); const releaseParent = deferred();
  const authorizing = deferred(); const releaseAuthorization = deferred();
  const f = fixture([], { resolveModel: async () => { authorizing.resolve(); await releaseAuthorization.promise; return provider; } });
  const fetch = vi.fn(async () => { parentRequested.resolve(); await releaseParent.promise; return answer("Parent completed"); });
  vi.stubGlobal("fetch", fetch);
  const parentRun = f.runtime.prompt("Parent task", "parent-user", "parent-turn");
  await parentRequested.promise;
  const command = control(f.runtime, { ...start, model: "selected/fixture-model" }, "parent-turn");
  const rejected = expect(command).rejects.toThrow(/cancel|ended|changed/i);
  try {
    await authorizing.promise;
    releaseParent.resolve(); await parentRun;
    await f.runtime.abort();
    expect(f.runtime.getStatus().isRunning).toBe(false);
  } finally {
    releaseParent.resolve(); releaseAuthorization.resolve();
    await Promise.all([rejected, parentRun]);
  }
  expect(fetch).toHaveBeenCalledTimes(1);
  expect([...f.rows.values()].some(row => row.subagentControl)).toBe(false);
});

it("loads an authorized Skill through the real child tool and preserves its host permission scope", async () => {
  const bodies: Array<{ tools?: Array<{ function?: { name?: string } }>; messages: unknown[] }> = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    if (bodies.length > 1) return answer("Used the fixture skill");
    const chunk = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({ id: "skill-fixture", object: "chat.completion.chunk", created: 1, model: "fixture-model", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    return new Response(chunk({ role: "assistant", tool_calls: [{ index: 0, id: "skill-call", type: "function", function: { name: "Skill", arguments: JSON.stringify({ id: "fixture/guide" }) } }] }, null) + chunk({}, "tool_calls") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  }));
  const f = fixture([], { pluginSkills: [{ id: "fixture/guide", name: "Fixture guide" }] });
  await control(f.runtime, start); await f.settled.promise;
  const names = bodies[0].tools?.map(tool => tool.function?.name) ?? [];
  expect(names).toContain("Skill"); expect(names).not.toContain("Task"); expect(names).not.toContain("ToolSearch");
  expect(JSON.stringify(bodies[0])).toContain("fixture/guide");
  const call = f.hostCalls.find(call => call.method === "tools.execute" && call.params.toolName === "Skill");
  expect(call).toBeDefined();
  expect(call?.params).toMatchObject({ sessionId: "control-fixture", turnId: "host-turn", toolName: "Skill" });
  expect(JSON.stringify(bodies[1])).toContain("Fixture output");
});

it("does not advertise Skill when this session has no authorized skill catalog", async () => {
  const bodies: unknown[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return answer("No skill needed"); }));
  const f = fixture(); await control(f.runtime, start); await f.settled.promise;
  expect(JSON.stringify(bodies[0])).not.toContain("fixture/guide");
  expect(JSON.stringify(bodies[0])).not.toContain('"name":"Skill"');
  expect(f.hostCalls.filter(call => call.method === "tools.execute" && call.params.toolName === "Skill")).toHaveLength(0);
});

it("applies an exact model to the next ordered user turn without touching the blocked request or parent", async () => {
  const requested = deferred(); const release = deferred();
  const server = await loopback(async (request, index) => {
    if (index === 1) { requested.resolve(); await release.promise; }
    return answer(index === 1 ? "Initial retained report" : "Followed the direction", request.body.model);
  });
  const primary = server.provider("primary");
  const selectedBase = server.provider("selected");
  const selected: RuntimeProviderConfig = { ...selectedBase, supportsReasoning: true, supportedThinkingLevels: ["off", "low"],
    modelConfig: { ...genericModelConfig(selectedBase.modelId, selectedBase.baseUrl!), reasoning: true, supportedThinkingLevels: ["off", "low"], supportsReasoningEffort: true } };
  const f = fixture([], { provider: primary, thinkingLevel: "high", subagents: [{ ...definition, thinkingLevel: "high" }], ...modelCatalog(primary, selected) });
  const first = await control(f.runtime, start); await requested.promise;
  const direction: AgentSubagentControlRequest = { sessionId: "control-fixture", operationId: "switch-1", action: "message",
    delegationId: first.delegationId, content: "Only inspect tests with the selected model", model: "selected/selected-model" };
  const [queued, retried] = await Promise.all([control(f.runtime, direction), control(f.runtime, direction)]);
  expect(queued.delivery).toBe("queued"); expect(retried).toEqual(queued);
  await expect(control(f.runtime, { ...direction, model: "primary/primary-model" })).rejects.toThrow(/operation/i);
  await control(f.runtime, { sessionId: "control-fixture", operationId: "plain-1", action: "message", delegationId: first.delegationId, content: "Then summarize the tests" });
  expect(server.requests).toHaveLength(1);
  expect(server.requests[0]).toMatchObject({ path: "/primary/v1/chat/completions", authorization: "Bearer fixture-primary", account: "primary", body: { model: "primary-model" } });
  release.resolve(); await f.settled.promise;
  expect(server.requests.map(request => request.body.model)).toEqual(["primary-model", "selected-model", "selected-model"]);
  for (const request of server.requests.slice(1)) {
    expect(request).toMatchObject({ path: "/selected/v1/chat/completions", authorization: "Bearer fixture-selected", account: "selected", body: { reasoning_effort: "low" } });
    expect(JSON.stringify(request.body.messages)).toContain("Initial retained report");
    expect(userMessages(request).filter(content => content.includes(start.task))).toHaveLength(1);
  }
  expect(userMessages(server.requests[2])).toEqual([
    start.task, direction.content, "Then summarize the tests",
  ]);
  expect([...f.rows.values()].filter(row => row.subagentControl?.operationId === direction.operationId)).toHaveLength(1);
  expect(f.rows.get(queued.messageId)?.subagentControl).toMatchObject({ modelId: selected.modelId, modelKey: "selected/selected-model" });
  expect(f.rows.get(first.messageId)?.subagentControl).toMatchObject({ status: "completed", modelId: selected.modelId, modelKey: "selected/selected-model", thinkingLevel: "low" });
  await f.runtime.prompt("Main question", "parent-user", "parent-turn");
  expect(server.requests.at(-1)).toMatchObject({ path: "/primary/v1/chat/completions", authorization: "Bearer fixture-primary", account: "primary", body: { model: primary.modelId } });
  expect(JSON.stringify(server.requests.at(-1)?.body.messages)).not.toContain(direction.content);
});

it("continues a settled chain with a user override and restores its exact account binding", async () => {
  const server = await loopback();
  const primary = server.provider("primary");
  const selected = server.provider("selected", primary.modelId);
  const first = fixture([], { provider: primary, ...modelCatalog(primary, selected) });
  const root = await control(first.runtime, start); await first.settled.promise;
  const request: AgentSubagentControlRequest = { sessionId: "control-fixture", operationId: "switch-resume", action: "message",
    delegationId: root.delegationId, content: "Continue using the other account", model: `selected/${primary.modelId}` };
  const continued = await control(first.runtime, request, "resume-turn");
  expect(continued.delivery).toBe("started"); expect(continued.delegationId).not.toBe(root.delegationId);
  await first.waitForTurn("resume-turn");
  expect(server.requests[1]).toMatchObject({ path: "/selected/v1/chat/completions", authorization: "Bearer fixture-selected", account: "selected", body: { model: primary.modelId } });
  expect(JSON.stringify(server.requests[1].body.messages)).toContain("Recorded result");
  expect(userMessages(server.requests[1])).toEqual([start.task, request.content]);
  expect(first.rows.get(continued.messageId)?.subagentControl).toMatchObject({ modelKey: `selected/${primary.modelId}`, resume: root.delegationId });
  const restored = fixture([...first.rows.values()], { provider: primary, ...modelCatalog(primary, selected) });
  expect(await control(restored.runtime, request, "restore-turn")).toMatchObject({ delivery: "recorded", delegationId: continued.delegationId });
  expect(server.requests).toHaveLength(2);
  await control(restored.runtime, { sessionId: "control-fixture", operationId: "restored-next", action: "message", delegationId: root.delegationId, content: "Retain the selected account after restart" }, "restored-turn");
  await restored.waitForTurn("restored-turn");
  expect(server.requests[2]).toMatchObject({ path: "/selected/v1/chat/completions", authorization: "Bearer fixture-selected", account: "selected" });
  expect(userMessages(server.requests[2]).filter(content => content.includes(request.content))).toHaveLength(1);
});

it.each(["running", "settled"] as const)("rejects unavailable and unauthorized model choices before recording or queueing on a %s child", async phase => {
  const requested = deferred(); const release = deferred();
  const server = await loopback(async (request, index) => {
    if (index === 1 && phase === "running") { requested.resolve(); await release.promise; }
    return answer("Recorded result", request.body.model);
  });
  const primary = server.provider("primary"); const restricted = server.provider("restricted");
  const f = fixture([], { provider: primary, subagentProviders: { "restricted/restricted-model": restricted }, subagentModelKeys: [],
    resolveModel: async key => { if (key.startsWith("restricted/")) throw new Error("Fixture authorization denied"); return undefined; } });
  const root = await control(f.runtime, start);
  if (phase === "running") await requested.promise; else await f.settled.promise;
  for (const model of ["missing/model", "restricted/restricted-model"]) {
    const operationId = `reject-${model.split("/")[0]}`;
    const request: AgentSubagentControlRequest = { sessionId: "control-fixture", operationId, action: "message", delegationId: root.delegationId, content: "Must not be delivered", model };
    await expect(control(f.runtime, request, phase === "running" ? "host-turn" : "rejected-turn")).rejects.toThrow(/not available for delegation/i);
    expect(f.hostCalls.some(call => call.method === "provider.resolveSubagentModel" && call.params.key === model)).toBe(true);
    expect([...f.rows.values()].some(row => row.subagentControl?.operationId === operationId)).toBe(false);
    expect(f.hostCalls.some(call => call.method === "session.appendMessage" && (call.params.message as UiMessage)?.subagentControl?.operationId === operationId)).toBe(false);
  }
  release.resolve(); if (phase === "running") await f.settled.promise;
  expect(server.requests).toHaveLength(1);
});

it("finishes the old provider's retry and fallback before applying a queued user model", async () => {
  const requested = deferred(); const releasePrimary = deferred();
  const fallbackRequested = deferred(); const releaseFallback = deferred();
  const server = await loopback(async (request, index) => {
    if (index === 1) { requested.resolve(); await releasePrimary.promise; }
    if (index <= 2) return new Response(JSON.stringify({ error: { message: "Fixture provider failure" } }), {
      status: index === 1 ? 502 : 401, headers: { "content-type": "application/json", "retry-after": "0" },
    });
    if (index === 3) { fallbackRequested.resolve(); await releaseFallback.promise; }
    return answer(index === 3 ? "Retained fallback report" : "Selected follow-up", request.body.model);
  });
  const primary = server.provider("primary"); const fallback = server.provider("fallback"); const selected = server.provider("selected");
  const f = fixture([], { provider: primary, ...modelCatalog(primary, fallback, selected),
    subagents: [{ ...definition, fallbackModels: [{ providerId: fallback.id, modelId: fallback.modelId }] }] });
  const root = await control(f.runtime, start); await requested.promise;
  const queued = await control(f.runtime, { sessionId: "control-fixture", operationId: "after-fallback", action: "message",
    delegationId: root.delegationId, content: "Use the selected model after recovery", model: "selected/selected-model" });
  expect(queued.delivery).toBe("queued");
  releasePrimary.resolve(); await fallbackRequested.promise;
  expect(server.requests.map(request => request.account)).toEqual(["primary", "primary", "fallback"]);
  expect(server.requests.map(request => request.authorization)).toEqual(["Bearer fixture-primary", "Bearer fixture-primary", "Bearer fixture-fallback"]);
  expect(JSON.stringify(server.requests[2].body.messages)).not.toContain("after recovery");
  releaseFallback.resolve(); await f.settled.promise;
  expect(server.requests.map(request => request.account)).toEqual(["primary", "primary", "fallback", "selected"]);
  expect(JSON.stringify(server.requests[3].body.messages)).toContain("Retained fallback report");
  expect(f.rows.get(root.messageId)?.subagentControl).toMatchObject({ status: "completed", modelKey: "selected/selected-model" });
});

it.each(["authorization", "persistence"] as const)("delivers a model-directed message once when the child finishes during %s", async boundary => {
  const requested = deferred(); const releaseRequest = deferred(); const entered = deferred(); const release = deferred();
  const oldReport = deferred(); const oldSettlement = deferred();
  const server = await loopback(async (request, index) => {
    if (index === 1) { requested.resolve(); await releaseRequest.promise; }
    return answer(index === 1 ? "Initial retained report" : "Continued result", request.body.model);
  });
  const primary = server.provider("primary"); const selected = server.provider("selected");
  const f = fixture([], { provider: primary,
    ...(boundary === "persistence" ? modelCatalog(primary, selected) : {}),
    resolveModel: async () => { entered.resolve(); await release.promise; return selected; },
    persist: async message => { if (boundary === "persistence" && message.subagentControl?.operationId === "finish-race") { entered.resolve(); await release.promise; } },
    onEvent: ({ event }) => {
      if (event.type !== "message_end") return;
      if (event.message.role === "assistant" && event.message.content === "Initial retained report") oldReport.resolve();
      if (event.message.subagentControl?.operationId === start.operationId && event.message.subagentControl.status === "completed") oldSettlement.resolve();
    },
  });
  const root = await control(f.runtime, start); await requested.promise;
  const request: AgentSubagentControlRequest = { sessionId: "control-fixture", operationId: "finish-race", action: "message",
    delegationId: root.delegationId, content: "Continue exactly once", model: "selected/selected-model" };
  const pending = control(f.runtime, request); await entered.promise;
  releaseRequest.resolve(); await (boundary === "authorization" ? oldSettlement.promise : oldReport.promise);
  expect(server.requests).toHaveLength(1);
  release.resolve(); const accepted = await pending; await f.settled.promise;
  expect(accepted.delivery).toBe(boundary === "authorization" ? "started" : "queued");
  expect(server.requests).toHaveLength(2);
  expect(server.requests[1].account).toBe("selected");
  expect(userMessages(server.requests[1])).toEqual([start.task, request.content]);
  expect([...f.rows.values()].filter(row => row.subagentControl?.operationId === request.operationId)).toHaveLength(1);
  expect(await control(f.runtime, request)).toEqual(accepted);
});

it.each(["authorization", "persistence"] as const)("does not acknowledge or revive a child stopped during message %s", async boundary => {
  const requested = deferred(); const entered = deferred(); const release = deferred(); const stoppedEvent = deferred();
  const server = await loopback(async (request, index) => {
    if (index === 1) { requested.resolve(); await release.promise; }
    return answer("Must not revive this child", request.body.model);
  });
  const primary = server.provider("primary"); const selected = server.provider("selected");
  const f = fixture([], { provider: primary,
    ...(boundary === "persistence" ? modelCatalog(primary, selected) : {}),
    resolveModel: async () => { entered.resolve(); await release.promise; return selected; },
    persist: async message => { if (boundary === "persistence" && message.subagentControl?.operationId === "stop-race") { entered.resolve(); await release.promise; } },
    onEvent: ({ event }) => {
      if (event.type === "message_end" && event.message.subagentControl?.operationId === start.operationId && event.message.subagentControl.status === "stopped") stoppedEvent.resolve();
    },
  });
  const root = await control(f.runtime, start); await requested.promise;
  const pending = control(f.runtime, { sessionId: "control-fixture", operationId: "stop-race", action: "message",
    delegationId: root.delegationId, content: "Do not deliver after Stop", model: "selected/selected-model" });
  const rejected = expect(pending).rejects.toThrow(/stop|changed|cancel/i);
  await entered.promise;
  const stopping = f.runtime.stopSubagents([root.delegationId]);
  if (boundary === "authorization") await stoppedEvent.promise;
  release.resolve(); await rejected; await stopping; await f.settled.promise;
  expect(server.requests).toHaveLength(1);
  expect(f.rows.get(root.messageId)?.subagentControl).toMatchObject({ status: "stopped", modelId: primary.modelId });
  if (boundary === "authorization") expect(f.hostCalls.some(call => call.method === "session.appendMessage" && (call.params.message as UiMessage)?.subagentControl?.operationId === "stop-race")).toBe(false);
});

it("does not strand an acknowledged user message when the current provider exhausts recovery", async () => {
  const requested = deferred(); const release = deferred();
  const server = await loopback(async (request, index) => {
    if (index === 1) {
      requested.resolve(); await release.promise;
      return new Response(JSON.stringify({ error: { message: "Fixture credentials rejected" } }), { status: 401, headers: { "content-type": "application/json" } });
    }
    return answer("Recovered on the user-selected model", request.body.model);
  });
  const primary = server.provider("primary"); const selected = server.provider("selected");
  const f = fixture([], { provider: primary, ...modelCatalog(primary, selected) });
  const root = await control(f.runtime, start); await requested.promise;
  const queued = await control(f.runtime, { sessionId: "control-fixture", operationId: "after-exhaustion", action: "message",
    delegationId: root.delegationId, content: "Recover with this next user turn", model: "selected/selected-model" });
  expect(queued.delivery).toBe("queued"); release.resolve(); await f.settled.promise;
  expect(server.requests.map(request => request.account)).toEqual(["primary", "selected"]);
  expect(userMessages(server.requests[1])).toEqual([start.task, "Recover with this next user turn"]);
  expect(f.rows.get(root.messageId)?.subagentControl).toMatchObject({ status: "completed", modelKey: "selected/selected-model" });
});

it("keeps the old model through an in-flight tool round before applying the user choice", async () => {
  const toolEntered = deferred(); const releaseTool = deferred();
  const server = await loopback(async (request, index) => {
    if (index !== 1) return answer(index === 2 ? "Completed the original tool round" : "Follow-up result", request.body.model);
    const chunk = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({ id: "read-fixture", object: "chat.completion.chunk", created: 1, model: request.body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    return new Response(chunk({ role: "assistant", tool_calls: [{ index: 0, id: "read-fixture", type: "function", function: { name: "Read", arguments: JSON.stringify({ path: "fixture.txt" }) } }] }, null) + chunk({}, "tool_calls") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  });
  const primary = server.provider("primary"); const selected = server.provider("selected");
  const f = fixture([], { provider: primary, ...modelCatalog(primary, selected),
    subagents: [{ ...definition, model: { providerId: primary.id, modelId: primary.modelId }, thinkingLevel: "omit" }],
    toolOutput: async () => { toolEntered.resolve(); await releaseTool.promise; return "Read fixture once"; } });
  const root = await control(f.runtime, start); await toolEntered.promise;
  const next = await control(f.runtime, { sessionId: "control-fixture", operationId: "after-tool", action: "message",
    delegationId: root.delegationId, content: "Continue with the selected model", model: "selected/selected-model" });
  expect(next.delivery).toBe("queued"); expect(server.requests).toHaveLength(1);
  await control(f.runtime, { sessionId: "control-fixture", operationId: "after-model-choice", action: "message",
    delegationId: root.delegationId, content: "Then inspect the test results" });
  releaseTool.resolve(); await f.settled.promise;
  expect(server.requests.map(request => request.account)).toEqual(["primary", "primary", "selected", "selected"]);
  expect(userMessages(server.requests[1])).toEqual([start.task]);
  expect(JSON.stringify(server.requests[2].body.messages)).toContain("Completed the original tool round");
  expect(userMessages(server.requests[2])).toEqual([start.task, "Continue with the selected model"]);
  expect(userMessages(server.requests[3])).toEqual([start.task, "Continue with the selected model", "Then inspect the test results"]);
  expect(f.hostCalls.filter(call => call.method === "tools.execute" && call.params.toolName === "Read")).toHaveLength(1);
  expect(server.requests.every(request => request.body.reasoning_effort === undefined)).toBe(true);
  expect(f.rows.get(root.messageId)?.subagentControl).toMatchObject({ modelKey: "selected/selected-model", thinkingLevel: "omit" });
});

it.each(["running", "settled"] as const)("reauthorizes a previously granted choice on a %s child after revocation", async phase => {
  const requested = deferred(); const release = deferred(); let authorized = true;
  const server = await loopback(async (request, index) => {
    if (index === 1 && phase === "running") { requested.resolve(); await release.promise; }
    return answer("Retained selected result", request.body.model);
  });
  const primary = server.provider("primary"); const selected = server.provider("selected");
  const f = fixture([], { provider: primary, ...modelCatalog(primary, selected), resolveModel: async () => authorized ? selected : undefined });
  const root = await control(f.runtime, { ...start, model: "selected/selected-model" });
  if (phase === "running") await requested.promise; else await f.settled.promise;
  authorized = false;
  await expect(control(f.runtime, { sessionId: "control-fixture", operationId: "revoked-choice", action: "message",
    delegationId: root.delegationId, content: "Must not bypass revocation", model: "selected/selected-model" }, phase === "running" ? "host-turn" : "revoked-turn")).rejects.toThrow(/not available for delegation/i);
  expect(f.hostCalls.filter(call => call.method === "provider.resolveSubagentModel")).toHaveLength(2);
  expect([...f.rows.values()].some(row => row.subagentControl?.operationId === "revoked-choice")).toBe(false);
  release.resolve(); if (phase === "running") await f.settled.promise;
  expect(server.requests).toHaveLength(1);
});

it.each(["running", "settled"] as const)("uses the selected smaller context budget for a %s child", async phase => {
  const requested = deferred(); const release = deferred();
  const historicalReport = "Historical finding with retained evidence. ".repeat(1_600);
  const server = await loopback(async (request, index) => {
    if (index === 1 && phase === "running") { requested.resolve(); await release.promise; }
    return answer(index === 1 ? historicalReport : "Compact retained result", request.body.model);
  });
  const primary = server.provider("primary"); const selectedBase = server.provider("small");
  const selected: RuntimeProviderConfig = { ...selectedBase,
    modelConfig: { ...genericModelConfig(selectedBase.modelId, selectedBase.baseUrl!), contextWindow: 4_096, maxTokens: 512 } };
  const f = fixture([], { provider: primary, ...modelCatalog(primary, selected) });
  const root = await control(f.runtime, start);
  if (phase === "running") await requested.promise; else await f.settled.promise;
  const direction = "Keep the current instruction within the selected context window";
  const next = await control(f.runtime, { sessionId: "control-fixture", operationId: "smaller-window", action: "message",
    delegationId: root.delegationId, content: direction, model: "small/small-model" }, phase === "running" ? "host-turn" : "small-turn");
  release.resolve(); await f.waitForTurn(phase === "running" ? "host-turn" : "small-turn");
  const request = [...server.requests].reverse().find(request => userMessages(request).at(-1) === direction);
  expect(request).toBeDefined();
  if (!request) throw new Error("Missing the selected user request");
  expect(request.account).toBe("small"); expect(request.authorization).toBe("Bearer fixture-small");
  expect(request.body.max_tokens ?? request.body.max_completion_tokens).toBeLessThanOrEqual(512);
  expect(JSON.stringify(request.body.messages)).not.toContain(historicalReport);
  expect(f.rows.get(phase === "running" ? root.messageId : next.messageId)?.subagentControl).toMatchObject({ status: "completed", modelKey: "small/small-model" });
});

it("does not switch or enqueue an uncommitted direction, and retries its operation once", async () => {
  const requested = deferred(); const release = deferred(); let failWrite = true;
  const server = await loopback(async (request, index) => {
    if (index === 1) { requested.resolve(); await release.promise; }
    return answer("Recorded result", request.body.model);
  });
  const primary = server.provider("primary"); const selected = server.provider("selected");
  const f = fixture([], { provider: primary, ...modelCatalog(primary, selected), persist: async message => {
    if (message.subagentControl?.operationId === "write-retry" && failWrite) throw new Error("Fixture direction write failed");
  } });
  const root = await control(f.runtime, start); await requested.promise;
  const request: AgentSubagentControlRequest = { sessionId: "control-fixture", operationId: "write-retry", action: "message",
    delegationId: root.delegationId, content: "Only deliver after commit", model: "selected/selected-model" };
  await expect(control(f.runtime, request)).rejects.toThrow("Fixture direction write failed");
  expect(f.rows.get(root.messageId)?.subagentControl?.modelId).toBe(primary.modelId);
  expect([...f.rows.values()].some(row => row.subagentControl?.operationId === request.operationId)).toBe(false);
  failWrite = false; const accepted = await control(f.runtime, request);
  expect(await control(f.runtime, request)).toEqual(accepted);
  release.resolve(); await f.settled.promise;
  expect(server.requests.map(request => request.account)).toEqual(["primary", "selected"]);
  expect(userMessages(server.requests[1])).toEqual([start.task, request.content]);
});

it("rejects a model authorization that completes after session disposal", async () => {
  const requested = deferred(); const entered = deferred(); const release = deferred();
  const server = await loopback(async request => { requested.resolve(); await release.promise; return answer("Disposed fixture result", request.body.model); });
  const primary = server.provider("primary"); const selected = server.provider("selected");
  const f = fixture([], { provider: primary, resolveModel: async () => { entered.resolve(); await release.promise; return selected; } });
  const root = await control(f.runtime, start); await requested.promise;
  const pending = control(f.runtime, { sessionId: "control-fixture", operationId: "dispose-race", action: "message",
    delegationId: root.delegationId, content: "Never cross session disposal", model: "selected/selected-model" });
  const rejected = expect(pending).rejects.toThrow(/changed|cancelled|unavailable/i);
  await entered.promise; const disposal = f.runtime.dispose(); release.resolve(); await rejected; await disposal;
  expect(server.requests).toHaveLength(1);
  expect(f.hostCalls.some(call => call.method === "session.appendMessage" && (call.params.message as UiMessage)?.subagentControl?.operationId === "dispose-race")).toBe(false);
});

it.each(["live", "restored", "interrupted"] as const)("continues a provider-created Task chain in a %s runtime", async phase => {
  const childRequested = deferred();
  const child = { ...provider, id: "child", modelId: "child-model" };
  const options = { subagents: [{ ...definition, model: { providerId: child.id, modelId: child.modelId } }],
    subagentProviders: { "child/child-model": child } };
  const bodies: Array<{ model: string; messages: unknown[] }> = [];
  let parentCalls = 0; let childCalls = 0;
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body)); bodies.push(body);
    if (body.model === provider.modelId) {
      if (++parentCalls > 1) return answer("Parent finished");
      const chunk = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({ id: "task-fixture", object: "chat.completion.chunk", created: 1, model: provider.modelId, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      return new Response(chunk({ role: "assistant", tool_calls: [{ index: 0, id: "provider-task", type: "function",
        function: { name: "Task", arguments: JSON.stringify({ agent: "explorer", task: "Original provider task" }) } }] }, null) +
        chunk({}, "tool_calls") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    }
    if (++childCalls > 1) return answer("Continued provider child", child.modelId);
    childRequested.resolve();
    return new Promise<Response>((_resolve, reject) => {
      const abort = () => reject(new DOMException("Fixture stopped", "AbortError"));
      if (init.signal?.aborted) abort(); else init.signal?.addEventListener("abort", abort, { once: true });
    });
  }));
  const first = fixture([], options);
  const parentRun = first.runtime.prompt("Delegate the fixture", "parent-user", "parent-turn");
  await childRequested.promise;
  const taskRow = () => [...first.rows.values()].find(row => row.toolName === "Task");
  await vi.waitFor(() => expect(taskRow()).toBeDefined());
  const task = taskRow()!;
  const delegationId = (task.toolResult as { details: { delegationId: string } }).details.delegationId;
  const interruptedSnapshot = structuredClone([...first.rows.values()]);
  await first.runtime.stopSubagents([delegationId]); await parentRun;
  for (let index = 0; index < 2; index += 1) {
    const turnId = `newer-turn-${index}`;
    await control(first.runtime, { ...start, operationId: `newer-${index}`, task: `Unrelated child ${index}` }, turnId);
    await first.waitForTurn(turnId);
  }
  const target = phase === "live" ? first : fixture(phase === "interrupted" ? interruptedSnapshot : [...first.rows.values()], options);
  const resumed = await control(target.runtime, { sessionId: "control-fixture", operationId: "resume-provider", action: "message",
    delegationId, content: "Continue the original provider child" }, "resume-turn");
  await target.waitForTurn("resume-turn");
  expect(resumed.delivery).toBe("started");
  expect(childCalls).toBe(4);
  expect(JSON.stringify(bodies.at(-1)?.messages)).toContain("Original provider task");
  expect(JSON.stringify(bodies.at(-1)?.messages)).toContain("Continue the original provider child");
  expect(JSON.stringify(bodies.at(-1)?.messages)).not.toContain("Unrelated child");
  expect(target.rows.get(resumed.messageId)?.subagentControl).toMatchObject({ resume: delegationId, status: "completed" });
});

it.each(["task", "user"] as const)("restores a legacy %s child using its recorded account, not an unavailable default", async owner => {
  const server = await loopback();
  const original = server.provider("original", "retained-model");
  const primary = server.provider("primary");
  const ownerId = "legacy-call";
  const root: UiMessage = owner === "task" ? {
    id: ownerId, role: "tool", content: "", createdAt: new Date(0).toISOString(),
    toolName: "Task", toolCallId: ownerId, toolStatus: "success",
    toolArgs: { agent: "explorer", task: "Original private task", model: "custom/retained-model" },
    toolResult: { details: { delegationId: "legacy-id", status: "completed", modelId: original.modelId } },
  } : {
    id: ownerId, role: "user", content: "Original private task", createdAt: new Date(0).toISOString(),
    parentToolCallId: ownerId, agentName: "explorer",
    subagentControl: { action: "start", operationId: "legacy-start", requestHash: "a".repeat(64),
      delegationId: "legacy-id", agent: "explorer", status: "completed", modelId: original.modelId },
  };
  const history: UiMessage[] = [root, {
    id: "legacy-reply", role: "assistant", content: "Original private findings", status: "complete",
    createdAt: new Date(1).toISOString(), parentToolCallId: ownerId, agentName: "explorer",
    modelId: original.modelId, providerId: original.id,
  }];
  const f = fixture(history, {
    provider: primary, subagentProviders: {}, subagentModelKeys: [],
    subagents: [{ ...definition, model: { providerId: "unconfigured", modelId: "missing-default" } }],
    resolveModel: async key => key === "original/retained-model" ? original : undefined,
  });
  const response = await control(f.runtime, { sessionId: "control-fixture", operationId: "legacy-resume",
    action: "message", delegationId: "legacy-id", content: "Continue the original work" });
  await f.settled.promise;
  expect(server.requests.map(request => [request.account, request.body.model])).toEqual([["original", "retained-model"]]);
  expect(JSON.stringify(server.requests[0].body.messages)).toContain("Original private findings");
  expect(userMessages(server.requests[0])).toEqual(["Original private task", "Continue the original work"]);
  expect(f.rows.get(response.messageId)?.subagentControl).toMatchObject({ modelId: original.modelId, modelKey: "original/retained-model", status: "completed" });
  expect(f.hostCalls.filter(call => call.method === "provider.resolveSubagentModel").map(call => call.params.key)).toEqual(["original/retained-model"]);
});

it("rejects an unavailable recorded account instead of silently continuing on the default", async () => {
  const server = await loopback();
  const primary = server.provider("primary", "retained-model");
  const history: UiMessage[] = [{
    id: "legacy-call", role: "tool", content: "", createdAt: new Date(0).toISOString(),
    toolName: "Task", toolCallId: "legacy-call", toolStatus: "success",
    toolArgs: { agent: "explorer", task: "Original task" },
    toolResult: { details: { delegationId: "legacy-id", status: "completed", modelId: primary.modelId, modelKey: "removed/retained-model" } },
  }, {
    id: "reply", role: "assistant", content: "Prior result", createdAt: new Date(1).toISOString(),
    parentToolCallId: "legacy-call", agentName: "explorer", modelId: primary.modelId, providerId: "removed",
  }];
  const before = JSON.stringify(history);
  const f = fixture(history, { provider: primary, resolveModel: async () => undefined });
  await expect(control(f.runtime, { sessionId: "control-fixture", operationId: "rejected-resume", action: "message",
    delegationId: "legacy-id", content: "Continue" })).rejects.toThrow(/recorded model.*unavailable/i);
  await f.settled.promise;
  expect(server.requests).toEqual([]);
  expect(JSON.stringify([...f.rows.values()])).toBe(before);
  expect(f.rows.has("user-subagent-rejected-resume")).toBe(false);
});

it.each(["unknown", "ambiguous"])("rejects a %s legacy binding without requesting the session default", async shape => {
  const server = await loopback();
  const primary = server.provider("primary", "same-model");
  const other = server.provider("other", "same-model");
  const f = fixture([{
    id: "old", role: "tool", content: "", createdAt: new Date(0).toISOString(), toolName: "Task", toolCallId: "old",
    toolArgs: { agent: "explorer", task: "Original task" },
    toolResult: { details: { delegationId: "old-id", status: "completed", ...(shape === "ambiguous" ? { modelId: "same-model" } : {}) } },
  }, { id: "reply", role: "assistant", content: "Prior findings", createdAt: new Date(1).toISOString(), parentToolCallId: "old", agentName: "explorer" }],
  { provider: primary, ...modelCatalog(primary, other) });
  await expect(control(f.runtime, { sessionId: "control-fixture", operationId: "reject-legacy", action: "message", delegationId: "old-id", content: "Continue" }))
    .rejects.toThrow(/recorded model.*unavailable or ambiguous/i);
  await f.settled.promise;
  expect(server.requests).toEqual([]);
});
