import { describe, expect, it } from "vitest";
import { responsesAnswerText, splitResponsesCommentary } from "./responses-message-phase.js";
import type { AssistantProviderReplay } from "./types/messages.js";

const signature = (phase: string) => JSON.stringify({ v: 1, id: `msg_${phase}`, phase });
const replay = (...blocks: AssistantProviderReplay["blocks"]): AssistantProviderReplay => ({ version: 1, blocks });

describe("splitResponsesCommentary", () => {
  it("removes every marked commentary range and keeps the answer", () => {
    const content = "Checking.Still checking.Answer B.";
    const split = splitResponsesCommentary(content, replay(
      { type: "text", length: 9, signature: signature("commentary") },
      { type: "thinking", length: 40 },
      { type: "text", length: 15, signature: signature("commentary") },
      { type: "text", length: 9, signature: signature("final_answer") },
    ));
    expect(split).toEqual({
      commentary: [{ offset: 0, text: "Checking." }, { offset: 9, text: "Still checking." }],
      answer: "Answer B.",
    });
    expect(responsesAnswerText(content, replay(
      { type: "text", length: 24, signature: signature("commentary") },
      { type: "text", length: 9 },
    ))).toBe("Answer B.");
  });

  it("leaves unmarked, opaque, or partially described content untouched", () => {
    const content = "Checking. Answer B.";
    expect(splitResponsesCommentary(content, undefined)).toBeUndefined();
    expect(splitResponsesCommentary(content, replay({ type: "text", length: 19, signature: "opaque" }))).toBeUndefined();
    // An abbreviated row no longer matches its replay lengths.
    expect(splitResponsesCommentary(content, replay(
      { type: "text", length: 9, signature: signature("commentary") },
      { type: "text", length: 4 },
    ))).toBeUndefined();
    expect(responsesAnswerText(content, undefined)).toBe(content);
  });

  it("reports a commentary-only message as an empty answer", () => {
    expect(responsesAnswerText("Checking.", replay(
      { type: "text", length: 9, signature: signature("commentary") },
    ))).toBe("");
  });
});
