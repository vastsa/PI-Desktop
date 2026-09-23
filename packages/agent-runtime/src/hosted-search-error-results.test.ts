import { describe, expect, it } from "vitest";
import {
  hostedSearchReplayProjection,
  normalizeContext,
  normalizeHostedSearchContent,
  type AssistantMessage,
  type HostedSearchContent,
  type Model,
} from "@earendil-works/pi-ai";
import { estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";
import { streamSimple } from "@earendil-works/pi-ai/api/anthropic-messages";

const model: Model<"anthropic-messages"> = {
  id: "offline-anthropic", name: "Offline", api: "anthropic-messages", provider: "anthropic",
  baseUrl: "http://127.0.0.1", reasoning: false, input: ["text"],
  contextWindow: 100_000, maxTokens: 1024, webSearch: true,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const request: HostedSearchContent = {
  type: "hostedSearch", phase: "server_tool_use", blockId: "search-1",
  name: "web_search", input: { query: "offline fixture" },
};
function message(result: HostedSearchContent): AssistantMessage {
  return {
    role: "assistant", content: [request, result], api: model.api, provider: model.provider,
    model: model.id, timestamp: 2, stopReason: "stop",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}

// Both representations are already supported by the adapter; neither result
// is an ordinary tool call and neither is allowed to acquire fake fields.
const results: Extract<HostedSearchContent, { phase: "web_search_tool_result" }>[] = [
  {
    type: "hostedSearch", phase: "web_search_tool_result", blockId: "search-1", isError: true,
    wire: { type: "web_search_tool_result_error", tool_use_id: "search-1",
      content: { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" } },
  },
  {
    type: "hostedSearch", phase: "web_search_tool_result", blockId: "search-1",
    wire: { type: "web_search_tool_result", tool_use_id: "search-1",
      content: { type: "web_search_tool_result_error", error_code: "unavailable" } },
  },
];

describe("typed Anthropic search error results", () => {
  for (const result of results) {
    it(`estimates and replays ${result.wire?.type} without tool fields`, async () => {
      const before = JSON.stringify(result);
      const normalized = normalizeHostedSearchContent(result);
      expect(normalized).not.toHaveProperty("name");
      expect(normalized).not.toHaveProperty("arguments");
      const projection = hostedSearchReplayProjection(result, { api: model.api });
      expect(projection).toEqual(result.wire);
      const assistant = message(result);
      const expectedChars = [request, result].reduce((sum, block) => sum + JSON.stringify(hostedSearchReplayProjection(block)).length, 0);
      expect(estimateMessageTokens(assistant, model)).toBe(Math.ceil(expectedChars / 4));
      let fetches = 0;
      const events = [
        { type: "message_start", message: { id: "response-1", model: model.id, usage: { input_tokens: 1, output_tokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: hostedSearchReplayProjection(request) },
        { type: "content_block_stop", index: 0 },
        { type: "content_block_start", index: 1, content_block: projection },
        { type: "content_block_stop", index: 1 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
        { type: "message_stop" },
      ];
      const stream = streamSimple(model, normalizeContext({ messages: [assistant] }), {
        apiKey: "offline-fixture", maxRetries: 0,
        fetch: async (_input, init) => {
          fetches++;
          const body = JSON.parse(String(init?.body));
          expect(body.messages[0].content).toEqual([hostedSearchReplayProjection(request), projection]);
          expect(JSON.stringify(body)).not.toMatch(/hostedSearch|blockId|isError/);
          return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
            headers: { "content-type": "text/event-stream" },
          });
        },
      });
      const emitted = [];
      for await (const event of stream) emitted.push(event);
      const output = await stream.result();
      expect(fetches).toBe(1);
      expect(output.stopReason).toBe("stop");
      expect(output.errorDetails).toBeUndefined();
      const restored = output.content.find((block) => block.type === "hostedSearch" && block.phase === "web_search_tool_result");
      expect(restored).toBeDefined();
      expect(hostedSearchReplayProjection(restored)).toEqual(projection);
      expect(emitted.some((event) => event.type === "hosted_search_update")).toBe(true);
      expect(JSON.stringify(result)).toBe(before);
    });
  }
});


it("keeps only URL-bearing search citations in the formal search citation field", async () => {
  const valid = { type: "web_search_result_location", url: "https://example.invalid/source", title: "Source", cited_text: "result" };
  const citations = [
    { type: "char_location", document_index: 0, start_char_index: 0, end_char_index: 1 },
    { type: "web_search_result_location", title: "missing URL" },
    { type: "web_search_result_location", url: 123 },
    { type: "web_search_result_location", url: "", title: "empty URL" },
    valid,
  ];
  const events = [
    { type: "message_start", message: { id: "citation-response", model: model.id, usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    ...citations.map((citation) => ({ type: "content_block_delta", index: 0, delta: { type: "citations_delta", citation } })),
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ];
  const stream = streamSimple(model, normalizeContext({ messages: [{ role: "user", content: "offline citations", timestamp: 1 }] }), {
    apiKey: "offline-fixture", maxRetries: 0,
    fetch: async () => new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
      headers: { "content-type": "text/event-stream" },
    }),
  });
  for await (const _event of stream) { /* Drain the real adapter stream. */ }
  const output = await stream.result();
  expect(output.stopReason).toBe("stop");
  expect(output.hostedSearchCitations).toEqual([valid]);
});
