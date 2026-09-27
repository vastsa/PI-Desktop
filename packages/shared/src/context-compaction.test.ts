import { describe, expect, it } from "vitest";
import type { ContextCompactionRecord } from "./types.js";
import {
  checkpointGeneration,
  checkpointSummarized,
  contextCompactionMark,
  estimateSummaryTokens,
} from "./context-compaction.js";

function record(
  overrides: Partial<ContextCompactionRecord> = {},
): ContextCompactionRecord {
  return {
    id: "checkpoint-1",
    summary: "a".repeat(400),
    throughMessageId: "m9",
    tokensBefore: 120_000,
    createdAt: "2026-08-06T00:00:00.000Z",
    ...overrides,
  };
}

describe("checkpointGeneration", () => {
  it("reads the counter stamped inside the opaque details value", () => {
    expect(checkpointGeneration({ generation: 4 })).toBe(4);
  });

  it("treats a checkpoint without a counter as the first one", () => {
    expect(checkpointGeneration(undefined)).toBe(1);
    expect(checkpointGeneration(null)).toBe(1);
    expect(checkpointGeneration({})).toBe(1);
    expect(checkpointGeneration({ generation: 0 })).toBe(1);
    expect(checkpointGeneration({ generation: "3" })).toBe(1);
    expect(checkpointGeneration("details")).toBe(1);
  });
});

describe("checkpointSummarized", () => {
  it("only the fresh-window family reports an unsummarized rollover", () => {
    expect(checkpointSummarized({ strategy: "fresh_window" })).toBe(false);
    expect(checkpointSummarized({ strategy: "summary" })).toBe(true);
    expect(checkpointSummarized(undefined)).toBe(true);
    expect(checkpointSummarized("details")).toBe(true);
  });
});

describe("contextCompactionMark", () => {
  it("describes one compaction for its transcript row and the inspector", () => {
    expect(contextCompactionMark(record({ details: { generation: 3 } }))).toEqual({
      id: "checkpoint-1",
      throughMessageId: "m9",
      generation: 3,
      summaryTokens: 100,
      summarized: true,
    });
  });

  it("marks a rollover checkpoint as carrying no real summary", () => {
    expect(
      contextCompactionMark(record({ details: { strategy: "fresh_window" } }))
        .summarized,
    ).toBe(false);
  });
});

describe("estimateSummaryTokens", () => {
  it("rounds up so a short summary never estimates to zero", () => {
    expect(estimateSummaryTokens("")).toBe(0);
    expect(estimateSummaryTokens("ab")).toBe(1);
    expect(estimateSummaryTokens("abcde")).toBe(2);
  });
});
