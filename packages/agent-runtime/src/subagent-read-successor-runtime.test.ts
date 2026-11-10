import { afterEach, expect, it, vi } from "vitest";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { AgentEventEnvelope, UiMessage } from "@pi-desktop/shared";
import { DesktopAgentRuntime } from "./runtime.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function sse(delta: unknown, finish = "stop") {
  const chunk = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({
    id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture-model",
    choices: [{ index: 0, delta, finish_reason }],
  })}\n\n`;
  return new Response(chunk(delta, null) + chunk({}, finish) + "data: [DONE]\n\n", {
    headers: { "content-type": "text/event-stream" },
  });
}
function call(name: string, id: string, args: unknown) {
  return sse({ role: "assistant", tool_calls: [{ index: 0, id, type: "function",
    function: { name, arguments: JSON.stringify(args) } }] }, "tool_calls");
}
function tool(runtime: DesktopAgentRuntime, name: string): AgentTool {
  const found = (runtime as unknown as { agent: { state: { tools: AgentTool[] } } }).agent.state.tools.find(t => t.name === name);
  if (!found) throw new Error(`Missing ${name}`);
  return found;
}
const runtimes: DesktopAgentRuntime[] = [];
function fixture(history: UiMessage[] = [], sessionId = "successor-fixture", onEvent?: (event: AgentEventEnvelope) => void) {
  const rows = new Map(history.map(row => [row.id, row]));
  const events: AgentEventEnvelope[] = [];
  const runtime = new DesktopAgentRuntime({
    sessionId, mode: "agent", thinkingLevel: "off", history,
    provider: { id: "fixture", name: "Fixture", modelId: "fixture-model", apiStyle: "chat_completions",
      baseUrl: "http://provider.invalid/v1", apiKey: "fixture-only", supportsReasoning: false, supportedThinkingLevels: ["off"] },
    commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
    subagents: [{ name: "explorer", description: "Inspect the fixture", tools: ["Read"], prompt: "Successor child fixture guidance", source: "builtin" }],
    compactionSettings: { enabled: false, reserveTokens: 0, keepRecentTokens: 0 },
    host: { async call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
      if (method === "tools.fileBatchCapabilities") return { version: 1, supported: false } as T;
      if (method === "session.appendMessage") { const row = params?.message as UiMessage; rows.set(row.id, row); }
      return undefined as T;
    }, onNotification: () => () => {} },
    onEvent(envelope) {
      events.push(envelope);
      if (envelope.event.type === "message_end") {
        const row = envelope.event.message;
        rows.set(row.id, { ...row, parentToolCallId: envelope.parentToolCallId ?? row.parentToolCallId,
          agentName: envelope.agentName ?? row.agentName });
      }
      onEvent?.(envelope);
    },
  });
  runtimes.push(runtime);
  return { runtime, rows, events };
}
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose();
  vi.unstubAllGlobals();
});

type ChatBody = { messages: Array<{ role: string; content?: unknown; tool_call_id?: string }> };

it.each([false, true])("follows a model-created stopped Task through user continuation (restart=%s)", async restart => {
  const childStarted = deferred();
  const continued = deferred<string>();
  const releaseChild = deferred();
  const waitStarted = deferred();
  const parentWaiting = deferred<string>();
  const observations: Record<string, unknown> = {};
  let parentCalls = 0;
  let childCalls = 0;
  let oldId = "";
  let newId = "";
  let waitEnded = false;
  const bodies: ChatBody[] = [];
  vi.stubGlobal("fetch", async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as ChatBody;
    if (JSON.stringify(body.messages[0]).includes("Successor child fixture guidance")) {
      childCalls += 1;
      if (childCalls === 1) {
        childStarted.resolve();
        return new Promise<Response>((_resolve, reject) => {
          const abort = () => reject(new DOMException("Stopped fixture", "AbortError"));
          if (init.signal?.aborted) abort(); else init.signal?.addEventListener("abort", abort, { once: true });
        });
      }
      await releaseChild.promise;
      return sse({ role: "assistant", content: "Successor final report" });
    }
    bodies.push(body);
    parentCalls += 1;
    if (parentCalls === 1) return call("Task", "original-task", { agent: "explorer", task: "Inspect fixture" });
    if (parentCalls === 2) {
      const found = JSON.stringify(body).match(/Delegation ([0-9a-f-]{36}) started/);
      if (!found) throw new Error("Task did not return its id");
      parentWaiting.resolve(found[1]);
      newId = await continued.promise;
      return call("TaskRead", "read-running", { delegationId: oldId });
    }
    if (parentCalls === 3) return call("TaskList", "list-running", {});
    if (parentCalls === 4) return call("TaskWait", "wait-successor", { delegationIds: restart ? [oldId, newId, oldId] : [oldId] });
    return sse({ role: "assistant", content: "Parent finished" });
  });
  const f = fixture([], "successor-fixture", envelope => {
    const event = envelope.event;
    if (event.type === "tool_start" && event.toolCallId === "wait-successor") waitStarted.resolve();
    if (event.type === "tool_end" && ["read-running", "list-running", "wait-successor"].includes(event.toolCallId)) {
      observations[event.toolCallId] = event.result;
      if (event.toolCallId === "wait-successor") waitEnded = true;
    }
  });
  const prompt = f.runtime.prompt("Start and inspect a task", "parent-user", "parent-turn");
  try {
    oldId = await parentWaiting.promise;
    await childStarted.promise;
    await f.runtime.stopSubagents([oldId]);
    const deniedResume = await tool(f.runtime, "Task").execute("model-resume-stopped", {
      agent: "explorer", task: "Continue without user permission", resume: oldId,
    });
    expect(deniedResume.details).toMatchObject({ error: expect.stringContaining("stopped") });
    const response = await f.runtime.controlSubagent({ sessionId: "successor-fixture", operationId: "continue-stopped",
      action: "message", delegationId: oldId, content: "Continue the stopped inspection" }, "parent-turn");
    newId = response.delegationId;
    expect(newId).not.toBe(oldId);
    continued.resolve(newId);
    await waitStarted.promise;
    // Drain the tool's immediate async work without advancing time or releasing the child.
    await new Promise<void>(resolve => setImmediate(resolve));
    expect.soft(waitEnded).toBe(false);
    expect.soft(observations["read-running"]).toMatchObject({ details: { delegationId: oldId,
      latestDelegationId: newId, status: "running", source: "live" } });
    expect.soft(observations["list-running"]).toMatchObject({ details: { delegations: expect.arrayContaining([
      expect.objectContaining({ delegationId: oldId, status: "stopped", latestDelegationId: newId, latestStatus: "running", supersededBy: newId }),
      expect.objectContaining({ delegationId: newId, resumedFrom: oldId, status: "running" }),
    ]) } });
    expect(JSON.stringify(observations["list-running"])).toContain(`historical run, superseded by ${newId}`);
    const stopOld = await tool(f.runtime, "TaskStop").execute("stop-old", { delegationIds: [oldId] });
    expect(stopOld.details).toMatchObject({ stopped: [] });
    for (const id of [oldId, newId]) {
      const recover = await tool(f.runtime, "TaskRecover").execute("recover-observed", { delegationId: id, model: "fixture/fixture-model" });
      expect(recover.details).toMatchObject({ error: expect.stringContaining("parent-owned") });
    }
    expect((await tool(f.runtime, "TaskRead").execute("still-running", { delegationId: oldId })).details)
      .toMatchObject({ status: "running", latestDelegationId: newId });
    releaseChild.resolve();
    await prompt;
    expect.soft(observations["wait-successor"]).toMatchObject({ details: { status: "completed", delegations: [
      { delegationId: newId, status: "completed", report: "Successor final report", requestedDelegationIds: restart ? [oldId, newId] : [oldId] },
    ] } });
    expect.soft(JSON.stringify(bodies.at(-1))).toContain("Successor final report");
    expect(parentCalls).toBe(5); // User continuation never automatically wakes/re-prompts the parent.

    const history = [...f.rows.values()];
    const frozenHistory = JSON.stringify(history);
    const target = restart ? fixture(history).runtime : f.runtime;
    if (restart) await f.runtime.dispose();
    const read = await tool(target, "TaskRead").execute("read-completed", { delegationId: oldId });
    expect.soft(read.details).toMatchObject({ delegationId: oldId, latestDelegationId: newId, status: "completed", source: restart ? "chain" : "live" });
    const wait = await tool(target, "TaskWait").execute("wait-completed", { delegationIds: [oldId] });
    expect(wait.details).toMatchObject({ status: "completed", delegations: [{ delegationId: newId, status: "completed", report: "Successor final report" }] });
    const listed = await tool(target, "TaskList").execute("list-completed", {});
    expect(listed.details).toMatchObject({ recorded: { entries: [{ delegationId: newId, previousDelegationId: oldId, status: "completed" }] } });
    expect(JSON.stringify(history)).toBe(frozenHistory);
    expect(parentCalls).toBe(5);

    const foreign = fixture([], "different-session").runtime;
    for (const id of [oldId, "unknown-delegation"]) {
      const rejected = await tool(foreign, "TaskRead").execute("read-foreign", { delegationId: id });
      expect(rejected.isError).toBe(true);
      const absent = await tool(foreign, "TaskWait").execute("wait-foreign", { delegationIds: [id] });
      expect(absent.details).toMatchObject({ delegations: [] });
      expect(JSON.stringify(absent)).not.toContain("Successor final report");
    }
  } finally {
    continued.resolve(newId);
    releaseChild.resolve();
    await prompt;
  }
});
