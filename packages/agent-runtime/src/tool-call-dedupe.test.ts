import { describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { transformMessages } from "@earendil-works/pi-ai/api/transform-messages";
import {
  dedupeToolCallMessages,
  reportDuplicateToolCallDrop,
} from "./tool-call-dedupe.js";

/** Only the fields the guard reads: the role, the blocks, and the call id. */
function assistantMessage(content: unknown[]): AgentMessage {
  return { role: "assistant", content, timestamp: 1 } as unknown as AgentMessage;
}

function text(value: string) {
  return { type: "text", text: value };
}

function toolCall(id: string, name = "Read") {
  return { type: "toolCall", id, name, arguments: {} };
}

function toolResult(toolCallId: string, value = "ok"): AgentMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "Read",
    content: [text(value)],
    isError: false,
    timestamp: 2,
  } as unknown as AgentMessage;
}

function callIds(messages: AgentMessage[]): string[] {
  return messages.flatMap((message) =>
    message.role === "assistant"
      ? ((message as { content: unknown[] }).content ?? [])
          .filter(
            (block): block is { type: string; id: string } =>
              typeof block === "object" &&
              block !== null &&
              (block as { type?: string }).type === "toolCall",
          )
          .map((block) => block.id)
      : [],
  );
}

function resultIds(messages: AgentMessage[]): string[] {
  return messages
    .filter((message) => message.role === "toolResult")
    .map((message) => (message as { toolCallId?: string }).toolCallId ?? "");
}

describe("dedupeToolCallMessages", () => {
  it("returns the request view unchanged when every call id is unique", () => {
    const messages = [
      assistantMessage([text("reading"), toolCall("call-1")]),
      toolResult("call-1"),
      assistantMessage([text("done")]),
    ];

    const drop = dedupeToolCallMessages(messages);

    expect(drop.messages).toBe(messages);
    expect(drop.droppedCount).toBe(0);
    expect(drop.droppedMessages).toBe(0);
    expect(drop.droppedIds).toEqual([]);
  });

  it("drops a replayed round as one snapshot and one duplicate result", () => {
    // The shape production hit: pi's loop appends the streamed assistant
    // message and its tool result to the context it was handed, while its own
    // `message_end` listener appends the same objects to the session state, so
    // one round reached the next turn as two copies of each (D620). The
    // assistant message carries text *and* a call, so dropping only the call
    // block would leave a text-only clone between the call and its result.
    const assistant = assistantMessage([
      text("reading the file"),
      toolCall("call-1|item-1"),
    ]);
    const result = toolResult("call-1|item-1");

    const drop = dedupeToolCallMessages([assistant, assistant, result, result]);

    expect(drop.droppedCount).toBe(2);
    expect(drop.droppedMessages).toBe(1);
    expect(drop.droppedIds).toEqual(["call-1"]);
    // One call, then the result that answers it: nothing sits between them.
    expect(drop.messages).toHaveLength(2);
    expect(drop.messages[0]).toBe(assistant);
    expect(drop.messages[1]).toBe(result);
    expect(callIds(drop.messages)).toEqual(["call-1|item-1"]);
    expect(resultIds(drop.messages)).toEqual(["call-1|item-1"]);
  });

  it("treats ids that differ only after the separator as one call", () => {
    // Only the part before the separator reaches the provider as `call_id`, so
    // two entries whose item half differs still collide on the wire.
    const assistant = assistantMessage([toolCall("call-1|item-1")]);

    const drop = dedupeToolCallMessages([
      assistant,
      toolResult("call-1|item-2"),
      toolResult("call-1|item-3"),
    ]);

    expect(drop.droppedCount).toBe(1);
    expect(drop.droppedMessages).toBe(0);
    expect(drop.messages).toHaveLength(2);
    // The surviving result answers the call under the call's own composite id,
    // so pi-ai pairs them instead of synthesizing a second output for the id.
    expect(resultIds(drop.messages)).toEqual(["call-1|item-1"]);
  });

  it("keeps a new call in a message that also replays an older one", () => {
    const first = assistantMessage([text("first"), toolCall("call-1")]);
    const second = assistantMessage([
      text("second"),
      toolCall("call-1"),
      toolCall("call-2"),
    ]);

    const drop = dedupeToolCallMessages([
      first,
      second,
      toolResult("call-1"),
      toolResult("call-2"),
    ]);

    expect(drop.droppedCount).toBe(1);
    expect(drop.droppedMessages).toBe(0);
    // Only the replayed block goes: the message also carries a new call, so it
    // stays, and the guard does not reorder messages to close the gap the
    // dropped call leaves behind. No writer reaches this partial replay today —
    // the runtime's own duplication repeats a message whole, which is the case
    // dropped whole above.
    expect(drop.messages.map((message) => message.role)).toEqual([
      "assistant",
      "assistant",
      "toolResult",
      "toolResult",
    ]);
    expect(callIds(drop.messages)).toEqual(["call-1", "call-2"]);
    expect(resultIds(drop.messages)).toEqual(["call-1", "call-2"]);
  });

  it("leaves a call whose result never arrived to pi-ai's placeholder", () => {
    const messages = [assistantMessage([toolCall("call-1")])];

    expect(dedupeToolCallMessages(messages).messages).toBe(messages);
  });

  it("reports the wire ids and how many messages it removed", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      reportDuplicateToolCallDrop("session-1", {
        messages: [],
        droppedCount: 2,
        droppedMessages: 1,
        droppedIds: ["call-1"],
      });
      const line = stderr.mock.calls.map(([chunk]) => String(chunk)).join("");
      expect(line).toContain(
        "dropped 2 duplicate tool call entries (1 replayed message)",
      );
      expect(line).toContain("session=session-1");
      expect(line).toContain("ids=call-1");
    } finally {
      stderr.mockRestore();
    }
  });
});

/**
 * The failure this guard exists for is invisible in the runtime's own view of a
 * request: pi-ai synthesizes the second output inside its provider transform,
 * after the point a scripted provider can capture. Driving that transform is
 * what pins the mechanism the endpoint rejects (D620).
 */
describe("request wire contract (D620)", () => {
  /** Only the fields the transform reads for a non-normalizing API. */
  const model = {
    api: "openai-completions",
    id: "test-model",
    provider: "test",
    input: ["text"],
  } as never;

  /** Every output the provider would validate for this request. */
  function wireOutputIds(messages: AgentMessage[]): string[] {
    return transformMessages(messages as never, model)
      .filter((message) => message.role === "toolResult")
      .map((message) => String((message as { toolCallId?: string }).toolCallId));
  }

  it("answers a call the request separates from its result twice", () => {
    // The shape production sent: the replayed clone of the assistant message
    // sits between the call and the result answering it, so the transform
    // closes the call it can no longer see answered — `Duplicate tool output
    // for call_id`.
    const call = assistantMessage([text("reading"), toolCall("call-1")]);
    const clone = assistantMessage([text("reading")]);

    expect(wireOutputIds([call, clone, toolResult("call-1")])).toEqual([
      "call-1",
      "call-1",
    ]);
  });

  it("answers a replayed round once after the guard drops it whole", () => {
    const call = assistantMessage([text("reading"), toolCall("call-1")]);
    const replay = assistantMessage([text("reading"), toolCall("call-1")]);

    const drop = dedupeToolCallMessages([
      call,
      replay,
      toolResult("call-1"),
      toolResult("call-1"),
    ]);

    expect(drop.droppedMessages).toBe(1);
    expect(wireOutputIds(drop.messages)).toEqual(["call-1"]);
  });
});
