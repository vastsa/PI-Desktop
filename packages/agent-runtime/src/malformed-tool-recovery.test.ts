import { describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { validateHostedSearchMessages } from "@earendil-works/pi-ai/utils/hosted-search";
import type { AgentEventEnvelope } from "@pi-desktop/shared";
import { buildSessionContext } from "./session-context.js";
import { recoverMalformedToolCalls } from "./tool-call-recovery.js";
import type { CompactionEntry } from "./pi-runtime-types.js";
import { convertToLlm } from "./pi-runtime-messages.js";
import { DesktopAgentRuntime } from "./runtime.js";

function assistant(content: unknown[], stopReason = "toolUse"): AssistantMessage {
  return {
    role: "assistant", content, api: "openai-completions", provider: "fixture", model: "fixture",
    stopReason, timestamp: Date.now(),
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  } as AssistantMessage;
}

const call = (id = "valid-call") => ({ type: "toolCall", id, name: "Bash", arguments: { command: "printf checked" } });
const answer = () => assistant([{ type: "text", text: "The requested check is complete." }], "stop");

function fixture(reply: (round: number) => AssistantMessage) {
  const requests: AgentMessage[][] = [];
  const events: AgentEventEnvelope["event"][] = [];
  const host = { call: vi.fn(async (method: string) => method === "tools.execute"
    ? { ok: true, content: { content: [{ type: "text", text: "checked" }], details: {} } }
    : undefined) };
  const runtime = new DesktopAgentRuntime({
    sessionId: "malformed-call-fixture", mode: "agent", thinkingLevel: "off", host: host as never,
    provider: { id: "fixture", name: "Fixture", modelId: "fixture", apiKey: "fixture", baseUrl: "http://localhost/v1",
      supportsReasoning: false, supportedThinkingLevels: ["off"] },
    commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
    history: [{ id: "earlier-user", role: "user", content: "Keep the completed work.", createdAt: new Date(1).toISOString() }],
    onEvent: (envelope) => events.push(envelope.event),
  });
  vi.spyOn(runtime["models"], "streamSimple").mockImplementation((_model, context) => {
    requests.push(structuredClone(context.messages));
    if (requests.length > 6) throw new Error("Unexpected extra provider request");
    validateHostedSearchMessages(context.messages);
    const message = reply(requests.length);
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
      stream.end(message);
    });
    return stream;
  });
  return { runtime, host, requests, events };
}

describe("malformed tool-call recovery", () => {
  it.each([
    ["empty name", { name: "" }],
    ["missing name", { name: undefined }],
    ["empty id", { id: "" }],
    ["missing id", { id: undefined }],
    ["empty wire id", { id: "|item-1" }],
    ["non-object arguments", { arguments: [] }],
  ])("rejects a response with %s before execution and accepts three subsequent prompts", async (_label, invalid) => {
    const { runtime, host, requests, events } = fixture((round) => round === 1
      ? assistant([call("withheld-call"), { ...call("bad-call"), ...invalid }])
      : round === 2 ? assistant([call("corrected-call")]) : answer());
    try {
      await runtime.prompt("Run the check.");
      expect(requests).toHaveLength(1);
      expect(host.call.mock.calls.filter(([method]) => method === "tools.execute")).toHaveLength(0);
      expect(events).toContainEqual(expect.objectContaining({ type: "error", error: expect.objectContaining({
        details: { origin: "local", phase: "context-validation" },
      }) }));
      expect(events.filter((event) => event.type === "tool_start")).toHaveLength(0);
      for (let attempt = 0; attempt < 3; attempt++) await runtime.prompt("Continue the current task.");
      expect(requests).toHaveLength(5);
      expect(host.call.mock.calls.filter(([method]) => method === "tools.execute")).toHaveLength(1);
      expect(runtime["agent"].state.messages.at(-1)).toMatchObject({ stopReason: "stop" });
      expect(JSON.stringify(requests.slice(1))).toContain("Keep the completed work.");
      expect(JSON.stringify(requests.slice(1))).not.toContain("withheld-call");
    } finally { await runtime.dispose(); }
  });

  it("bounds persistent malformed responses and recovers when a later manual prompt gets a valid response", async () => {
    const { runtime, requests, events } = fixture((round) => round <= 3
      ? assistant([{ ...call(), name: "" }]) : answer());
    try {
      for (let attempt = 1; attempt <= 3; attempt++) {
        await runtime.prompt("Continue the current task.");
        expect(requests).toHaveLength(attempt);
        expect(runtime.getStatus().isRunning).toBe(false);
      }
      await runtime.prompt("Continue the current task.");
      expect(requests).toHaveLength(4);
      expect(events.filter((event) => event.type === "error")).toHaveLength(3);
      expect(runtime["agent"].state.messages.at(-1)).toMatchObject({ stopReason: "stop" });
    } finally { await runtime.dispose(); }
  });

  it("continues a previously poisoned runtime without replaying completed sibling tools", async () => {
    const { runtime, host, requests } = fixture(answer);
    const completed = assistant([
      { type: "text", text: "Keep this useful response." },
      call("completed-call"), { ...call("bad-call"), name: "" },
    ]);
    const goodResult: AgentMessage = { role: "toolResult", toolCallId: "completed-call", toolName: "Bash",
      content: [{ type: "text", text: "Completed exactly once." }], timestamp: Date.now(), isError: false };
    const badResult: AgentMessage = { ...goodResult, toolCallId: "bad-call", toolName: "", isError: true };
    for (const [id, message] of [["poisoned-assistant", completed], ["completed-call", goodResult], ["bad-call", badResult]] as const) {
      runtime["appendLiveEntry"](id, message);
      runtime["agent"].state.messages.push(message);
    }
    const original = structuredClone(completed);
    try {
      const failures: string[] = [];
      for (let attempt = 0; attempt < 3; attempt++) {
        try { await runtime.prompt("Continue the current task."); }
        catch (error) { failures.push(error instanceof Error ? error.message : String(error)); }
      }
      expect(failures).toEqual([]);
      expect(requests).toHaveLength(3);
      expect(host.call.mock.calls.filter(([method]) => method === "tools.execute")).toHaveLength(0);
      expect(requests[0]).toContainEqual(goodResult);
      expect(JSON.stringify(requests)).toContain("Keep this useful response.");
      expect(JSON.stringify(requests)).not.toContain("bad-call");
      expect(completed).toEqual(original);
    } finally { await runtime.dispose(); }
  });

  it("settles an invalid tool event even when token usage cannot be estimated", async () => {
    const { runtime, events } = fixture(answer);
    try {
      await runtime["handleAgentEvent"]({ type: "tool_execution_start", toolCallId: "bad-call", toolName: "", args: {} });
      await runtime["handleAgentEvent"]({ type: "tool_execution_end", toolCallId: "bad-call", toolName: "",
        result: { content: [{ type: "text", text: "Unknown tool" }], details: {} }, isError: true });
      expect(events).toContainEqual(expect.objectContaining({ type: "tool_end", toolCallId: "bad-call", isError: true }));
    } finally { await runtime.dispose(); }
  });

  it("recovers a compaction tail while preserving system updates and a valid same-id sibling", () => {
    const system: AgentMessage = { role: "system", content: "Keep the host's instructions.", timestamp: 1 };
    const retained = assistant([
      { type: "text", text: "Keep the earlier findings." },
      { ...call("shared|fc_read"), name: "Read", arguments: { path: "notes.txt" } },
      { ...call("shared|fc_bash"), arguments: [] },
    ]);
    const goodResult: AgentMessage = { role: "toolResult", toolCallId: "shared|fc_read", toolName: "Read",
      content: [{ type: "text", text: "Useful evidence." }], timestamp: 2, isError: false };
    const badResult: AgentMessage = { ...goodResult, toolCallId: "shared", toolName: "Bash", isError: true };
    const entry: CompactionEntry = { type: "compaction", id: "compacted", parentId: null, seq: 3, timestamp: 3,
      summary: "Earlier work", tokensBefore: 100, retainedTail: [system, retained, goodResult, badResult], fromHook: false };
    const original = structuredClone(entry);
    const messages = buildSessionContext([entry]).messages;
    expect(messages.map((message) => message.role)).toEqual(["compactionSummary", "system", "assistant", "toolResult"]);
    expect(messages).toContain(system);
    expect(messages).toContain(goodResult);
    expect(messages).not.toContain(badResult);
    expect(messages[2]).toMatchObject({ content: [
      { type: "text", text: "Keep the earlier findings." },
      { type: "toolCall", id: "shared|fc_read", name: "Read" },
    ] });
    expect(() => validateHostedSearchMessages(convertToLlm(messages))).not.toThrow();
    expect(entry).toEqual(original);
  });

  it("keeps a later completed execution that reuses a rejected call's identity", () => {
    const invalid = assistant([{ ...call("reused|fc_bad"), arguments: [] }]);
    const valid = assistant([call("reused|fc_good")]);
    const result: AgentMessage = { role: "toolResult", toolCallId: "reused", toolName: "Bash",
      content: [{ type: "text", text: "Completed." }], timestamp: 2, isError: false };
    expect(recoverMalformedToolCalls([invalid, { ...result, isError: true }, valid, result])).toEqual([valid, result]);
  });

  it("keeps unrelated malformed context subject to strict validation", () => {
    const messages = [assistant([{ type: "hostedSearch", phase: "web_search_call" }, call()])];
    expect(recoverMalformedToolCalls(messages)).toBe(messages);
    expect(() => validateHostedSearchMessages(messages)).toThrow("Local request context validation failed");
  });
});
