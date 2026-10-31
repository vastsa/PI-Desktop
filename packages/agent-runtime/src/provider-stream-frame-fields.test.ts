import { describe, expect, it } from "vitest";
import {
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Model,
} from "@earendil-works/pi-ai";
import { stream as streamAnthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { stream as streamOpenAIResponses } from "@earendil-works/pi-ai/api/openai-responses";

// Exercise real provider stream decoders with omitted empty string fields.
// Pi 1.3 removed the experimental frame codec; Desktop consumes the stream
// events and final message directly. Keep the decoder regression coverage
// without recreating the removed codec or depending on its private behavior.

const context = {
  messages: [
    { role: "system", content: "", timestamp: 1 },
    { role: "user", content: "hi", timestamp: 1 },
  ],
};

const anthropicModel: Model<"anthropic-messages"> = {
  id: "claude-test",
  name: "Claude Test",
  api: "anthropic-messages",
  provider: "acme",
  baseUrl: "https://api.acme.test",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200000,
  maxTokens: 8192,
};

const responsesModel: Model<"openai-responses"> = {
  id: "responses-test",
  name: "Responses Test",
  api: "openai-responses",
  provider: "acme",
  baseUrl: "https://api.acme.test/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 4096,
};

function sse<T extends { type: string }>(events: readonly T[]): string {
  return events
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
}

function fetchReturning(body: string): typeof fetch {
  return (async () =>
    new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })) as unknown as typeof fetch;
}

type Outcome = {
  error: Error | undefined;
  eventTypes: string[];
  frames: AssistantMessageEvent[];
  message?: AssistantMessage;
};

/** Decode the fixture and capture the stream events and final message. */
async function drive(stream: AssistantMessageEventStream): Promise<Outcome> {
  const eventTypes: string[] = [];
  const frames: AssistantMessageEvent[] = [];
  try {
    for await (const event of stream) {
      if (event.type === "text_delta" || event.type === "thinking_delta" || event.type === "toolcall_delta") {
        expect(typeof event.delta).toBe("string");
      }
      eventTypes.push(event.type);
      frames.push(structuredClone(event));
    }
    const message = await stream.result();
    expect(message.stopReason).not.toBe("error");
    expect(JSON.stringify(message.content)).not.toContain("undefined");
    return { error: undefined, eventTypes, frames, message };
  } catch (error) {
    return { error: error as Error, eventTypes, frames };
  }
}

const anthropic = <T extends { type: string }>(events: readonly T[]) =>
  drive(
    streamAnthropic(anthropicModel, context as never, {
      apiKey: "sk-test",
      fetch: fetchReturning(sse(events)),
    }),
  );

const responses = <T extends { type: string }>(events: readonly T[]) =>
  drive(
    streamOpenAIResponses(responsesModel, context as never, {
      apiKey: "sk-test",
      fetch: fetchReturning(sse(events)),
    }),
  );

/** Nonempty decoder deltas, in delivery order. */
function frameDeltas(frames: AssistantMessageEvent[]): string[] {
  return frames.flatMap((frame) =>
    frame.type === "text_delta" ||
    frame.type === "thinking_delta" ||
    frame.type === "toolcall_delta"
      ? typeof frame.delta === "string" && frame.delta.length > 0 ? [frame.delta] : []
      : [],
  );
}

function settledText(frames: AssistantMessageEvent[]): string | undefined {
  for (const frame of frames) {
    if (frame.type === "text_end") return frame.content;
  }
  return undefined;
}

const anthropicHead = [
  {
    type: "message_start",
    message: {
      id: "msg_1",
      role: "assistant",
      model: "claude-test",
      usage: { input_tokens: 5, output_tokens: 0 },
    },
  },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
];

const anthropicTail = [
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
  { type: "message_stop" },
];

const responsesHead = [
  { type: "response.created", sequence_number: 0, response: { id: "resp_1" } },
  {
    type: "response.output_item.added",
    sequence_number: 1,
    output_index: 0,
    item: {
      id: "item_1",
      type: "message",
      role: "assistant",
      content: [],
      status: "in_progress",
    },
  },
];

const responsesCompleted = {
  type: "response.completed",
  sequence_number: 3,
  response: {
    object: "response",
    id: "resp_1",
    created_at: 1,
    model: "responses-test",
    output: [
      {
        id: "item_1",
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "hi" }],
        status: "completed",
      },
    ],
    status: "completed",
    usage: {
      input_tokens: 5,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 2,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 7,
    },
  },
  output_index: 0,
};

describe("provider stream frames with an omitted empty string field (issue #883)", () => {
  describe("Anthropic Messages", () => {
    it("streams a text delta whose field is present", async () => {
      const outcome = await anthropic([
        ...anthropicHead,
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
        ...anthropicTail,
      ]);

      expect(outcome.error).toBeUndefined();
      expect(frameDeltas(outcome.frames)).toEqual(["hi"]);
      expect(settledText(outcome.frames)).toBe("hi");
    });

    it("drops a text delta whose field the upstream omitted", async () => {
      const outcome = await anthropic([
        ...anthropicHead,
        { type: "content_block_delta", index: 0, delta: { type: "text_delta" } },
        ...anthropicTail,
      ]);

      expect(outcome.error).toBeUndefined();
      // An omitted provider field must not corrupt the final message.
      expect(outcome.eventTypes).toContain("text_delta");
      expect(frameDeltas(outcome.frames)).toEqual([]);
      // The dropped field can only have been the empty string, so the settled
      // text stays empty instead of becoming the literal "undefined".
      expect(settledText(outcome.frames)).toBe("");
    });

    it("drops a thinking delta whose field the upstream omitted", async () => {
      const outcome = await anthropic([
        anthropicHead[0],
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "thinking", thinking: "" },
        },
        { type: "content_block_delta", index: 0, delta: { type: "thinking_delta" } },
        ...anthropicTail,
      ]);

      expect(outcome.error).toBeUndefined();
      expect(outcome.eventTypes).toContain("thinking_delta");
      expect(frameDeltas(outcome.frames)).toEqual([]);
    });

    it("drops an input_json delta whose field the upstream omitted", async () => {
      const outcome = await anthropic([
        anthropicHead[0],
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "tool_1", name: "read" },
        },
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } },
        { type: "message_stop" },
      ]);

      expect(outcome.error).toBeUndefined();
      expect(outcome.eventTypes).toContain("toolcall_delta");
      expect(frameDeltas(outcome.frames)).toEqual([]);
    });
  });

  describe("OpenAI Responses", () => {
    it("streams a text delta whose field is present", async () => {
      const outcome = await responses([
        ...responsesHead,
        {
          type: "response.output_text.delta",
          sequence_number: 2,
          output_index: 0,
          content_index: 0,
          delta: "hi",
        },
        responsesCompleted,
      ]);

      expect(outcome.error).toBeUndefined();
      expect(frameDeltas(outcome.frames)).toEqual(["hi"]);
    });

    it("drops a text delta whose field the upstream omitted", async () => {
      const outcome = await responses([
        ...responsesHead,
        {
          type: "response.output_text.delta",
          sequence_number: 2,
          output_index: 0,
          content_index: 0,
        },
        responsesCompleted,
      ]);

      expect(outcome.error).toBeUndefined();
      expect(outcome.eventTypes).toContain("text_delta");
      expect(frameDeltas(outcome.frames)).toEqual([]);
    });
  });
});
