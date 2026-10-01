import { describe, expect, it } from "vitest";
import { usageForEvent, ownsUsageTurn } from "./event-usage.js";
import type { AgentEventEnvelope } from "./types/agent.js";

const operation = {
  operationId: "image-request", usageOrigin: "pi" as const,
  providerId: "account-a", modelId: "image-model",
  inputTokens: 12, outputTokens: 8, totalTokens: 20,
  costStatus: "unknown" as const,
};
function envelope(result: unknown): AgentEventEnvelope {
  return { sessionId: "session", turnId: "old-turn", ts: 1,
    event: { type: "tool_end", toolCallId: "image-tool", result } };
}
describe("tool operation accounting", () => {
  it("counts a physical image request once even when several artifacts expose it", () => {
    const usage = usageForEvent(envelope({ details: { operations: [
      { usage: operation }, { usage: operation },
      { usage: { ...operation, operationId: "second-request" } },
    ] } }));
    expect(usage?.totalTokens).toBe(40);
    expect(usage?.operations).toHaveLength(2);
    expect(usage?.costStatus).toBe("unknown");
    expect(usage?.operations?.[0].providerId).toBe("account-a");
  });
  it("ignores ordinary tool details and unidentifiable usage", () => {
    for (const result of [null, "text", { details: {} }, { details: { operations: [
      null, { usage: { totalTokens: 20 } },
      { usage: { ...operation, inputTokens: "12" } },
    ] } }]) expect(usageForEvent(envelope(result))).toBeUndefined();
  });
  it("does not debit a later active turn for a late image result", () => {
    expect(ownsUsageTurn(envelope({}), "new-turn")).toBe(false);
    expect(ownsUsageTurn(envelope({}), "old-turn")).toBe(true);
    expect(ownsUsageTurn(envelope({}), undefined)).toBe(false);
  });
});

it("ignores invalid counts in provider-supplied tool operations", () => {
  for (const value of [NaN, Infinity, -1, 0.5]) {
    for (const key of ["inputTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens"]) {
      expect(usageForEvent(envelope({ details: { operations: [{ usage: { ...operation, [key]: value } }] } }))).toBeUndefined();
    }
  }
});
