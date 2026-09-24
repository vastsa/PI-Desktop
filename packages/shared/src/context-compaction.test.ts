import { describe, expect, it } from "vitest";
import type { ContextCompactionRecord } from "./types.js";
import {
  checkpointFallback,
  checkpointGeneration,
  compactionRecordId,
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

  it("flags the retained-tail recovery so the row does not present it as a summary", () => {
    const mark = contextCompactionMark(
      record({
        details: {
          generation: 2,
          fallback: "retained_tail",
          failureCode: "CONTEXT_COMPACTION_FAILED",
        },
      }),
    );
    expect(mark.fallback).toBe("retained_tail");
    expect(mark.generation).toBe(2);
    // Any other value stays absent rather than leaking into the event.
    expect(
      contextCompactionMark(record({ details: { fallback: "something_else" } })),
    ).not.toHaveProperty("fallback");
    expect(contextCompactionMark(record({ details: { generation: 1 } }))).not.toHaveProperty(
      "fallback",
    );
  });
});

describe("checkpointFallback", () => {
  it("only recognizes the retained-tail recovery family", () => {
    expect(checkpointFallback({ fallback: "retained_tail" })).toBe("retained_tail");
    expect(checkpointFallback({ fallback: "other" })).toBeUndefined();
    expect(checkpointFallback({})).toBeUndefined();
    expect(checkpointFallback(undefined)).toBeUndefined();
    expect(checkpointFallback("details")).toBeUndefined();
  });
});

describe("estimateSummaryTokens", () => {
  it("rounds up so a short summary never estimates to zero", () => {
    expect(estimateSummaryTokens("")).toBe(0);
    expect(estimateSummaryTokens("ab")).toBe(1);
    expect(estimateSummaryTokens("abcde")).toBe(2);
  });
});

describe("compactionRecordId", () => {
  it("identifies the checkpoint governing the next model request", () => {
    expect(compactionRecordId({ compaction: record({ id: "checkpoint-9" }) })).toBe(
      "checkpoint-9",
    );
  });

  it("reports no identity for a session that never compacted", () => {
    expect(compactionRecordId({ id: "s1" })).toBeNull();
    expect(compactionRecordId({ compaction: null })).toBeNull();
    expect(compactionRecordId(null)).toBeNull();
    expect(compactionRecordId(undefined)).toBeNull();
    expect(compactionRecordId("s1")).toBeNull();
  });

  it("ignores a malformed durable record instead of matching it", () => {
    expect(compactionRecordId({ compaction: {} })).toBeNull();
    expect(compactionRecordId({ compaction: { id: 7 } })).toBeNull();
    expect(compactionRecordId({ compaction: [] })).toBeNull();
  });
});
