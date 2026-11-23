import { describe, expect, it } from "vitest";
import type {
  AgentMessage,
} from "@earendil-works/pi-agent-core";
import type { CompactionEntry, MessageEntry } from "./pi-runtime-types.js";
import { convertToLlm } from "./pi-runtime-messages.js";
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

  it("drops assistants that have no content blocks", () => {
    // D446: an accepted silent completion reply, or any other empty
    // assistant, is not worth resending and would be rejected by providers.
    const empty = assistant("a1", "", 1);
    (empty.message as { content: unknown[] }).content = [];
    const messages = buildSessionContext([
      user("u1", "notice", 0),
      empty,
      user("u2", "next", 2),
      assistant("a2", "answer", 3),
    ]).messages;
    expect(messages.map((message) => message.role)).toEqual(["user", "user", "assistant"]);
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

  it("sends the active request before the checkpoint and a new user message after it", () => {
    const original = user("u1", "This is an empty project", 1);
    const entry = compaction("c1", 3, [original.message]);
    entry.summary = "Setup is complete. Verify the homepage.";
    entry.details = { retainedTailMode: "active_turn" };

    const resumed = convertToLlm(buildSessionContext([original, entry]).messages);
    expect(resumed.map((message) => message.role)).toEqual(["user", "user"]);
    expect(resumed[0]).toMatchObject({ content: "This is an empty project" });
    expect(resumed[1]).toMatchObject({
      content: [{ type: "text", text: expect.stringContaining(
        "checkpoint is newer than the original request above",
      ) }],
    });
    expect(JSON.stringify(resumed[1])).toContain(entry.summary);

    const saved = JSON.parse(JSON.stringify(entry)) as CompactionEntry;
    const next = user("u2", "Change direction", 4);
    const reopened = convertToLlm(buildSessionContext([original, saved, next]).messages);
    expect(reopened.slice(0, 2)).toEqual(resumed);
    expect(reopened[2]).toMatchObject({ role: "user", content: "Change direction" });
  });

  it("keeps the recovery notice before a fallback's sole retained user message", () => {
    const original = user("u1", "Set up the empty project", 1);
    const entry = compaction("c1", 3, [original.message]);
    entry.summary = "The summary request failed. Continue from the recent messages below.";
    entry.details = {
      fallback: "retained_tail",
      retainedTailMode: "active_turn",
      retainedTailShape: "recent_window",
    };

    const request = convertToLlm(buildSessionContext([original, entry]).messages);
    expect(request).toEqual([
      expect.objectContaining({
        role: "user",
        content: [{ type: "text", text: expect.stringContaining(entry.summary) }],
      }),
      original.message,
    ]);
    expect(JSON.stringify(request[0])).not.toContain("first unchecked step");
  });

  it("does not add resume framing to completed or empty checkpoints", () => {
    const completed = compaction("c1", 2);
    completed.details = { retainedTailMode: "completed_turn" };
    const empty = compaction("c2", 3, [user("u1", "original", 1).message]);
    empty.details = { retainedTailMode: "active_turn" };
    empty.summary = "";
    for (const entry of [completed, empty]) {
      const request = convertToLlm(buildSessionContext([entry]).messages);
      expect(JSON.stringify(request)).not.toContain("checkpoint is newer");
      expect(JSON.stringify(request[0])).toContain("was compacted into the following summary");
    }
  });

  it("replays retained reasoning between the summary and the user tail", () => {
    // #296
    const keptUser = user("u2", "keep me", 3).message;
    const entry = compaction("c1", 2, [keptUser]);
    entry.details = {
      retainedTailMode: "active_turn",
      retainedReasoning: [{ thinking: "prior plan", text: "prior answer" }],
    };
    const messages = buildSessionContext([
      user("u0", "old", 0),
      assistant("a0", "old answer", 1),
      entry,
      user("u3", "next", 3),
    ]).messages;
    expect(messages.map((message) => message.role)).toEqual([
      "compactionSummary",
      "assistant",
      "user",
      "user",
    ]);
    expect(JSON.stringify(messages)).toContain("prior plan");
    expect(JSON.stringify(messages)).toContain("keep me");
    expect(JSON.stringify(messages)).not.toContain("old answer");
  });

  it("does not replay DeepSeek reasoning into a different provider", () => {
    const keptUser = user("u2", "keep me", 3).message;
    const entry = compaction("c1", 2, [keptUser]);
    entry.details = {
      retainedReasoning: [{ thinking: "prior DeepSeek plan", text: "answer" }],
    };
    const messages = buildSessionContext(
      [entry, user("u3", "next", 4)],
      {
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-opus-4-6",
        requiresCompletionsReasoningReplay: false,
      },
    ).messages;
    expect(messages.map((message) => message.role)).toEqual([
      "compactionSummary",
      "user",
      "user",
    ]);
    expect(JSON.stringify(messages)).not.toContain("prior DeepSeek plan");
  });

});
