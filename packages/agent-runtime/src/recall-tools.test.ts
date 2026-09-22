import { describe, expect, it } from "vitest";
import {
  buildRecallProjectTool,
  buildRecallTool,
  RECALL_MAX_MATCHES,
  RECALL_MAX_OUTPUT_CHARS,
  recallAnswerText,
  type RecallHost,
} from "./recall-tools.js";

/**
 * A host adapter that records every call, so a test can assert what the tool
 * asked for — not only what it printed. `replies` maps a method to its answer.
 */
function fakeHost(
  replies: Record<string, unknown> = {},
): RecallHost & { calls: Array<{ method: string; params: Record<string, unknown> }> } {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  return {
    sessionId: "session-1",
    calls,
    call: async (method, params) => {
      calls.push({ method, params });
      if (method in replies) {
        const value = replies[method];
        if (value instanceof Error) throw value;
        return value;
      }
      throw new Error(`unexpected host call: ${method}`);
    },
  };
}

/** Run one tool and return its single text payload. */
async function runText(
  tool: { execute?: unknown },
  params: Record<string, unknown>,
): Promise<string> {
  const execute = (tool as { execute: (id: string, p: unknown) => Promise<unknown> })
    .execute;
  const result = (await execute("call-1", params)) as {
    content: Array<{ text: string }>;
  };
  return result.content.map((block) => block.text).join("");
}

describe("recall tool", () => {
  it("searches this session and says what it matched", async () => {
    const host = fakeHost({
      "session.recall": {
        hits: [
          { id: "m3", role: "user", createdAt: "2026-09-08T00:00:00Z", index: 3, snippet: "retry budget" },
        ],
        totalMessages: 12,
      },
    });
    const text = await runText(buildRecallTool(host), { query: "retry budget" });

    expect(host.calls).toEqual([
      { method: "session.recall", params: { sessionId: "session-1", query: "retry budget", limit: 10 } },
    ]);
    expect(text).toContain("1 of 12 messages match");
    expect(text).toContain("(id: m3)");
    expect(text).toContain("retry budget");
  });

  it("teaches the query rule instead of answering a paraphrase with nothing", async () => {
    const host = fakeHost({
      "session.recall": { hits: [], totalMessages: 40 },
    });
    const text = await runText(buildRecallTool(host), {
      query: "how did we fix the retry problem",
    });

    expect(text).toContain("No message in this session contains every word");
    expect(text).toContain("as they were written");
    expect(text).toContain("unspaced Chinese");
  });

  it("asks for a query or an id rather than calling the host blind", async () => {
    const host = fakeHost();
    const text = await runText(buildRecallTool(host), {});
    expect(text).toContain("Provide either `query`");
    expect(host.calls).toHaveLength(0);
  });

  it("reads one message by id and states where the next page starts", async () => {
    const host = fakeHost({
      "session.readMessage": {
        messageId: "m9",
        role: "tool",
        createdAt: "2026-09-08T00:00:01Z",
        index: 9,
        totalChars: 10_000,
        offset: 0,
        text: "head of the tool result",
        hasMore: true,
        nextOffset: 8_000,
      },
    });
    const text = await runText(buildRecallTool(host), { messageId: "m9" });

    expect(host.calls[0]?.method).toBe("session.readMessage");
    expect(host.calls[0]?.params).toMatchObject({ sessionId: "session-1", messageId: "m9", offset: 0 });
    expect(text).toContain("characters 0–8000 of 10000");
    expect(text).toContain('call recall again with messageId "m9" and offset 8000');
  });

  it("reports a host failure as text instead of throwing at the model", async () => {
    const host = fakeHost({ "session.recall": new Error("host offline") });
    const text = await runText(buildRecallTool(host), { query: "anything" });
    expect(text).toContain("recall failed: host offline");
  });

  it("caps the answer and says the cap was reached", () => {
    const hits = Array.from({ length: RECALL_MAX_MATCHES }, (_value, index) => ({
      id: `m${index}`,
      role: "user",
      createdAt: "2026-09-08T00:00:00Z",
      index,
      snippet: "x".repeat(4_000),
    }));
    const text = recallAnswerText({ hits, totalMessages: 99 }, "x");
    expect(text.length).toBeLessThanOrEqual(RECALL_MAX_OUTPUT_CHARS + 200);
    expect(text).toContain("output truncated");
  });
});

describe("recall_project tool", () => {
  it("refuses when the session has no project instead of guessing a scope", async () => {
    const host = fakeHost();
    const text = await runText(buildRecallProjectTool(host, undefined), { query: "anything" });
    expect(text).toContain("no project path");
    expect(host.calls).toHaveLength(0);
  });

  it("scopes a search to this project and reports one row per session", async () => {
    const host = fakeHost({
      "search.query": {
        hits: [
          {
            sessionId: "s-2",
            sessionTitle: "earlier session",
            messageId: "m7",
            role: "user",
            snippet: "spinner plan",
            createdAt: "2026-09-07T00:00:00Z",
          },
        ],
      },
    });
    const text = await runText(buildRecallProjectTool(host, "C:/work/alpha"), {
      query: "spinner",
    });

    expect(host.calls[0]).toEqual({
      method: "search.query",
      params: { query: "spinner", limit: 10, projectPath: "C:/work/alpha" },
    });
    expect(text).toContain("earlier session (sessionId: s-2)");
    expect(text).toContain("1 session(s) of this project match");
    expect(text).toContain("Read one back with recall_project and its sessionId");
  });

  it("pages a project session backwards with beforeSeq", async () => {
    const host = fakeHost({
      "session.readProject": {
        sessionId: "s-2",
        sessionTitle: "earlier session",
        total: 40,
        hasMore: true,
        messages: [
          { id: "m5", seq: 5, role: "user", text: "older", createdAt: "2026-09-07T00:00:00Z" },
          { id: "m6", seq: 6, role: "tool", text: "row", createdAt: "2026-09-07T00:00:01Z", toolName: "Read", truncated: true },
        ],
      },
    });
    const text = await runText(buildRecallProjectTool(host, "C:/work/alpha"), {
      sessionId: "s-2",
    });

    expect(host.calls[0]?.method).toBe("session.readProject");
    expect(text).toContain("[seq 6] tool");
    expect(text).toContain("[truncated row; read it by id]");
    expect(text).toContain("beforeSeq=5");
  });

  it("reads one project message by id through the project scope", async () => {
    const host = fakeHost({
      "session.readMessage": {
        messageId: "m6",
        role: "tool",
        createdAt: "2026-09-07T00:00:01Z",
        index: 6,
        totalChars: 9_000,
        offset: 0,
        text: "the whole tool result",
        hasMore: false,
        nextOffset: 9_000,
      },
    });
    const text = await runText(buildRecallProjectTool(host, "C:/work/alpha"), {
      sessionId: "s-2",
      messageId: "m6",
    });

    expect(host.calls[0]?.params).toMatchObject({
      sessionId: "s-2",
      messageId: "m6",
      projectPath: "C:/work/alpha",
    });
    expect(text).toContain("the whole tool result");
    expect(text).not.toContain("more of this message remains");
  });
});
