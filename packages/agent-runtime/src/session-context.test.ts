import { describe, expect, it } from "vitest";
import type {
  AgentMessage,
  CompactionEntry,
  MessageEntry,
} from "@earendil-works/pi-agent-core";
import { buildSessionContext } from "./session-context.js";

function user(id: string, text: string, seq: number): MessageEntry {
  return {
    type: "message",
    id,
    parentId: null,
    seq,
    timestamp: seq,
    message: { role: "user", content: text, timestamp: seq },
  };
}

function assistant(
  id: string,
  text: string,
  seq: number,
  stopReason: "stop" | "error" | "aborted" = "stop",
): MessageEntry {
  return {
    type: "message",
    id,
    parentId: null,
    seq,
    timestamp: seq,
    message: {
      role: "assistant",
      api: "openai-completions",
      provider: "local",
      model: "local",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason,
      timestamp: seq,
      content: [{ type: "text", text }],
    } as AgentMessage,
  };
}

function compaction(
  id: string,
  seq: number,
  tail: AgentMessage[] = [],
): CompactionEntry {
  return {
    type: "compaction",
    id,
    parentId: null,
    seq,
    timestamp: seq,
    summary: "older work",
    tokensBefore: 100,
    retainedTail: tail,
    fromHook: false,
  };
}

describe("buildSessionContext", () => {
  it("passes message entries through and drops failed assistants", () => {
    const messages = buildSessionContext([
      user("u1", "hello", 0),
      assistant("a1", "failed", 1, "error"),
      assistant("a2", "ok", 2),
    ]).messages;
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(
      messages[1] && "content" in messages[1]
        ? (messages[1].content as { text?: string }[])[0]?.text
        : undefined,
    ).toBe("ok");
  });

  it("slices from the newest compaction and puts the summary before the tail", () => {
    const keptUser = user("u2", "keep me", 3).message;
    const messages = buildSessionContext([
      user("u0", "old", 0),
      assistant("a0", "old answer", 1),
      compaction("c1", 2, [keptUser]),
      user("u3", "next", 3),
    ]).messages;
    expect(messages.map((message) => message.role)).toEqual([
      "compactionSummary",
      "user",
      "user",
    ]);
    expect(JSON.stringify(messages)).toContain("older work");
    expect(JSON.stringify(messages)).toContain("keep me");
    expect(JSON.stringify(messages)).toContain("next");
    expect(JSON.stringify(messages)).not.toContain("old answer");
  });
});
