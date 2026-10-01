import { describe, expect, it } from "vitest";
import type { AgentEventEnvelope, UiMessage } from "@pi-desktop/shared";
import { TurnEventPipeline } from "./turn-events.js";

for (const delegate of [false, true]) {
  describe(`nested tool persistence (${delegate ? "delegate" : "root"})`, () => {
    it("retains tool nesting without changing Task ownership", async () => {
      const written: Array<{ message: UiMessage; turnId: string }> = [];
      const emitted: AgentEventEnvelope[] = [];
      const finished: string[] = [];
      const pipeline = new TurnEventPipeline({
        getHost: () => ({
          async call<T>(method: string, params: unknown): Promise<T> {
            if (method === "session.appendMessage") {
              written.push(params as { message: UiMessage; turnId: string });
            }
            return {} as T;
          },
        }),
        ownership: {
          activeTurnId: () => "turn-1",
          isStaleTerminalEvent: () => false,
          finishTurn: async (sessionId) => { finished.push(sessionId); },
        },
        emit: (event) => emitted.push(event),
        log: () => undefined,
      });
      const lineage = {
        nestedParentToolCallId: "code-1",
        ...(delegate ? { parentToolCallId: "task-1", agentName: "reader" } : {}),
      };
      pipeline.handle({
        sessionId: "s", turnId: "turn-1", ts: 1_000, ...lineage,
        event: { type: "tool_start", toolCallId: "read-1", toolName: "Read", args: { path: "a.ts" } },
      });
      pipeline.handle({
        sessionId: "s", turnId: "turn-1", ts: 1_100, ...lineage,
        event: { type: "tool_end", toolCallId: "read-1", result: "contents" },
      });
      await pipeline.dispose();
      expect(written).toHaveLength(1);
      expect(written[0]?.turnId).toBe("turn-1");
      expect(written[0]?.message).toMatchObject({ toolCallId: "read-1", ...lineage });
      expect(written[0]?.message.parentToolCallId).toBe(delegate ? "task-1" : undefined);
      expect(finished).toEqual([]);
      const completed = emitted.find((envelope) => envelope.event.type === "message_end");
      expect(completed?.nestedParentToolCallId).toBe("code-1");
      expect(completed?.parentToolCallId).toBe(delegate ? "task-1" : undefined);
    });
  });
}


describe("usage ledger ingress", () => {
  it("unions child reports and parent aggregates, replays idempotently, and isolates late turns", async () => {
    const writes: Array<{ method: string; params: unknown }> = [];
    const pipeline = new TurnEventPipeline({
      getHost: () => ({ async call<T>(method: string, params: unknown): Promise<T> {
        writes.push({ method, params }); return {} as T;
      } }),
      ownership: { activeTurnId: () => "new-turn", isStaleTerminalEvent: () => false, finishTurn: async () => undefined },
      emit: () => undefined, log: () => undefined,
    });
    const child = { operationId: "request-child", usageOrigin: "pi" as const, inputTokens: 10, outputTokens: 2, totalTokens: 12 };
    const classifier = { ...child, operationId: "classifier" };
    const event = { sessionId: "s", turnId: "new-turn", parentToolCallId: "task-1", nestedParentToolCallId: "code-1", ts: 1,
      event: { type: "usage" as const, usage: child } };
    pipeline.handle(event);
    pipeline.handle(event);
    pipeline.handle({ ...event, event: { type: "message_end", message: { id: "child", role: "assistant", content: "done", createdAt: "2026-09-30", usage: child } } });
    pipeline.handle({ sessionId: "s", turnId: "new-turn", ts: 2, event: { type: "turn_end", subagentUsage: {
      inputTokens: 20, outputTokens: 4, totalTokens: 24, aggregation: "aggregate", operations: [child, classifier],
    } } });
    pipeline.handle({ ...event, turnId: "old-turn", event: { type: "usage", usage: { ...child, operationId: "late" } } });
    expect(pipeline.takeTurnUsage("s")?.totalTokens).toBe(24);
    await pipeline.dispose();
    expect(writes.filter((write) => write.method === "session.recordUsage")).toHaveLength(5);
    expect(writes.at(-1)?.params).toMatchObject({ turnId: "old-turn", usage: { operationId: "late" } });
  });
});
