import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream, type AssistantMessage, type Models } from "@earendil-works/pi-ai";
import type { AgentEventEnvelope, UiMessage } from "@pi-desktop/shared";
import { DesktopAgentRuntime, type RuntimeProviderConfig } from "./runtime.js";

// Exercise real parent/child loops; mock only provider transport and host I/O.
const transport = vi.hoisted(() => vi.fn<Models["streamSimple"]>());
vi.mock("./provider-binding.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./provider-binding.js")>();
  return { ...actual, createProviderModels: (...args: Parameters<typeof actual.createProviderModels>) => {
    const models = actual.createProviderModels(...args);
    models.streamSimple = transport;
    return models;
  } };
});

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const provider: RuntimeProviderConfig = {
  id: "fixture", name: "Fixture", apiKey: "", authKind: "none",
  baseUrl: "http://127.0.0.1:1/v1", modelId: "fixture", supportsReasoning: false,
  supportedThinkingLevels: ["off"],
};
function message(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
  return { role: "assistant", api: "openai-completions", provider: "fixture", model: "fixture",
    timestamp: Date.now(), stopReason, content,
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
function response(content: AssistantMessage["content"], stopReason: "stop" | "toolUse" = "stop") {
  const stream = createAssistantMessageEventStream();
  const result = message(content, stopReason);
  queueMicrotask(() => {
    stream.push({ type: "start", partial: result });
    stream.push({ type: "done", reason: stopReason, message: result });
    stream.end(result);
  });
  return stream;
}
function waiting(signal?: AbortSignal) {
  const stream = createAssistantMessageEventStream();
  let ended = false;
  const finish = (aborted = false) => {
    if (ended) return;
    ended = true;
    signal?.removeEventListener("abort", abort);
    const result = message([{ type: "text", text: "Child finished independently" }], aborted ? "aborted" : "stop");
    if (aborted) stream.push({ type: "error", reason: "aborted", error: result });
    else stream.push({ type: "done", reason: "stop", message: result });
    stream.end(result);
  };
  const abort = () => finish(true);
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  return { stream, signal, finish };
}
const runtimes: DesktopAgentRuntime[] = [];
function fixture(execute?: (params: Record<string, unknown>) => Promise<unknown>) {
  const events: AgentEventEnvelope[] = [];
  const aborts: string[] = [];
  const executions: Record<string, unknown>[] = [];
  const owners: Record<string, unknown>[] = [];
  const endedOwners: Record<string, unknown>[] = [];
  const runtime = new DesktopAgentRuntime({
    sessionId: "independent-children", mode: "agent", thinkingLevel: "off", provider,
    commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
    subagents: [{ name: "worker", description: "Independent worker", tools: ["Read"], prompt: "Work independently.", source: "builtin" }],
    host: { async call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
      if (method === "tools.abort") aborts.push(String(params?.toolCallId));
      if (method === "tools.execution.start") owners.push(params ?? {});
      if (method === "tools.execution.end") endedOwners.push(params ?? {});
      if (method === "tools.execute") {
        executions.push(params ?? {});
        return await execute?.(params ?? {}) as T;
      }
      if (method === "tools.fileBatchCapabilities") return { version: 1, supported: false } as T;
      return undefined as T;
    }, onNotification: () => () => {} },
    onEvent: event => events.push(event),
  });
  runtimes.push(runtime);
  return { runtime, events, aborts, executions, owners, endedOwners };
}
async function promptly<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Parent stop waited for its independent child")), 1000);
    })]);
  } finally { clearTimeout(timer); }
}
beforeEach(() => { transport.mockReset(); });
afterEach(async () => { for (const runtime of runtimes.splice(0)) await runtime.dispose(); });

for (const origin of ["Task", "user"] as const) {
  describe(`${origin} child survives parent Stop`, () => {
    it.each(["waiting-model", "waiting-subagents"] as const)("keeps running while the parent is %s and accepts a new parent turn", async phase => {
      const parentReady = deferred();
      const childReady = deferred();
      let child: ReturnType<typeof waiting> | undefined;
      let parentRequests = 0;
      const f = fixture();
      transport.mockImplementation((_model, context, options) => {
        const text = JSON.stringify(context.messages);
        if (text.includes("New parent question")) return response([{ type: "text", text: "New parent answer" }]);
        if (text.includes("Parent task")) {
          parentRequests += 1;
          if (origin === "Task" && parentRequests === 1) return response([{
            type: "toolCall", id: "child-task", name: "Task", arguments: { agent: "worker", task: "Independent child task" },
          }], "toolUse");
          parentReady.resolve();
          return phase === "waiting-subagents" ? response([{ type: "text", text: "Parent waiting" }]) : waiting(options?.signal).stream;
        }
        child = waiting(options?.signal);
        childReady.resolve();
        return child.stream;
      });
      const parentRun = f.runtime.prompt("Parent task", "parent-user", "parent-turn");
      let childId: string | undefined;
      try {
        await parentReady.promise;
        if (origin === "user") {
          const accepted = await f.runtime.controlSubagent({ sessionId: "independent-children", operationId: "start-child",
            action: "start", agent: "worker", task: "Independent child task" }, "parent-turn");
          childId = accepted.delegationId;
        }
        await childReady.promise;
        if (phase === "waiting-subagents") await vi.waitFor(() => expect(f.runtime.getStatus().activity?.phase).toBe("waiting-subagents"));
        await promptly(f.runtime.abort("parent"));
        await promptly(parentRun);
        expect(child?.signal?.aborted).toBe(false);
        expect(f.runtime.getStatus().isRunning).toBe(false);
        expect(f.events.filter(event => !event.parentToolCallId && event.event.type === "agent_end")).toHaveLength(1);
        await promptly(f.runtime.prompt("New parent question", "new-user", "new-turn"));
        expect(child?.signal?.aborted).toBe(false);
        expect(f.runtime.getStatus().isRunning).toBe(false);
        expect(f.events.some(event => event.event.type === "message_end" && event.event.message.content === "New parent answer")).toBe(true);
        const parentEnds = f.events.filter(event => !event.parentToolCallId && event.event.type === "agent_end").length;
        await f.runtime.stopSubagents(childId ? [childId] : undefined);
        expect(child?.signal?.aborted).toBe(true);
        expect(f.events.filter(event => !event.parentToolCallId && event.event.type === "agent_end")).toHaveLength(parentEnds);
      } finally {
        child?.finish();
        await f.runtime.abort();
        await parentRun;
      }
    });
  });
}

it.each(["before", "after"] as const)("does not cancel child host tools started %s parent Stop", async timing => {
  const childReady = deferred();
  const releaseChild = deferred();
  const toolReady = deferred();
  const releaseTool = deferred();
  const childDone = deferred();
  let childRequests = 0;
  const f = fixture(async () => {
    toolReady.resolve();
    await releaseTool.promise;
    return { ok: true, content: "Read completed after parent Stop" };
  });
  transport.mockImplementation((_model, context, options) => {
    if (JSON.stringify(context.messages).includes("New parent question")) return response([{ type: "text", text: "New parent answer" }]);
    if (JSON.stringify(context.messages).includes("Parent task")) return response([{ type: "text", text: "Parent waiting" }]);
    if (++childRequests > 1) { childDone.resolve(); return response([{ type: "text", text: "Child done" }]); }
    const stream = createAssistantMessageEventStream();
    const result = message([{ type: "toolCall", id: "child-read", name: "Read", arguments: { path: "fixture.txt" } }], "toolUse");
    childReady.resolve();
    void releaseChild.promise.then(() => {
      stream.push({ type: "start", partial: result });
      stream.push({ type: "done", reason: "toolUse", message: result });
      stream.end(result);
    });
    options?.signal?.addEventListener("abort", () => {
      const stopped = message([], "aborted");
      stream.push({ type: "error", reason: "aborted", error: stopped });
      stream.end(stopped);
    }, { once: true });
    return stream;
  });
  const accepted = await f.runtime.controlSubagent({ sessionId: "independent-children", operationId: "start-tool-child",
    action: "start", agent: "worker", task: "Independent child task" }, "child-turn");
  const waitForTool = () => promptly(toolReady.promise).catch(error => {
    throw new Error(`${String(error)}; events=${JSON.stringify(f.events)}`);
  });
  try {
    await childReady.promise;
    if (timing === "before") { releaseChild.resolve(); await waitForTool(); }
    await promptly(f.runtime.abort("parent"));
    expect(f.aborts).not.toContain("child-read");
    await promptly(f.runtime.prompt("New parent question", "new-user", "new-turn"));
    releaseChild.resolve();
    await waitForTool();
    releaseTool.resolve();
    await promptly(childDone.promise);
    await vi.waitFor(() => expect(f.events.some(event => event.event.type === "message_end" &&
      event.event.message.subagentControl?.delegationId === accepted.delegationId && event.event.message.subagentControl.status === "completed")).toBe(true));
    expect(f.aborts).toEqual([]);
    expect(f.runtime.getStatus().isRunning).toBe(false);
    expect(f.executions[0]?.turnId).toBe("child-turn");
    expect(f.owners).toHaveLength(1);
    expect(f.owners[0]?.executionOwnerId).toEqual(expect.any(String));
    expect(f.owners[0]?.runtimeId).toEqual(expect.any(String));
    expect(f.executions[0]?.executionOwnerId).toBe(f.owners[0]?.executionOwnerId);
    expect(f.executions[0]?.runtimeId).toBe(f.owners[0]?.runtimeId);
    expect(f.endedOwners).toHaveLength(1);
    expect(f.endedOwners[0]?.executionOwnerId).toBe(f.owners[0]?.executionOwnerId);
  } finally { releaseChild.resolve(); releaseTool.resolve(); }
});

/** Details a Task-created or user-created child snapshot carries. */
function delegationDetails(message: UiMessage): Record<string, unknown> {
  const control = message.subagentControl as unknown as Record<string, unknown> | undefined;
  if (control && typeof control.delegationId === "string") return control;
  const result = message.toolResult as { details?: unknown } | undefined;
  return (result?.details && typeof result.details === "object"
    ? result.details
    : {}) as Record<string, unknown>;
}

it("publishes a detached running child when the parent stops and clears it on settlement", async () => {
  const parentReady = deferred();
  const childReady = deferred();
  let child: ReturnType<typeof waiting> | undefined;
  let parentRequests = 0;
  const f = fixture();
  transport.mockImplementation((_model, context, options) => {
    const text = JSON.stringify(context.messages);
    if (text.includes("Parent task")) {
      parentRequests += 1;
      if (parentRequests === 1) {
        return response([{
          type: "toolCall", id: "child-task", name: "Task",
          arguments: { agent: "worker", task: "Detached child task" },
        }], "toolUse");
      }
      parentReady.resolve();
      return waiting(options?.signal).stream;
    }
    child = waiting(options?.signal);
    childReady.resolve();
    return child.stream;
  });
  const parentRun = f.runtime.prompt("Parent task", "parent-user", "parent-turn");
  const childSnapshots = () => f.events
    .filter(event => event.event.type === "message_end")
    .map(event => (event.event as { message: UiMessage }).message)
    .filter(message => Boolean(message.toolResult || message.subagentControl));
  try {
    await childReady.promise;
    await promptly(f.runtime.abort("parent"));
    await promptly(parentRun);
    expect(f.runtime.getStatus().isRunning).toBe(false);
    await vi.waitFor(() => {
      const detached = childSnapshots().filter(message => delegationDetails(message).detached === true);
      expect(detached.length).toBeGreaterThan(0);
      expect(delegationDetails(detached.at(-1)!).status).toBe("running");
    });
    child?.finish();
    await vi.waitFor(() => {
      const settled = childSnapshots().filter(message => delegationDetails(message).status === "completed");
      expect(settled.length).toBeGreaterThan(0);
      expect(delegationDetails(settled.at(-1)!).detached).toBeUndefined();
    });
  } finally {
    child?.finish();
    await f.runtime.abort();
    await parentRun;
  }
});
