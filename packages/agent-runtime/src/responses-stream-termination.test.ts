import { describe, expect, it } from "vitest";
import type { Context, Model } from "@earendil-works/pi-ai";
import { stream } from "@earendil-works/pi-ai/api/openai-responses";

const model: Model<"openai-responses"> = {
  id: "responses-test",
  name: "Responses Test",
  api: "openai-responses",
  provider: "acme",
  baseUrl: "https://api.acme.test/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 4096,
};

const context: Context = {
  messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
};

const completedEvent = {
  type: "response.completed",
  sequence_number: 2,
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
        content: [{ type: "output_text", text: "hello" }],
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

/** SSE body that emits the terminal event and then never ends. */
function hangAfterTerminalBody(): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          `event: response.created\ndata: ${JSON.stringify({ type: "response.created", sequence_number: 0, response: { id: "resp_1" } })}\n\n`,
        ),
      );
      controller.enqueue(
        encoder.encode(
          `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", sequence_number: 1, output_index: 0, content_index: 0, delta: "hello" })}\n\n`,
        ),
      );
      controller.enqueue(
        encoder.encode(`event: response.completed\ndata: ${JSON.stringify(completedEvent)}\n\n`),
      );
      // Terminal event delivered; never enqueue again and never close().
    },
  });
}

describe("OpenAI Responses stream termination (issue #130)", () => {
  it("completes the turn without waiting for the server to close the connection", async () => {
    const streamBody = hangAfterTerminalBody();
    const fetchImpl = async () =>
      new Response(streamBody, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });

    const events = await stream(model, context, { apiKey: "sk-test", fetch: fetchImpl as any });
    const seen: string[] = [];
    // Reading to completion must not hang: with the fix the stream consumer
    // stops after the terminal event, so `result()` resolves promptly.
    const result = await Promise.race([
      events.result(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("stream hung after response.completed")), 5000),
      ),
    ]);

    for await (const event of events) {
      seen.push(event.type);
    }

    expect(seen).toContain("done");
    expect(result.stopReason).toBe("stop");
    expect(result.usage.totalTokens).toBe(7);
  }, 10000);
});
