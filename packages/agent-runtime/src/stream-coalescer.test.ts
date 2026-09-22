import { describe, expect, it, vi } from "vitest";
import type { AgentEventEnvelope, UiMessage } from "@pi-desktop/shared";
import { applyMessageUpdate, streamingMessageIdentity } from "@pi-desktop/shared";
import { createStreamCoalescer } from "./stream-coalescer.js";

function assistant(partial: Partial<UiMessage> & Pick<UiMessage, "id" | "content">): UiMessage {
  return {
    role: "assistant",
    createdAt: "2026-01-01T00:00:00.000Z",
    status: "streaming",
    ...partial,
  };
}

function envelope(
  event: AgentEventEnvelope["event"],
  extra: Partial<AgentEventEnvelope> = {},
): AgentEventEnvelope {
  return { sessionId: "s1", ts: 1, event, ...extra };
}

describe("createStreamCoalescer", () => {
  it("concatenates deltas and flushes them before a semantic boundary", () => {
    const emitted: AgentEventEnvelope[] = [];
    const coalescer = createStreamCoalescer((item) => emitted.push(item), {
      intervalMs: 16,
      schedule: () => () => {},
    });
    const live = assistant({ id: "m1", content: "Hel" });
    coalescer.push(
      envelope({
        type: "message_update",
        message: assistant({ id: "m1", content: "Hel" }),
        deltaText: "Hel",
      }),
    );
    coalescer.push(
      envelope({
        type: "message_update",
        message: assistant({ id: "m1", content: "Hello" }),
        deltaText: "lo",
      }),
    );
    coalescer.push(envelope({ type: "tool_start", toolCallId: "t1", toolName: "read", args: {} }));

    expect(emitted.map((item) => item.event.type)).toEqual(["message_update", "tool_start"]);
    const update = emitted[0]!.event;
    expect(update).toMatchObject({
      type: "message_update",
      stream: "delta",
      deltaText: "Hello",
    });
    if (update.type !== "message_update") throw new Error("expected update");
    expect(update.message.content).toBe("");
    expect(applyMessageUpdate(streamingMessageIdentity(live), update).content).toBe("Hello");
    coalescer.dispose();
  });

  it("does not reorder a later message_end behind a pending delta", () => {
    const emitted: AgentEventEnvelope[] = [];
    const coalescer = createStreamCoalescer((item) => emitted.push(item), {
      intervalMs: 16,
      schedule: () => () => {},
    });
    coalescer.push(
      envelope({
        type: "message_update",
        message: assistant({ id: "m1", content: "Hi" }),
        deltaText: "Hi",
      }),
    );
    coalescer.push(
      envelope({
        type: "message_end",
        message: assistant({ id: "m1", content: "Hi", status: "complete" }),
      }),
    );
    expect(emitted.map((item) => item.event.type)).toEqual(["message_update", "message_end"]);
    coalescer.dispose();
  });

  it("keeps parent and subagent streams on separate keys", () => {
    const emitted: AgentEventEnvelope[] = [];
    const coalescer = createStreamCoalescer((item) => emitted.push(item), {
      intervalMs: 0,
    });
    coalescer.push(
      envelope({
        type: "message_update",
        message: assistant({ id: "parent", content: "P" }),
        deltaText: "P",
      }),
    );
    coalescer.push(
      envelope(
        {
          type: "message_update",
          message: assistant({ id: "child", content: "C" }),
          deltaText: "C",
        },
        { parentToolCallId: "task-1" },
      ),
    );
    expect(emitted).toHaveLength(2);
    expect(emitted[0]!.event).toMatchObject({ deltaText: "P" });
    expect(emitted[1]!.event).toMatchObject({ deltaText: "C" });
    expect(emitted[1]!.parentToolCallId).toBe("task-1");
    coalescer.dispose();
  });

  it("passes snapshot replacements through without slimming", () => {
    const emitted: AgentEventEnvelope[] = [];
    const coalescer = createStreamCoalescer((item) => emitted.push(item));
    const snapshot = assistant({ id: "m1", content: "retry body" });
    coalescer.push(envelope({ type: "message_update", message: snapshot }));
    expect(emitted[0]!.event).toEqual({ type: "message_update", message: snapshot });
    coalescer.dispose();
  });

  it("flushes on the scheduled interval", () => {
    vi.useFakeTimers();
    const emitted: AgentEventEnvelope[] = [];
    const coalescer = createStreamCoalescer((item) => emitted.push(item), {
      intervalMs: 16,
    });
    coalescer.push(
      envelope({
        type: "message_update",
        message: assistant({ id: "m1", content: "a" }),
        deltaText: "a",
      }),
    );
    expect(emitted).toHaveLength(0);
    vi.advanceTimersByTime(16);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.event).toMatchObject({ stream: "delta", deltaText: "a" });
    coalescer.dispose();
    vi.useRealTimers();
  });
});
