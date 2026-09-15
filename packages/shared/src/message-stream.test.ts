import { describe, expect, it } from "vitest";
import type { AgentEventEnvelope, UiMessage } from "./types.js";
import {
  applyMessageUpdate,
  cumulativeDelta,
  deltaStreamPayloadFits,
  mergeAgentEventEnvelopes,
  mergeMessageUpdates,
  streamingMessageIdentity,
  toWireMessageUpdate,
} from "./message-stream.js";

function assistant(partial: Partial<UiMessage> & Pick<UiMessage, "id" | "content">): UiMessage {
  return {
    role: "assistant",
    createdAt: "2026-01-01T00:00:00.000Z",
    status: "streaming",
    ...partial,
  };
}

describe("cumulativeDelta", () => {
  it("treats the first chunk as an append, not a reset", () => {
    expect(cumulativeDelta("", "Hel")).toEqual({ delta: "Hel", reset: false });
  });

  it("slices a growing prefix", () => {
    expect(cumulativeDelta("Hel", "Hello")).toEqual({ delta: "lo", reset: false });
  });

  it("resets when the next string is not a prefix", () => {
    expect(cumulativeDelta("Hello", "Hi")).toEqual({ delta: "Hi", reset: true });
  });
});

describe("toWireMessageUpdate / applyMessageUpdate", () => {
  it("omits growing text on the wire and reconstructs it from deltas", () => {
    const body = "x".repeat(4_000);
    const start = assistant({ id: "m1", content: body, thinking: "plan " });
    const snapshot = assistant({
      id: "m1",
      content: `${body}yz`,
      thinking: "plan done",
    });
    const wire = toWireMessageUpdate({
      type: "message_update",
      message: snapshot,
      deltaText: "yz",
      deltaThinking: "done",
    });
    expect(wire.stream).toBe("delta");
    expect(wire.message.content).toBe("");
    expect(wire.message.thinking).toBeUndefined();
    expect(wire.deltaText).toBe("yz");
    expect(wire.deltaThinking).toBe("done");
    expect(JSON.stringify(wire).length).toBeLessThan(JSON.stringify({
      type: "message_update",
      message: snapshot,
    }).length / 2);

    const applied = applyMessageUpdate(start, wire);
    expect(applied.content).toBe(`${body}yz`);
    expect(applied.thinking).toBe("plan done");
    expect(applied.id).toBe("m1");
  });

  it("keeps snapshot updates as replacements", () => {
    const snapshot = assistant({ id: "m1", content: "replaced" });
    const event = { type: "message_update" as const, message: snapshot };
    expect(toWireMessageUpdate(event)).toBe(event);
    expect(applyMessageUpdate(assistant({ id: "m1", content: "old" }), event).content).toBe(
      "replaced",
    );
  });

  it("reset flags replace rather than append", () => {
    const previous = assistant({ id: "m1", content: "Hello", thinking: "old" });
    const next = applyMessageUpdate(previous, {
      type: "message_update",
      stream: "delta",
      message: streamingMessageIdentity(previous),
      deltaText: "Hi",
      resetText: true,
      deltaThinking: "",
      resetThinking: true,
    });
    expect(next.content).toBe("Hi");
    expect(next.thinking).toBeUndefined();
  });
});

describe("mergeMessageUpdates", () => {
  it("concatenates append-only deltas", () => {
    const identity = streamingMessageIdentity(assistant({ id: "m1", content: "" }));
    const merged = mergeMessageUpdates(
      {
        type: "message_update",
        stream: "delta",
        message: identity,
        deltaText: "Hel",
        deltaThinking: "plan",
      },
      {
        type: "message_update",
        stream: "delta",
        message: identity,
        deltaText: "lo",
        deltaThinking: " done",
      },
    );
    expect(merged.deltaText).toBe("Hello");
    expect(merged.deltaThinking).toBe("plan done");
    expect(merged.resetText).toBeUndefined();
  });

  it("lets a later reset replace earlier pending text", () => {
    const identity = streamingMessageIdentity(assistant({ id: "m1", content: "" }));
    const merged = mergeMessageUpdates(
      {
        type: "message_update",
        stream: "delta",
        message: identity,
        deltaText: "Hello",
      },
      {
        type: "message_update",
        stream: "delta",
        message: identity,
        deltaText: "Hi",
        resetText: true,
      },
    );
    expect(merged.deltaText).toBe("Hi");
    expect(merged.resetText).toBe(true);
  });

  it("applies a later delta onto a pending snapshot replacement", () => {
    const snapshot = assistant({ id: "m1", content: "Hello" });
    const merged = mergeMessageUpdates(
      { type: "message_update", message: snapshot },
      {
        type: "message_update",
        stream: "delta",
        message: streamingMessageIdentity(snapshot),
        deltaText: " world",
      },
    );
    expect(merged.stream).toBeUndefined();
    expect(merged.message.content).toBe("Hello world");
  });
});

describe("mergeAgentEventEnvelopes", () => {
  it("keeps the later timestamp and concatenates deltas", () => {
    const identity = streamingMessageIdentity(assistant({ id: "m1", content: "" }));
    const previous: AgentEventEnvelope = {
      sessionId: "s1",
      ts: 1,
      event: {
        type: "message_update",
        stream: "delta",
        message: identity,
        deltaText: "Hel",
      },
    };
    const next: AgentEventEnvelope = {
      sessionId: "s1",
      ts: 2,
      event: {
        type: "message_update",
        stream: "delta",
        message: identity,
        deltaText: "lo",
      },
    };
    const merged = mergeAgentEventEnvelopes(previous, next);
    expect(merged.ts).toBe(2);
    expect(merged.event).toMatchObject({ deltaText: "Hello", stream: "delta" });
  });
});

describe("deltaStreamPayloadFits", () => {
  it("accepts small delta frames without stringifying", () => {
    expect(
      deltaStreamPayloadFits(
        {
          event: {
            type: "message_update",
            stream: "delta",
            message: streamingMessageIdentity(assistant({ id: "m1", content: "" })),
            deltaText: "lo",
          },
        },
        64_000,
      ),
    ).toBe(true);
  });

  it("does not claim a snapshot payload is a small delta", () => {
    expect(
      deltaStreamPayloadFits(
        { event: { type: "message_update", message: assistant({ id: "m1", content: "Hello" }) } },
        64_000,
      ),
    ).toBe(false);
  });
});


it("carries measured TTFT through coalescing and delta application, including zero", () => {
  for (const latency of [0, 1250]) {
    const first = toWireMessageUpdate({
      type: "message_update",
      message: assistant({ id: "timed", content: "a", timeToFirstTokenMs: latency }),
      deltaText: "a",
    });
    const second = toWireMessageUpdate({
      type: "message_update",
      message: assistant({ id: "timed", content: "ab", timeToFirstTokenMs: latency }),
      deltaText: "b",
    });
    const restored = applyMessageUpdate(undefined, mergeMessageUpdates(first, second));
    expect(restored.content).toBe("ab");
    expect(restored.timeToFirstTokenMs).toBe(latency);
    expect(applyMessageUpdate(restored, {
      type: "message_update", message: assistant({ id: "timed", content: "" }),
    }).timeToFirstTokenMs).toBeUndefined();
  }
});
