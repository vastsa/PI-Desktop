import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  COMPACTION_MAX_KEEP_RECENT_TOKENS,
  COMPACTION_MIN_KEEP_RECENT_TOKENS,
  COMPACTION_RETAINED_USER_MESSAGE_MAX_TOKENS,
  contextBudgetFor,
  contextBudgetLimitsFor,
  retainedUserMessageBudget,
} from "./context-budget.js";
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
} from "./provider-binding.js";

describe("contextBudgetFor", () => {
  it("derives the hard limit from provider-request headroom", () => {
    // The numbers the session runtime's own compaction tests assert against.
    expect(contextBudgetFor({ contextWindow: 256_000, maxTokens: 32_000 }, []))
      .toEqual({
        tokens: 0,
        hardLimit: 224_000,
        requestHeadroom: 32_000,
        keepRecentTokens: 44_800,
      });
  });

  it("clamps the retained tail for a small model context window", () => {
    // A 32K window cannot spare 20% for the tail: the half-budget clamp wins,
    // which lands exactly on the minimum rather than below it.
    expect(contextBudgetLimitsFor({ contextWindow: 32_000, maxTokens: 8_000 }))
      .toEqual({
        hardLimit: 16_000,
        requestHeadroom: 16_000,
        keepRecentTokens: 8_000,
      });
  });

  it("holds the reserve floor on a 64K window", () => {
    // The 25% cap keeps a 64K window's output budget at 16_000, just under the
    // reserve floor, so the floor is what the headroom settles on.
    expect(contextBudgetLimitsFor({ contextWindow: 64_000, maxTokens: 16_000 }))
      .toEqual({
        hardLimit: 47_616,
        requestHeadroom: 16_384,
        keepRecentTokens: 9_523,
      });
  });

  it("falls back to the package defaults when the model reports no window", () => {
    const budget = contextBudgetLimitsFor({});
    const fallback = contextBudgetLimitsFor({
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      maxTokens: DEFAULT_MAX_TOKENS,
    });

    expect(budget).toEqual(fallback);
    expect(budget.hardLimit).toBe(111_616);
    expect(budget.requestHeadroom).toBe(16_384);
    expect(budget.keepRecentTokens).toBe(22_323);
  });

  it("caps the retained tail on a very large window", () => {
    const budget = contextBudgetLimitsFor({
      contextWindow: 1_048_576,
      maxTokens: 64_000,
    });

    expect(budget.hardLimit).toBe(984_576);
    // Without the cap a 1M window would carry ~197K tokens forward.
    expect(budget.keepRecentTokens).toBe(COMPACTION_MAX_KEEP_RECENT_TOKENS);
  });

  it("never lets the retained tail exceed half of the hard limit", () => {
    for (const contextWindow of [
      1, 100, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 200_000, 256_000,
      1_048_576, 2_000_000,
    ]) {
      const budget = contextBudgetLimitsFor({ contextWindow });

      expect(budget.hardLimit).toBeGreaterThan(0);
      // A one-token window is degenerate: it can reserve nothing and still has
      // to leave a positive limit behind, so headroom may legitimately be zero.
      expect(budget.requestHeadroom).toBeGreaterThanOrEqual(0);
      expect(budget.requestHeadroom).toBeLessThan(contextWindow);
      expect(budget.keepRecentTokens).toBeGreaterThan(0);
      expect(budget.keepRecentTokens).toBeLessThanOrEqual(
        Math.max(1, Math.floor(budget.hardLimit * 0.5)),
      );
      expect(budget.keepRecentTokens).toBeLessThanOrEqual(
        COMPACTION_MAX_KEEP_RECENT_TOKENS,
      );
      // The minimum only applies while half the budget can still cover it.
      if (budget.hardLimit * 0.5 >= COMPACTION_MIN_KEEP_RECENT_TOKENS) {
        expect(budget.keepRecentTokens).toBeGreaterThanOrEqual(
          COMPACTION_MIN_KEEP_RECENT_TOKENS,
        );
      }
    }
  });

  it("counts the estimated tokens of the supplied context", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "count these tokens", timestamp: 1 },
    ];

    const empty = contextBudgetFor({ contextWindow: 256_000 }, []);
    const filled = contextBudgetFor({ contextWindow: 256_000 }, messages);

    expect(empty.tokens).toBe(0);
    expect(filled.tokens).toBeGreaterThan(0);
    // Only `tokens` depends on the messages; the thresholds are window-derived.
    expect({ ...filled, tokens: 0 }).toEqual(empty);
  });
});

describe("retainedUserMessageBudget", () => {
  it("uses the flat cap when the budget can afford it", () => {
    expect(retainedUserMessageBudget({ hardLimit: 224_000 })).toBe(
      COMPACTION_RETAINED_USER_MESSAGE_MAX_TOKENS,
    );
  });

  it("clamps against half of the hard limit on a small window", () => {
    expect(retainedUserMessageBudget({ hardLimit: 16_000 })).toBe(8_000);
    expect(retainedUserMessageBudget({ hardLimit: 2_000 })).toBe(1_000);
  });

  it("stays positive when half the budget rounds to zero", () => {
    expect(retainedUserMessageBudget({ hardLimit: 1 })).toBe(1);
  });
});
