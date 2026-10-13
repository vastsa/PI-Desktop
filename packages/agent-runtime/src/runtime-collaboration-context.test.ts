import { describe, expect, it } from "vitest";
import { createAssistantMessageEventStream, getCurrentSystemMessage, getCurrentSystemPrompt, type AssistantMessage, type Context, type ToolCall } from "@earendil-works/pi-ai";
import type { SessionTodoSnapshot, UiMessage } from "@pi-desktop/shared";
import { DesktopAgentRuntime } from "./runtime.js";
import { SESSION_TODOS_SECTION } from "./system-transcript.js";

const sessionId = "collaboration-fixture";
const provider = { id: "fixture", name: "Fixture", modelId: "fixture", apiKey: "", authKind: "none" as const,
  baseUrl: "http://fixture.invalid/v1", supportsReasoning: false, supportedThinkingLevels: ["off"] as ["off"] };
const snapshot = (revision: number, content: string): SessionTodoSnapshot => ({
  sessionId, revision, updatedAt: revision, todos: content ? [{ content, status: "pending", priority: "high" }] : [],
});
const call = (id: string, name: string, args: ToolCall["arguments"]): ToolCall => ({ type: "toolCall", id, name, arguments: args });

function fixture(history: UiMessage[] = [], initial = snapshot(1, "Verify the parser")) {
  const rows = [...history];
  const requests: Context[] = [];
  const errors: unknown[] = [];
  const results: unknown[] = [];
  const checkpoints: unknown[] = [];
  const state = { snapshot: initial, failRead: false, beforeRead: async () => {}, responses: [] as ToolCall[][], texts: [] as string[] };
  const runtime = new DesktopAgentRuntime({
    sessionId, mode: "agent", provider, thinkingLevel: "off", history, compactionStrategy: "fresh_window",
    commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
    subagents: [{ name: "explorer", description: "Inspect code", prompt: "Inspect code", tools: ["Read"], source: "user", permission: "ask" }],
    host: { call: async <T>(method: string, params?: unknown): Promise<T> => {
      if (method === "todos.get") {
        expect(params).toEqual({ sessionId });
        await state.beforeRead();
        if (state.failRead) throw new Error("Host unavailable");
        return state.snapshot as T;
      }
      if (method === "session.appendMessage") rows.push((params as { message: UiMessage }).message);
      if (method === "session.appendCompaction") checkpoints.push(params);
      if (method === "tools.execute") {
        const todos = (params as { args: { todos: SessionTodoSnapshot["todos"] } }).args.todos;
        state.snapshot = { ...state.snapshot, revision: state.snapshot.revision + 1, todos };
        return { ok: true, content: { content: [{ type: "text", text: "Checklist updated" }] } } as T;
      }
      return undefined as T;
    } },
    onEvent: ({ event, parentToolCallId }) => {
      if (parentToolCallId) return;
      if (event.type === "error") errors.push(event.error);
      if (event.type === "tool_end") results.push({ result: event.result, isError: event.isError });
      if (event.type === "message_end") rows.push(event.message);
    },
  });
  const streamSimple = (_model: unknown, context: Context) => {
    requests.push(structuredClone(context));
    const tools = state.responses.shift() ?? [];
    const message: AssistantMessage = {
      role: "assistant", api: "openai-completions", provider: "fixture", model: "fixture", timestamp: Date.now(),
      stopReason: tools.length ? "toolUse" : "stop", content: tools.length ? tools : [{ type: "text", text: state.texts.shift() ?? "Done." }],
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: tools.length ? "toolUse" : "stop", message });
      stream.end(message);
    });
    return stream;
  };
  (runtime as unknown as { models: { streamSimple: typeof streamSimple } }).models = { streamSimple };
  return { runtime, requests, rows, results, errors, checkpoints, state, prompt: () => runtime.prompt("Continue") };
}
const checklist = (context: Context | undefined) => getCurrentSystemMessage(context?.messages ?? [])?.sections?.[SESSION_TODOS_SECTION];

describe("session checklist through real runtime requests", () => {
  it("keeps checklist state independent of a transient recovery prompt", async () => {
    const f = fixture();
    f.state.texts = ["", "Recovered."];
    try {
      await f.prompt();
      expect(f.requests).toHaveLength(2);
      for (const request of f.requests) {
        expect(getCurrentSystemPrompt(request.messages).match(/Saved session checklist/g)).toHaveLength(1);
      }
      await f.prompt();
      expect(checklist(f.requests.at(-1))).toContain("Verify the parser");
      expect(f.errors).toEqual([]);
    } finally { await f.runtime.dispose(); }
  });
  it("restores the Host list after restart, avoids duplicate updates, and survives compaction", async () => {
    const first = fixture();
    try {
      await first.prompt();
      expect(checklist(first.requests[0])).toContain("Verify the parser");
      await first.prompt();
      expect(first.rows.filter((row) => row.modelSystem && row.modelSystem.messageJson.includes('"session_todos"'))).toHaveLength(1);
      const restored = fixture(structuredClone(first.rows));
      try {
        await restored.prompt();
        expect(checklist(restored.requests[0])).toBe(checklist(first.requests[0]));
        expect(restored.rows.filter((row) => row.modelSystem && row.modelSystem.messageJson.includes('"session_todos"'))).toHaveLength(1);
        await restored.runtime.compactManually();
        expect(restored.checkpoints).toHaveLength(1);
        await restored.prompt();
        expect(checklist(restored.requests.at(-1))).toContain("Verify the parser");
      } finally { await restored.runtime.dispose(); }
    } finally { await first.runtime.dispose(); }
  });

  it("uses committed TodoWrite state on the next model request and revokes a cleared list", async () => {
    const f = fixture();
    f.state.responses = [[call("discover", "ToolSearch", { query: "TodoWrite" })],
      [call("write", "TodoWrite", { todos: [{ content: "Run integration checks", status: "in_progress", priority: "medium" }] })],
      [call("clear", "TodoWrite", { todos: [] })]];
    try {
      await f.prompt();
      expect(checklist(f.requests[2])).toContain("Run integration checks");
      expect(checklist(f.requests[2])).not.toContain("Verify the parser");
      expect(checklist(f.requests[3])).toContain("checklist is empty");
      expect(checklist(f.requests[3])).not.toContain("Run integration checks");
      expect(f.errors).toEqual([]);
    } finally { await f.runtime.dispose(); }
  });

  it("removes stale data on read failure or a mismatched session snapshot without blocking the turn", async () => {
    const f = fixture();
    try {
      await f.prompt();
      f.state.failRead = true;
      await f.prompt();
      expect(checklist(f.requests.at(-1))).toContain("checklist is unavailable");
      expect(checklist(f.requests.at(-1))).not.toContain("Verify the parser");
      f.state.failRead = false;
      f.state.snapshot = { ...snapshot(2, "Other session private plan"), sessionId: "other" };
      await f.prompt();
      expect(JSON.stringify(f.requests.at(-1))).not.toContain("Other session private plan");
      expect(f.errors).toEqual([]);
    } finally { await f.runtime.dispose(); }
  });

  it("bounds a full Unicode checklist and observes Stop during the Host read", async () => {
    const f = fixture([], { ...snapshot(4, ""), todos: Array.from({ length: 50 }, () => ({ content: "😀".repeat(500), status: "pending", priority: "low" })) });
    try {
      f.runtime.setMode("plan");
      await f.prompt();
      expect(checklist(f.requests[0])?.length).toBeLessThan(20_000);
      expect(checklist(f.requests[0])).not.toContain("😀".repeat(161));
      f.state.beforeRead = async () => { f.runtime.abort(); };
      await expect(f.prompt()).rejects.toThrow("Turn aborted");
      expect(f.requests).toHaveLength(1);
    } finally { await f.runtime.dispose(); }
  });
});

const row = (id: string, fields: Partial<UiMessage>): UiMessage => ({ id, role: "assistant", content: "", createdAt: "2026-10-01T00:00:00Z", ...fields });
const history = [
  row("task", { role: "tool", toolCallId: "task", toolName: "Task", toolArgs: { agent: "explorer", task: "Inspect parser" }, toolResult: { details: { delegationId: "delegate", status: "completed" } } }),
  row("child-1", { parentToolCallId: "task", agentName: "explorer", content: "Parser investigation", thinking: "private reasoning" }),
  row("child-2", { role: "tool", parentToolCallId: "task", agentName: "explorer", toolName: "Read", toolResult: { content: [{ type: "image", data: "private base64" }, { type: "text", text: "Parser evidence at src/parser.ts:42" }] } }),
  row("sibling", { parentToolCallId: "other-task", agentName: "explorer", content: "Sibling private evidence" }),
  row("resume", { role: "tool", toolCallId: "resume", toolName: "Task", toolArgs: { agent: "explorer", task: "Continue", resume: "delegate" }, toolResult: { details: { delegationId: "delegate-resumed", status: "completed" } } }),
  row("child-3", { parentToolCallId: "resume", agentName: "explorer", content: "Resumed parser finding" }),
];

describe("TaskList inspection through the model tool path", () => {
  it("keeps default status listing and retrieves/searches/pages a restored delegation chain on demand", async () => {
    const f = fixture(history, snapshot(0, ""));
    f.state.responses = [[call("list", "TaskList", {})],
      [call("trace", "TaskList", { delegationId: "delegate", limit: 1 })],
      [call("page", "TaskList", { delegationId: "delegate-resumed", after: "child-1", limit: 20 })],
      [call("search", "TaskList", { delegationId: "delegate", query: "PARSER.TS:42" })]];
    try {
      await f.prompt();
      expect(f.results[0]).toMatchObject({ isError: false, result: { details: { delegations: [] } } });
      const initial = JSON.stringify(f.requests[0]);
      expect(initial).not.toContain("Parser investigation");
      expect(initial).not.toContain("Parser evidence");
      expect(f.results[1]).toMatchObject({ isError: false, result: { details: { trace: { nextAfter: "child-1", entries: [{ messageId: "child-1" }] } } } });
      expect(f.results[2]).toMatchObject({ result: { details: { trace: { entries: [{ messageId: "child-2" }, { messageId: "child-3" }] } } } });
      expect(f.results[3]).toMatchObject({ result: { details: { trace: { entries: [{ messageId: "child-2" }] } } } });
      expect(JSON.stringify(f.results)).not.toMatch(/private reasoning|private base64|Sibling private/);
      expect(f.errors).toEqual([]);
    } finally { await f.runtime.dispose(); }
  });

  it("reports unknown ids, cross-chain cursors and unscoped options as tool errors", async () => {
    const f = fixture(history, snapshot(0, ""));
    f.state.responses = [
      [call("unknown", "TaskList", { delegationId: "another-session-delegate" })],
      [call("cursor", "TaskList", { delegationId: "delegate", after: "sibling" })],
      [call("unscoped", "TaskList", { query: "parser" })],
      [call("invalid-limit", "TaskList", { delegationId: "delegate", limit: 21 })],
    ];
    try {
      await f.prompt();
      expect(f.results).toHaveLength(4);
      expect(f.results.every((result) => (result as { isError: boolean }).isError)).toBe(true);
    } finally { await f.runtime.dispose(); }
  });
});
