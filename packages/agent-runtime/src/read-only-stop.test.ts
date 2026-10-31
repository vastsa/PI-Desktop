import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentEventEnvelope } from "@pi-desktop/shared";
import { DesktopAgentRuntime } from "./runtime.js";

type ToolName = "Read" | "Glob" | "Grep" | "Write";
type ToolResult = { ok: boolean; content: unknown };

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(toolName: ToolName) {
  const execution = deferred<ToolResult>();
  const cancellation = deferred<unknown>();
  const started = deferred<void>();
  const abortRequested = deferred<void>();
  const events: AgentEventEnvelope[] = [];
  const args = toolName === "Grep" ? { query: "needle" }
    : toolName === "Glob" ? { pattern: "**/*.ts" }
    : toolName === "Write" ? { path: "fixture.txt", content: "replacement" }
    : { path: "fixture.txt" };
  let requests = 0;
  vi.stubGlobal("fetch", vi.fn(async () => {
    requests++;
    if (requests > 2) throw new Error("Unexpected provider retry");
    const first = requests === 1;
    const delta = first ? { role: "assistant", tool_calls: [{
      index: 0, id: "fixture-call", type: "function",
      function: { name: toolName, arguments: JSON.stringify(args) },
    }] } : { role: "assistant", content: "Second turn completed" };
    const chunk = (value: unknown, finish: string | null) =>
      `data: ${JSON.stringify({ id: "completion", object: "chat.completion.chunk", created: 1,
        model: "fixture-model", choices: [{ index: 0, delta: value, finish_reason: finish }] })}\n\n`;
    return new Response(chunk(delta, null) + chunk({}, first ? "tool_calls" : "stop") + "data: [DONE]\n\n", {
      headers: { "content-type": "text/event-stream" },
    });
  }));
  const runtime = new DesktopAgentRuntime({
    sessionId: "stop-fixture", mode: "agent", thinkingLevel: "off",
    provider: { id: "fixture", name: "Fixture", modelId: "fixture-model",
      baseUrl: "http://provider.invalid/v1", apiKey: "fixture-only", apiStyle: "chat_completions",
      supportsReasoning: false, supportedThinkingLevels: ["off"] },
    commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
    host: { async call<T>(method: string): Promise<T> {
      if (method === "tools.fileBatchCapabilities") return { version: 1, supported: false } as T;
      if (method === "tools.execute") { started.resolve(); return await execution.promise as T; }
      if (method === "tools.abort") { abortRequested.resolve(); return await cancellation.promise as T; }
      if (method === "session.appendMessage" || method === "project.instructions.resolve") return undefined as T;
      throw new Error(`Unexpected host method: ${method}`);
    } },
    onEvent: (event) => events.push(event),
  });
  return { runtime, execution, cancellation, started, abortRequested, events, requests: () => requests };
}

afterEach(() => vi.unstubAllGlobals());

it.each(["Read", "Glob", "Grep"] as const)("stops %s and accepts another prompt while the abort acknowledgement is held", async (name) => {
  const f = fixture(name);
  const first = f.runtime.prompt("Inspect the fixture").then(() => undefined, () => undefined);
  let aborting: Promise<void> | undefined;
  try {
    await Promise.race([f.started.promise, first.then(() => { throw new Error("Tool did not start"); })]);
    let stopped = false;
    aborting = f.runtime.abort().then(() => { stopped = true; });
    await f.abortRequested.promise;
    await nextTurn();
    expect(stopped, "a read-only local stop must not await the blocked host").toBe(true);
    await first;
    expect(f.runtime.getStatus().isRunning).toBe(false);

    await f.runtime.prompt("Continue with a new task");
    expect(f.requests()).toBe(2);
    expect(f.runtime.getStatus().isRunning).toBe(false);
    const eventCount = f.events.length;
    f.cancellation.reject(new Error("late abort transport failure"));
    f.execution.reject(new Error("late read failure"));
    await nextTurn();
    expect(f.events).toHaveLength(eventCount);
    expect(f.requests()).toBe(2);
  } finally {
    f.cancellation.resolve({ ok: true });
    f.execution.resolve({ ok: false, content: "cancelled" });
    await Promise.allSettled([first, aborting]);
    await f.runtime.dispose();
  }
});

it("keeps a Write turn owned until both execution and host cancellation settle", async () => {
  const f = fixture("Write");
  const first = f.runtime.prompt("Update the fixture").then(() => undefined, () => undefined);
  let aborting: Promise<void> | undefined;
  try {
    await Promise.race([f.started.promise, first.then(() => { throw new Error("Write did not start"); })]);
    let stopped = false;
    aborting = f.runtime.abort().then(() => { stopped = true; });
    await f.abortRequested.promise;
    await nextTurn();
    expect(stopped).toBe(false);
    f.execution.resolve({ ok: true, content: "written" });
    await nextTurn();
    expect(stopped, "mutation cancellation still requires host settlement").toBe(false);
    f.cancellation.resolve({ ok: true });
    await aborting;
    expect(stopped).toBe(true);
  } finally {
    f.execution.resolve({ ok: false, content: "cancelled" });
    f.cancellation.resolve({ ok: true });
    await Promise.allSettled([first, aborting]);
    await f.runtime.dispose();
  }
});
