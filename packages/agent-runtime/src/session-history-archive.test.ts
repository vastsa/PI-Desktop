import type { ContextCompactionRecord, UiMessage } from "@pi-desktop/shared";
import { describe, expect, it, vi } from "vitest";

import { DesktopAgentRuntime } from "./runtime.js";

import { readArchivedSessionHistory as restoreSessionHistory } from "./session-history-archive.js";

const createdAt = "2026-10-08T00:00:00Z";
const row = (id: string, role: UiMessage["role"] = "assistant", content = id): UiMessage => ({
  id, role, content, createdAt, status: "complete",
});
const checkpoint = (id: string, throughMessageId: string): ContextCompactionRecord => ({
  id, throughMessageId, createdAt, summary: `Résumé ${id} 🧭`, tokensBefore: 123,
});
const attachmentContext = { supportsVision: false };

type Request = { id: string; messageLimit: number; messageBefore?: number };

function historyHost(
  rows: UiMessage[],
  options: {
    maxPage?: number;
    maxBytes?: number;
    compaction?: ContextCompactionRecord;
    afterFirstPage?: () => void;
  } = {},
) {
  const requests: Request[] = [];
  return {
    requests,
    async call<T>(method: string, request: Request): Promise<T> {
      expect(method).toBe("session.get");
      expect(request.id).toBe("session-1");
      expect(request.messageLimit).toBeGreaterThan(0);
      expect(request).not.toHaveProperty("contentLimit");
      requests.push(request);
      const messageEnd = Math.min(request.messageBefore ?? rows.length, rows.length);
      const messageStart = Math.max(0, messageEnd - Math.min(request.messageLimit, options.maxPage ?? Infinity));
      const selected = rows.slice(messageStart, messageEnd);
      if (Buffer.byteLength(JSON.stringify(selected)) > (options.maxBytes ?? Infinity)) {
        throw Object.assign(new Error("response is too large"), { data: { errorCode: "LIMIT_EXCEEDED" } });
      }
      // First appearance controls position and the latest payload wins, as in host-core.
      const messages = [...new Map(selected.map((message) => [message.id, message])).values()];
      const session = { messages, messageStart, messageEnd, hasMoreBefore: messageStart > 0, compaction: options.compaction };
      if (requests.length === 1) options.afterFirstPage?.();
      return { session } as T;
    },
  };
}

describe("cold session history restoration", () => {
  it("fixes the physical tail and preserves checkpoint boundaries, tool data and old delegation rows", async () => {
    const task: UiMessage = { ...row("task", "tool"), toolCallId: "chain-call", toolName: "Task", toolArgs: { task: "inspect" } };
    const delegate: UiMessage = { ...row("delegate"), parentToolCallId: "chain-call", agentName: "reviewer" };
    const carrier = row("carrier");
    const result: UiMessage = { ...row("tool", "tool", "旧結果 😉"), toolCallId: "read-call", toolName: "Read", toolResult: { text: "日本語 🧪" } };
    const original = row("repeated", "assistant", "old content");
    const latest = row("repeated", "assistant", "new content 😀");
    const prompt = row("current", "user", "continue");
    const previousPrompt = row("earlier", "user", prompt.content);
    const rows = [previousPrompt, original, task, delegate, carrier, result, latest, prompt];
    const active = checkpoint("checkpoint", carrier.id);
    const settings = {
      maxPage: 3,
      compaction: active,
      afterFirstPage() {
        rows.push(row("later"));
        settings.compaction = checkpoint("newer-checkpoint", "later");
      },
    };
    const host = historyHost(rows, settings);
    const restored = await restoreSessionHistory(host, "session-1", {
      attachmentContext, currentPrompt: prompt.content, userMessageId: prompt.id,
    });
    expect(restored).toEqual({ history: [previousPrompt, latest, task, delegate, carrier, result], compaction: active });
    expect(host.requests.map(({ messageBefore }) => messageBefore)).toEqual([undefined, 5, 2]);
  });

  it("sends the checkpoint, a tool pair split across pages, and the current prompt once on cold resume", async () => {
    const prompt = row("current-prompt", "user", "Continue with the file 🧭");
    const old = row("old-user", "user", "Work already covered by checkpoint");
    const carrier = row("carrier", "assistant", "Reading the file");
    const result: UiMessage = {
      ...row("result", "tool", "日本語の結果 🧪"), toolCallId: "read-call", toolName: "Read",
      toolArgs: { path: "fixture.txt" }, toolResult: { content: "日本語の結果 🧪" },
    };
    const compaction = checkpoint("active-checkpoint", carrier.id);
    const pages = historyHost([old, carrier, result, prompt], { maxPage: 2, compaction });
    const restored = await restoreSessionHistory(pages, "session-1", {
      attachmentContext, currentPrompt: prompt.content, userMessageId: prompt.id,
    });
    const requests: Array<Array<{ role: string; content?: unknown; tool_call_id?: string; tool_calls?: Array<{ id: string }> }>> = [];
    vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)).messages);
      return new Response(`data: ${JSON.stringify({ choices: [{ index: 0,
        delta: { content: "Cold request fixture accepted" }, finish_reason: "stop",
      }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
    });
    const runtime = new DesktopAgentRuntime({
      ...restored,
      sessionId: "session-1", mode: "agent", thinkingLevel: "off",
      provider: {
        id: "fixture", name: "Fixture", modelId: "fixture", apiKey: "fixture",
        apiStyle: "chat_completions", baseUrl: "https://fixture.invalid/v1",
        supportsReasoning: false, supportedThinkingLevels: ["off"],
      },
      commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
      host: { async call<T>(method: string): Promise<T> {
        if (method === "tools.fileBatchCapabilities") return { version: 1, supported: false } as T;
        if (method === "session.appendMessage") return undefined as T;
        throw new Error(`Unexpected Host call: ${method}`);
      } },
      onEvent: () => {},
    });
    try {
      await runtime.prompt(prompt.content);
      expect(requests).toHaveLength(1);
      const messages = requests[0]!;
      const request = JSON.stringify(messages);
      expect(request).toContain(compaction.summary);
      expect(request).not.toContain(old.content);
      expect(request.split(prompt.content)).toHaveLength(2);
      const toolIndex = messages.findIndex((message) => message.role === "tool");
      expect(toolIndex).toBeGreaterThan(0);
      expect(messages[toolIndex]).toMatchObject({ tool_call_id: result.toolCallId });
      expect(JSON.stringify(messages[toolIndex])).toContain(result.content);
      expect(messages[toolIndex - 1]?.tool_calls).toEqual([expect.objectContaining({ id: result.toolCallId })]);
    } finally {
      try { await runtime.dispose(); } finally { vi.unstubAllGlobals(); }
    }
  });

  it("restores uncheckpointed Unicode history losslessly after reducing oversized pages", async () => {
    const rows = Array.from({ length: 30 }, (_, index) => row(`m${index}`, "assistant", "雪👋".repeat(90)));
    const host = historyHost(rows, { maxBytes: 2_000 });
    await expect(restoreSessionHistory(host, "session-1", { attachmentContext })).resolves.toEqual({ history: rows });
    expect(host.requests[1].messageLimit).toBeLessThan(host.requests[0].messageLimit);
    expect(host.requests.at(-1)?.messageBefore).toBeGreaterThan(0);
  });

  it("explains a single unsendable page without retrying forever or returning partial context", async () => {
    const host = historyHost([row("m1", "assistant", "雪".repeat(1_000)), row("newest")], { maxBytes: 400 });
    await expect(restoreSessionHistory(host, "session-1", { attachmentContext })).rejects.toMatchObject({
      errorCode: "LIMIT_EXCEEDED", message: expect.stringMatching(/history.*single.message/i),
    });
    const singleReads = host.requests.filter(({ messageLimit }) => messageLimit === 1);
    expect(singleReads.map(({ messageBefore }) => messageBefore)).toEqual([undefined, 1]);
  });

  it("fails on a shortened history rather than skipping a cursor range", async () => {
    const rows = [row("m1"), row("m2"), row("m3")];
    const host = historyHost(rows, { maxPage: 1, afterFirstPage: () => { rows.length = 1; } });
    await expect(restoreSessionHistory(host, "session-1", { attachmentContext })).rejects.toMatchObject({ errorCode: "INTERNAL" });
  });

  it("preserves the legacy tail exclusion without mistaking an automatic prompt for a user row", async () => {
    const last = row("latest-user", "user", "continue");
    const older = row("older-user", "user", last.content);
    await expect(restoreSessionHistory(historyHost([older, last]), "session-1", {
      attachmentContext, currentPrompt: last.content,
    })).resolves.toEqual({ history: [older] });
    await expect(restoreSessionHistory(historyHost([older, last]), "session-1", {
      attachmentContext, currentPrompt: last.content, hostStartedTurn: true,
    })).resolves.toEqual({ history: [older, last] });
  });
});
