import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContextCompactionRecord, UiMessage } from "@pi-desktop/shared";
import { restoreSessionHistory } from "./session-history-restore.js";
import type { RuntimeProviderConfig } from "./provider-binding.js";
import { DesktopAgentRuntime } from "./runtime.js";

const date = "2026-11-26T00:00:00Z";
const row = (id: string, role: UiMessage["role"] = "assistant"): UiMessage => ({ id, role, content: `text-${id}`, createdAt: date, status: "complete" });
const checkpoint: ContextCompactionRecord = { id: "cp", summary: "Durable summary", throughMessageId: "boundary", retainedTail: [], tokensBefore: 1000, createdAt: date };
afterEach(() => vi.unstubAllGlobals());

describe("bounded active context restore", () => {
  it("requests one bounded context instead of traversing archived pages", async () => {
    const calls: unknown[] = [];
    const host = { async call<T>(method: string, params: Record<string, unknown>): Promise<T> {
      calls.push([method, params]);
      return { session: { messages: [row("boundary"), row("recent"), row("current", "user")], compaction: checkpoint, overflow: false, omittedMessages: 900000, readBytes: 1024 } } as T;
    } };
    const restored = await restoreSessionHistory(host, "session", { currentPrompt: "new", userMessageId: "current", attachmentContext: { supportsVision: false } });
    expect(calls).toEqual([["session.restoreContext", { id: "session", excludeMessageIds: ["current"] }]]);
    expect(restored).toEqual({ history: [row("boundary"), row("recent")], compaction: checkpoint });
  });

  it("surfaces overflow as explicit recovery metadata and keeps a real empty session valid", async () => {
    const restore = (overflow: boolean, messages: UiMessage[]) => restoreSessionHistory({ async call<T>(): Promise<T> {
      return { session: { messages, compaction: checkpoint, overflow, omittedMessages: 100000, readBytes: 2048 } } as T;
    } }, "session", { attachmentContext: { supportsVision: false } });
    await expect(restore(true, [row("recent")])).resolves.toEqual({ history: [row("recent")], recovery: { omittedMessages: 100000, previousSummary: checkpoint.summary } });
    await expect(restore(false, [])).resolves.toEqual({ history: [], compaction: checkpoint });
  });

  it("never hides a missing, corrupt, or malformed restore response", async () => {
    await expect(restoreSessionHistory({ async call<T>(): Promise<T> { return { session: null } as T; } }, "s", { attachmentContext: { supportsVision: false } })).rejects.toMatchObject({ errorCode: "SESSION_NOT_FOUND" });
    await expect(restoreSessionHistory({ async call<T>(): Promise<T> { return { session: { messages: [] } } as T; } }, "s", { attachmentContext: { supportsVision: false } })).rejects.toMatchObject({ errorCode: "INTERNAL" });
    await expect(restoreSessionHistory({ async call<T>(): Promise<T> { throw new Error("Corrupt transcript"); } }, "s", { attachmentContext: { supportsVision: false } })).rejects.toThrow("Corrupt transcript");
  });
});

describe("restore-budget recovery before a model turn", () => {
  const provider: RuntimeProviderConfig = { id: "fixture", name: "Fixture", modelId: "fixture", apiKey: "fixture", apiStyle: "openai-chat", baseUrl: "https://fixture.invalid/v1", supportsReasoning: false, supportedThinkingLevels: ["off"] };

  it.each(["success", "disk-failure", "disabled"] as const)("keeps recovery persistence and model admission ordered: %s", async outcome => {
    const order: string[] = [];
    const wire: string[] = [];
    const saved: ContextCompactionRecord[] = [];
    const events: string[] = [];
    vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
      order.push("provider"); wire.push(String(init?.body));
      return new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
    });
    const runtime = new DesktopAgentRuntime({
      sessionId: "recover", mode: "agent", thinkingLevel: "off", provider,
      history: [row("recent-user", "user"), row("recent-answer")],
      historyRecovery: { omittedMessages: 900000, previousSummary: "Previous verified summary" },
      ...(outcome === "disabled" ? { compactionSettings: { enabled: false, reserveTokens: 0, keepRecentTokens: 0 } } : {}),
      commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
      host: { async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
        if (method === "tools.fileBatchCapabilities") return { version: 1, supported: false } as T;
        if (method === "session.appendCompaction") {
          order.push("checkpoint");
          if (outcome === "disk-failure") throw new Error("Checkpoint disk failure");
          saved.push(params.compaction as ContextCompactionRecord);
        } else if (method !== "session.appendMessage") throw new Error(`Unexpected ${method}`);
        return {} as T;
      } },
      onEvent: envelope => events.push(envelope.event.type),
    });
    try {
      if (outcome === "success") await runtime.prompt("NEW_PROMPT_ONCE");
      else await expect(runtime.prompt("NEW_PROMPT_ONCE")).rejects.toThrow(outcome === "disk-failure" ? "Checkpoint disk failure" : "automatic context recovery is disabled");
      if (outcome === "success") {
        expect(order).toEqual(["checkpoint", "provider"]);
        expect(saved[0]?.details).toMatchObject({ fallback: "retained_tail", failureReason: "restore_budget", omittedMessages: 900000 });
        expect(saved[0]?.throughMessageId).toBe("recent-answer");
        expect(saved[0]?.summary).toContain("not summarized");
        expect(wire[0]).toContain("Previous verified summary");
        expect(wire[0]?.split("NEW_PROMPT_ONCE")).toHaveLength(2);
        expect(events).toContain("compaction_end");
      } else {
        expect(wire).toEqual([]);
        expect(saved).toEqual([]);
      }
    } finally { await runtime.dispose(); }
  });
});
