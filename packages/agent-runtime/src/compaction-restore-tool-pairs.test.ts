import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentEventEnvelope, ContextCompactionRecord, UiMessage } from "@pi-desktop/shared";
import { DesktopAgentRuntime } from "./runtime.js";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { captureAssistantProviderReplay } from "./assistant-provider-replay.js";

const timestamp = "2026-11-13T00:00:00.000Z";
const history: UiMessage[] = [
  { id: "user", role: "user", content: "Read the two files", createdAt: timestamp, status: "complete" },
  { id: "assistant", role: "assistant", content: "Reading files", createdAt: timestamp, status: "complete" },
  ...["a", "b"].map((id): UiMessage => ({
    id: `tool-${id}`, role: "tool", content: `contents of ${id}`,
    createdAt: timestamp, status: "complete", toolCallId: `call-${id}`,
    toolName: "Read", toolArgs: { path: `${id}.txt` },
    toolResult: { content: `contents of ${id}` }, toolStatus: "success",
  })),
];

type WireMessage = {
  role: string;
  content?: unknown;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
};

function orphanResult(messages: WireMessage[]): string | undefined {
  let pending = new Set<string>();
  for (const message of messages) {
    if (message.role === "tool") {
      if (!message.tool_call_id || !pending.delete(message.tool_call_id)) return message.tool_call_id ?? "missing-id";
    } else {
      pending = new Set(message.tool_calls?.map(call => call.id) ?? []);
    }
  }
  return undefined;
}

afterEach(() => vi.unstubAllGlobals());

describe("restored compaction boundaries preserve tool pairs (#2306)", () => {
  it("preserves function-call signatures when a compacted carrier must be rebuilt", async () => {
    const stored = structuredClone(history);
    stored[1]!.providerReplay = captureAssistantProviderReplay([
      { type: "text", text: stored[1]!.content },
      ...["a", "b"].map(id => ({ type: "toolCall" as const, id: `call-${id}`, name: "Read",
        arguments: { path: `${id}.txt` }, thoughtSignature: Buffer.from(`signature-${id}`).toString("base64") })),
    ]);
    const requests: Array<{ contents: Array<{ role: string; parts: Array<Record<string, unknown>> }> }> = [];
    vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)));
      return new Response(`data: ${JSON.stringify({ candidates: [{ index: 0,
        content: { role: "model", parts: [{ text: "Done: restored context accepted." }] }, finishReason: "STOP",
      }] })}\n\n`, { headers: { "content-type": "text/event-stream" } });
    });
    const runtime = new DesktopAgentRuntime({
      sessionId: "signed-restore", mode: "agent", thinkingLevel: "off", history: stored,
      compaction: { id: "checkpoint", throughMessageId: "assistant", summary: "Earlier file work",
        retainedTail: [], tokensBefore: 100, createdAt: timestamp },
      provider: { id: "google", name: "Google", vendorKey: "google", modelId: "gemini-3.8-flash",
        apiStyle: "google_generative_ai", baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        apiKey: "fixture-only", supportsReasoning: false, supportedThinkingLevels: ["off"] },
      commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
      host: { async call<T>(method: string): Promise<T> {
        if (method === "tools.fileBatchCapabilities") return { version: 1, supported: false } as T;
        if (method === "session.appendMessage") return undefined as T;
        throw new Error(`Unexpected Host call: ${method}`);
      } },
      onEvent: () => {},
    });
    try {
      await runtime.prompt("Continue using the file contents.");
      expect(requests).toHaveLength(1);
      const calls = requests[0]!.contents.flatMap(message => message.parts).filter(part => part.functionCall);
      expect(calls.map(part => part.thoughtSignature)).toEqual([
        Buffer.from("signature-a").toString("base64"), Buffer.from("signature-b").toString("base64"),
      ]);
    } finally { await runtime.dispose(); }
  });

  it.each([
    { throughMessageId: "assistant" },
    { throughMessageId: "tool-a" },
    { throughMessageId: "tool-b" },
    { throughMessageId: undefined },
    { throughMessageId: "missing-boundary" },
    { throughMessageId: "assistant", withRetainedCall: true },
    { throughMessageId: "assistant", emptyAssistant: true },
  ])(
    "continues from $throughMessageId with retained call $withRetainedCall",
    async ({ throughMessageId, withRetainedCall, emptyAssistant }) => {
      const requests: WireMessage[][] = [];
      vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
        const { messages } = JSON.parse(String(init?.body)) as { messages: WireMessage[] };
        requests.push(messages);
        if (orphanResult(messages)) return new Response(JSON.stringify({ error: {
          message: "Messages with role 'tool' must be a response to a preceding message with 'tool_calls'",
          type: "invalid_request_error",
        } }), { status: 400, headers: { "content-type": "application/json" } });
        return new Response(`data: ${JSON.stringify({ choices: [{ index: 0,
          delta: { content: "Done: restored context accepted." }, finish_reason: "stop",
        }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
      });
      const events: AgentEventEnvelope[] = [];
      const retainedCall: AgentMessage = {
        role: "assistant", api: "openai-completions", provider: "fixture", model: "fixture",
        content: ["a", "b"].map(id => ({ type: "toolCall" as const, id: `call-${id}`, name: "Read", arguments: { path: `${id}.txt` } })),
        stopReason: "toolUse", timestamp: 1,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      const checkpoint: ContextCompactionRecord | undefined = throughMessageId ? {
        id: "checkpoint", summary: "Earlier file work", throughMessageId,
        firstKeptMessageId: "user", retainedTail: withRetainedCall ? [retainedCall] : [], tokensBefore: 100,
        details: { retainedTailMode: "completed_turn", ...(withRetainedCall ? { retainedTailShape: "recent_window" } : {}) }, createdAt: timestamp,
      } : undefined;
      const originalHistory = structuredClone(history);
      if (emptyAssistant) originalHistory[1]!.content = "";
      const storedHistory = structuredClone(originalHistory);
      const hostCalls: string[] = [];
      const runtime = new DesktopAgentRuntime({
        sessionId: "restored-session", mode: "agent", thinkingLevel: "off",
        history: originalHistory, compaction: checkpoint,
        provider: {
          id: "fixture", name: "Fixture", modelId: "fixture", apiKey: "fixture",
          apiStyle: "chat_completions", baseUrl: "https://fixture.invalid/v1",
          supportsReasoning: false, supportedThinkingLevels: ["off"],
        },
        commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
        host: { async call<T>(method: string): Promise<T> {
          hostCalls.push(method);
          if (method === "tools.fileBatchCapabilities") return { version: 1, supported: false } as T;
          if (method === "session.appendMessage") return undefined as T;
          throw new Error(`Unexpected Host call: ${method}`);
        } },
        onEvent: event => events.push(event),
      });
      try {
        await runtime.prompt("Continue using the file contents.");
        await runtime.prompt("Report once more.");
        expect(events.filter(({ event }) => event.type === "error")).toEqual([]);
        expect(requests).toHaveLength(2);
        for (const messages of requests) {
          expect(orphanResult(messages)).toBeUndefined();
          if (throughMessageId && throughMessageId !== "missing-boundary") {
            expect(JSON.stringify(messages)).toContain("Earlier file work");
            expect(JSON.stringify(messages)).not.toContain("Read the two files");
          }
          const expectedIds = throughMessageId === "tool-b" ? []
            : throughMessageId === "tool-a" ? ["call-b"] : ["call-a", "call-b"];
          expect(messages.filter(message => message.role === "tool").map(message => message.tool_call_id)).toEqual(expectedIds);
          for (const id of expectedIds) {
            expect(messages.flatMap(message => message.tool_calls ?? []).find(call => call.id === id)?.function).toEqual({
              name: "Read", arguments: JSON.stringify({ path: `${id.slice(-1)}.txt` }),
            });
          }
        }
        expect(hostCalls).not.toContain("tools.execute");
        expect(originalHistory).toEqual(storedHistory);
      } finally { await runtime.dispose(); }
    },
  );
});
