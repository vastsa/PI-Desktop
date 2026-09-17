import { describe, expect, it } from "vitest";
import type { UiMessage } from "./types/messages.js";
import {
  SESSION_REFERENCE_BLOCK_HEADING,
  SESSION_REFERENCE_INSTRUCTION,
  SESSION_REFERENCE_REQUEST_HEADING,
  attachSessionReferenceSnapshots,
  collectSessionReferenceIds,
  estimateSessionReferenceTokens,
  expandSessionReferences,
  pairCompletedQaTurns,
  stripSessionReferencePrompt,
} from "./session-reference.js";

const THINKING_MARKER = "SECRET_THINKING_MARKER";
const TOOL_MARKER = "SECRET_TOOL_MARKER";
const SUBAGENT_MARKER = "SECRET_SUBAGENT_MARKER";

function message(partial: Partial<UiMessage> & Pick<UiMessage, "role" | "content">): UiMessage {
  return {
    id: partial.id ?? crypto.randomUUID(),
    createdAt: partial.createdAt ?? "2026-09-16T00:00:00.000Z",
    status: "complete",
    ...partial,
  };
}

describe("estimateSessionReferenceTokens", () => {
  it("computes conservative ceil(UTF-8 bytes / 3)", () => {
    expect(estimateSessionReferenceTokens("")).toBe(0);
    expect(estimateSessionReferenceTokens("abc")).toBe(1);
    expect(estimateSessionReferenceTokens("abcd")).toBe(2);
    // 3 UTF-8 bytes per Chinese character -> 3 bytes / 3 = 1 token
    expect(estimateSessionReferenceTokens("你好")).toBe(2);
  });
});

describe("pairCompletedQaTurns", () => {
  it("keeps user questions and final assistant answers, dropping thinking and tools", () => {
    const turns = pairCompletedQaTurns([
      message({ role: "user", content: "How should the pool work?" }),
      message({
        role: "assistant",
        content: "Use a bounded pool.",
        thinking: THINKING_MARKER,
      }),
      message({
        role: "tool",
        content: "",
        toolName: "Read",
        toolResult: TOOL_MARKER,
      }),
      message({ role: "user", content: "And timeouts?" }),
      message({ role: "assistant", content: "Fail closed after 30s." }),
    ]);
    expect(turns).toEqual([
      { question: "How should the pool work?", answer: "Use a bounded pool." },
      { question: "And timeouts?", answer: "Fail closed after 30s." },
    ]);
    const serialized = JSON.stringify(turns);
    expect(serialized).not.toContain(THINKING_MARKER);
    expect(serialized).not.toContain(TOOL_MARKER);
  });

  it("skips nested subagent rows and joins completed progress answers", () => {
    const turns = pairCompletedQaTurns([
      message({ role: "user", content: "How do I use this?" }),
      message({ role: "assistant", content: "Looking at the docs." }),
      message({ role: "tool", content: "", toolResult: TOOL_MARKER }),
      message({
        role: "assistant",
        content: SUBAGENT_MARKER,
        parentToolCallId: "call_1",
      }),
      message({
        role: "assistant",
        content: "Full usage guide.",
        thinking: THINKING_MARKER,
      }),
      message({ role: "assistant", content: "Researcher addendum." }),
    ]);
    expect(turns).toEqual([
      {
        question: "How do I use this?",
        answer: "Looking at the docs.\n\nFull usage guide.\n\nResearcher addendum.",
      },
    ]);
    const serialized = JSON.stringify(turns);
    expect(serialized).not.toContain(THINKING_MARKER);
    expect(serialized).not.toContain(TOOL_MARKER);
    expect(serialized).not.toContain(SUBAGENT_MARKER);
  });

  it("nonemptyfailed statuses: excludes aborted, error, and streaming assistant rows even if nonempty", () => {
    const turns = pairCompletedQaTurns([
      message({ role: "user", content: "Q1" }),
      message({ role: "assistant", content: "Progress message", status: "complete" }),
      message({ role: "assistant", content: "Aborted answer", status: "aborted" }),
      message({ role: "assistant", content: "Error answer", status: "error" }),
      message({ role: "assistant", content: "Streaming partial", status: "streaming" }),
      message({ role: "assistant", content: "Final answer", status: "complete" }),
    ]);
    expect(turns).toEqual([
      { question: "Q1", answer: "Progress message\n\nFinal answer" },
    ]);
  });

  it("emptyuser: empty user with attachments gives placeholder; truly empty closes previous and resets question", () => {
    const turns = pairCompletedQaTurns([
      message({ role: "user", content: "OLD_QUESTION" }),
      message({ role: "assistant", content: "OLD_ANSWER" }),
      message({ role: "user", content: "", attachments: [{ name: "pic.png", kind: "image", ref: "pic.png", mimeType: "image/png", size: 100 }] }),
      message({ role: "assistant", content: "NEW_IMAGE_ANSWER" }),
      message({ role: "user", content: "" }), // truly empty user message
      message({ role: "assistant", content: "ORPHAN_AFTER_TRULY_EMPTY" }),
      message({ role: "user", content: "NEXT_QUESTION" }),
      message({ role: "assistant", content: "NEXT_ANSWER" }),
    ]);
    expect(turns).toEqual([
      { question: "OLD_QUESTION", answer: "OLD_ANSWER" },
      { question: "[User message with attachments; attachment contents are not included.]", answer: "NEW_IMAGE_ANSWER" },
      { question: "NEXT_QUESTION", answer: "NEXT_ANSWER" },
    ]);
  });

  it("multiwrap: strips existing reference wrappers per message before joining", () => {
    const nestedRef = attachSessionReferenceSnapshots("NESTED_CURRENT", [
      {
        sessionId: "11111111-1111-4111-8111-111111111111",
        title: "Nested",
        turns: [{ question: "NQ", answer: "NA" }],
      },
    ]);
    const turns = pairCompletedQaTurns([
      message({ role: "user", content: "Outer Q" }),
      message({ role: "assistant", content: nestedRef }),
      message({ role: "assistant", content: "IMPORTANT_ADDENDUM\n## Current request:\nquoted example" }),
    ]);
    expect(turns).toHaveLength(1);
    expect(turns[0].question).toBe("Outer Q");
    expect(turns[0].answer).toBe("NESTED_CURRENT\n\nIMPORTANT_ADDENDUM\n## Current request:\nquoted example");
  });
});

describe("stripSessionReferencePrompt", () => {
  it("returns unadorned prompt untouched", () => {
    expect(stripSessionReferencePrompt("hello world")).toBe("hello world");
    expect(stripSessionReferencePrompt("## Current request:\nquoted")).toBe("## Current request:\nquoted");
  });

  it("structurally strips wrapper with single or multiple blocks", () => {
    const wrapped = [
      SESSION_REFERENCE_BLOCK_HEADING,
      SESSION_REFERENCE_INSTRUCTION,
      "",
      '<referenced-chat id="1" title="T1" turns="1">',
      "Q: q1",
      "A: a1",
      "</referenced-chat>",
      "",
      '<referenced-chat id="2" title="T2" turns="1">',
      "Q: q2",
      "A: a2",
      "</referenced-chat>",
      "",
      SESSION_REFERENCE_REQUEST_HEADING,
      "Please proceed with ## Current request: in my text",
    ].join("\n");

    expect(stripSessionReferencePrompt(wrapped)).toBe("Please proceed with ## Current request: in my text");
  });

  it("rejects malformed wrappers and quote wrappers", () => {
    const malformed = [
      SESSION_REFERENCE_BLOCK_HEADING,
      SESSION_REFERENCE_INSTRUCTION,
      "",
      '<referenced-chat id="1" title="T1">',
      "Unclosed tag",
      "",
      SESSION_REFERENCE_REQUEST_HEADING,
      "Actual text",
    ].join("\n");
    expect(stripSessionReferencePrompt(malformed)).toBe(malformed);

    const quoted = `> ${SESSION_REFERENCE_BLOCK_HEADING}\n> hello`;
    expect(stripSessionReferencePrompt(quoted)).toBe(quoted);
  });
});

describe("attachSessionReferenceSnapshots", () => {
  it("escapes titles and ids with angle brackets, newlines, and quotes", () => {
    const result = attachSessionReferenceSnapshots("go", [
      {
        sessionId: 'test<id>"1"',
        title: 'Title <with>\n"quotes"',
        turns: [{ question: "q", answer: "a" }],
        omittedKnown: 2,
        olderUnread: true,
      },
    ]);
    expect(result).toContain('id="test&lt;id&gt;&quot;1&quot;"');
    expect(result).toContain('title="Title &lt;with&gt; &quot;quotes&quot;"');
    expect(result).toContain('omitted="2"');
    expect(result).toContain('older-unread="true"');
  });

  it("escapes closing tags in turn text without aggregate stripping", () => {
    const result = attachSessionReferenceSnapshots("go", [
      {
        sessionId: "42cf934f-ba75-46e1-84b5-e44bb76eba83",
        title: "Test",
        turns: [{ question: "q", answer: "Here is </referenced-chat> tag" }],
      },
    ]);
    expect(result).toContain("Here is </ referenced-chat> tag");
    expect(result).not.toContain("Here is </referenced-chat> tag");
  });

  it("formats all supplied turns without arbitrary fallback", () => {
    const turns = Array.from({ length: 25 }, (_, i) => ({
      question: `Q${i + 1}`,
      answer: `A${i + 1}`,
    }));
    const result = attachSessionReferenceSnapshots("go", [
      {
        sessionId: "42cf934f-ba75-46e1-84b5-e44bb76eba83",
        title: "Large",
        turns,
      },
    ]);
    expect(result).toContain('turns="25"');
    expect(result).toContain("Q1");
    expect(result).toContain("Q25");
  });
});

describe("expandSessionReferences", () => {
  it("returns stripped content and empty notices when no references are present", async () => {
    const result = await expandSessionReferences("hello world", {
      budgetTokens: 1000,
      loadSession: async () => null,
    });
    expect(result).toEqual({
      content: "hello world",
      missingIds: [],
      notices: [],
      estimatedTokens: 0,
      budgetTokens: 1000,
    });
  });

  it("invalid or zero budget tokens fails closed with blockedReason 'budget'", async () => {
    const id = "42cf934f-ba75-46e1-84b5-e44bb76eba83";
    const result = await expandSessionReferences(`check @session:${id}`, {
      budgetTokens: 0,
      loadSession: async () => null,
    });
    expect(result.blockedReason).toBe("budget");
    expect(result.budgetTokens).toBe(0);
    expect(result.estimatedTokens).toBe(0);
    expect(result.content).toBe(`check @session:${id}`);
  });

  it("missing session reports missingIds", async () => {
    const id = "42cf934f-ba75-46e1-84b5-e44bb76eba83";
    const result = await expandSessionReferences(`check @session:${id}`, {
      budgetTokens: 1000,
      loadSession: async () => null,
    });
    expect(result.missingIds).toEqual([id]);
    expect(result.content).toBe(`check @session:${id}`);
  });

  it("emptyvsunreadsource: truly empty source renders explicit none; 0 turns + unread history blocks 'incomplete'", async () => {
    const idA = "11111111-1111-4111-8111-111111111111";
    const idB = "22222222-2222-4222-8222-222222222222";

    // idA: truly empty, no unread history
    const resA = await expandSessionReferences(`see @session:${idA}`, {
      budgetTokens: 1000,
      loadSession: async () => ({
        id: idA,
        title: "Truly Empty",
        messages: [],
        hasMoreBefore: false,
      }),
    });
    expect(resA.blockedReason).toBeUndefined();
    expect(resA.content).toContain("(No completed question-and-answer turns.)");
    expect(resA.notices[0].includedTurns).toBe(0);

    // idB: 0 complete turns, but unread history exists
    const resB = await expandSessionReferences(`see @session:${idB}`, {
      budgetTokens: 1000,
      loadSession: async () => ({
        id: idB,
        title: "Unread But No Turns Loaded",
        messages: [message({ role: "tool", content: "trace" })],
        hasMoreBefore: true,
      }),
    });
    expect(resB.blockedReason).toBe("incomplete");
    expect(resB.content).toBe(`see @session:${idB}`);
  });

  it("oversizedlatest: newest complete turn exceeding budget blocks with 'budget' and sends no output", async () => {
    const id = "42cf934f-ba75-46e1-84b5-e44bb76eba83";
    const result = await expandSessionReferences(`look at @session:${id}`, {
      budgetTokens: 50, // very tight budget
      loadSession: async () => ({
        id,
        title: "Big Turn",
        messages: [
          message({ role: "user", content: "Big question" }),
          message({ role: "assistant", content: "a".repeat(1000) }),
        ],
      }),
    });
    expect(result.blockedReason).toBe("budget");
    expect(result.content).toBe(`look at @session:${id}`);
  });

  it("actualglobalbudgetoverflow+metadata: metadata alone overflowing budget blocks with 'budget'", async () => {
    const id = "42cf934f-ba75-46e1-84b5-e44bb76eba83";
    const result = await expandSessionReferences(`look at @session:${id}`, {
      budgetTokens: 10, // cannot even fit the wrapper instruction and headers
      loadSession: async () => ({
        id,
        title: "Empty Source",
        messages: [],
        hasMoreBefore: false,
      }),
    });
    expect(result.blockedReason).toBe("budget");
    expect(result.content).toBe(`look at @session:${id}`);
  });

  it(">20turns: can include >20 small turns when budget permits", async () => {
    const id = "42cf934f-ba75-46e1-84b5-e44bb76eba83";
    const turnsCount = 30;
    const messages: UiMessage[] = [];
    for (let i = 0; i < turnsCount; i++) {
      messages.push(message({ role: "user", content: `q${i + 1}` }));
      messages.push(message({ role: "assistant", content: `a${i + 1}` }));
    }
    const result = await expandSessionReferences(`inspect @session:${id}`, {
      budgetTokens: 5000,
      loadSession: async () => ({
        id,
        title: "Many Turns",
        messages,
      }),
    });
    expect(result.blockedReason).toBeUndefined();
    expect(result.notices[0].includedTurns).toBe(30);
    expect(result.content).toContain('turns="30"');
    expect(result.content).toContain("Q: q1");
    expect(result.content).toContain("Q: q30");
  });

  it("round-robin adds older turns without skipping oversized recent turns to pick older smaller ones", async () => {
    const idA = "11111111-1111-4111-8111-111111111111";
    // Session A has:
    // Turn 1 (oldest): tiny (10 chars)
    // Turn 2: huge (3000 chars)
    // Turn 3 (newest): tiny (10 chars)
    const messagesA = [
      message({ role: "user", content: "T1Q" }),
      message({ role: "assistant", content: "tiny 1" }),
      message({ role: "user", content: "T2Q" }),
      message({ role: "assistant", content: "x".repeat(3000) }),
      message({ role: "user", content: "T3Q" }),
      message({ role: "assistant", content: "tiny 3" }),
    ];

    const result = await expandSessionReferences(`diff @session:${idA}`, {
      budgetTokens: 300, // Enough for T3, but not enough for T2
      loadSession: async () => ({
        id: idA,
        title: "A",
        messages: messagesA,
      }),
    });

    expect(result.blockedReason).toBeUndefined();
    expect(result.notices[0].includedTurns).toBe(1);
    expect(result.content).toContain("Q: T3Q");
    // T2 was oversized, so it stopped; must NOT skip T2 to include T1!
    expect(result.content).not.toContain("T1Q");
  });

  it("nestedloadexcluded anddisplaystrip: does not recursively expand mentions in reference material", async () => {
    const nested = "99999999-9999-4999-8999-999999999999";
    const source = "42cf934f-ba75-46e1-84b5-e44bb76eba83";
    const loaded: string[] = [];
    const result = await expandSessionReferences(`use @session:${source}`, {
      budgetTokens: 2000,
      loadSession: async (id) => {
        loaded.push(id);
        return {
          id,
          title: "Source",
          messages: [
            message({
              role: "user",
              content: `earlier @session:${nested}`,
            }),
            message({
              role: "assistant",
              content: "answered",
              thinking: THINKING_MARKER,
            }),
          ],
        };
      },
    });
    expect(loaded).toEqual([source]);
    expect(result.missingIds).toEqual([]);
    expect(result.content).toContain("earlier @session:");
    expect(result.content).toContain("answered");
    expect(result.content).not.toContain(THINKING_MARKER);
    expect(stripSessionReferencePrompt(result.content)).toBe(`use @session:${source}`);
  });
});
