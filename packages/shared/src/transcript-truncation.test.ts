import { describe, expect, it } from "vitest";
import { resolveTranscriptTruncation } from "./transcript-truncation.js";

const transcript = [
  { id: "m0" },
  { id: "m1" },
  { id: "m2" },
  { id: "m3" },
];

describe("resolveTranscriptTruncation", () => {
  it("resolves the boundary by message identity", () => {
    expect(
      resolveTranscriptTruncation(transcript, { truncateFromMessageId: "m2" }),
    ).toEqual({ kind: "cut", index: 2 });
  });

  it("ignores a stale count when an identity is given", () => {
    // This is the regression: the renderer used to send
    // `messageStart + userIndex`, which addressed a different message whenever
    // its window was not the whole history.
    expect(
      resolveTranscriptTruncation(transcript, {
        truncateFromMessageId: "m3",
        truncateBefore: 1,
      }),
    ).toEqual({ kind: "cut", index: 3 });
  });

  it("reports an unknown boundary instead of guessing one", () => {
    expect(
      resolveTranscriptTruncation(transcript, {
        truncateFromMessageId: "gone",
        truncateBefore: 1,
      }),
    ).toEqual({ kind: "unknown-message", messageId: "gone" });
  });

  it("still accepts a count from older callers", () => {
    expect(resolveTranscriptTruncation(transcript, { truncateBefore: 2 })).toEqual({
      kind: "cut",
      index: 2,
    });
    // A count past the end cuts nothing rather than throwing.
    expect(resolveTranscriptTruncation(transcript, { truncateBefore: 99 })).toEqual({
      kind: "cut",
      index: 4,
    });
  });

  it("treats a missing or invalid request as no truncation", () => {
    expect(resolveTranscriptTruncation(transcript, {})).toEqual({ kind: "none" });
    expect(
      resolveTranscriptTruncation(transcript, { truncateBefore: -1 }),
    ).toEqual({ kind: "none" });
    expect(
      resolveTranscriptTruncation(transcript, { truncateFromMessageId: "  " }),
    ).toEqual({ kind: "none" });
  });
});
