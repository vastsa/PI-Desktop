import { describe, expect, it } from "vitest";

import { buildLiveWorkClassifierInput } from "./context.js";

const snapshot = {
  sessionId: "session-1",
  mode: "agent" as const,
  state: "running" as const,
  activeTurnId: "turn-1",
  queue: [],
  observedAt: 1,
};

describe("buildLiveWorkClassifierInput", () => {
  it("never includes transcript or prior voice input while sharing is disabled", () => {
    const result = JSON.parse(buildLiveWorkClassifierInput({
      candidate: { instruction: "Check the login path" },
      snapshot,
      contextEnabled: false,
      recentMessages: [
        { role: "user", content: "typed secret" },
        { role: "assistant", content: "prior voice task", voiceOrigin: { callId: "c", operationId: "o" } },
      ],
    })) as Record<string, unknown>;

    expect(result).toEqual({
      request: "Check the login path",
      workState: { mode: "agent", state: "running", activeTurn: true, queuedCount: 0 },
    });
    expect(JSON.stringify(result)).not.toContain("typed secret");
    expect(JSON.stringify(result)).not.toContain("prior voice task");
  });

  it("shares only bounded plain user and assistant text when explicitly enabled", () => {
    const result = JSON.parse(buildLiveWorkClassifierInput({
      candidate: { instruction: "Check the login path" },
      snapshot,
      contextEnabled: true,
      recentMessages: [
        { role: "user", content: "plain question" },
        { role: "assistant", content: "plain answer" },
        { role: "tool", content: "tool log", toolName: "Read" },
        { role: "user", content: "voice task", voiceOrigin: { callId: "c", operationId: "o" } },
        { role: "user", content: "attachment row", attachments: [{ kind: "file", name: "x", ref: "x" }] },
      ],
    })) as { recentContext?: Array<{ role: string; text: string }> };

    expect(result.recentContext).toEqual([
      { role: "user", text: "plain question" },
      { role: "assistant", text: "plain answer" },
    ]);
  });

  it("drops recent context rather than truncating the spoken request", () => {
    const request = "x".repeat(8 * 1024);
    const serialized = buildLiveWorkClassifierInput({
      candidate: { instruction: request },
      snapshot,
      contextEnabled: true,
      recentMessages: [{ role: "user", content: "y".repeat(6 * 1024) }],
    });

    expect(new TextEncoder().encode(serialized).byteLength).toBeLessThanOrEqual(12 * 1024);
    expect(JSON.parse(serialized)).toMatchObject({ request });
    expect(JSON.parse(serialized).recentContext).toBeUndefined();
  });

  it("includes only the latest eight call-scoped operation status facts", () => {
    const recentOperations = Array.from({ length: 10 }, (_, index) => ({
      operationId: `operation-${index}`,
      admission: "accepted" as const,
      execution: index === 9 ? "completed" as const : "running" as const,
    }));
    const result = JSON.parse(buildLiveWorkClassifierInput({
      candidate: { instruction: "What was the latest result?" },
      snapshot,
      contextEnabled: false,
      recentOperations,
    })) as { recentOperations?: Array<{ operationId: string; admission: string; execution: string }> };

    expect(result.recentOperations).toHaveLength(8);
    expect(result.recentOperations?.[0]?.operationId).toBe("operation-2");
    expect(result.recentOperations?.at(-1)).toEqual({
      operationId: "operation-9",
      admission: "accepted",
      execution: "completed",
    });
  });

  it("passes bounded opaque selection references without project paths", () => {
    const selections = Array.from({ length: 20 }, (_, index) => ({
      selectionRef: `opaque-ref-${index}`,
      kind: "project" as const,
      action: "none" as const,
      label: `Project ${index}`,
    }));
    const serialized = buildLiveWorkClassifierInput({
      candidate: { instruction: "List projects" },
      snapshot,
      contextEnabled: false,
      recentOperations: [{ operationId: "operation-list", admission: "accepted", execution: "not-started", selections }],
    });
    expect(new TextEncoder().encode(serialized).byteLength).toBeLessThanOrEqual(12 * 1024);
    expect(JSON.parse(serialized).availableSelections).toEqual(selections);
    expect(serialized).not.toContain("/Users/");
  });
});
