import { describe, expect, it } from "vitest";
import {
  LocalRequestError,
  normalizeContext,
} from "@earendil-works/pi-ai";
import type {
  AssistantMessage,
  HostedSearchContent,
  Message,
  Model,
} from "@earendil-works/pi-ai";
import {
  estimateContextTokens,
  estimateMessageTokens,
  getLastAssistantUsageInfo,
} from "@earendil-works/pi-ai/utils/estimate";
import { streamSimple as streamMistral } from "@earendil-works/pi-ai/api/mistral-conversations";

function assistant(content: AssistantMessage["content"], timestamp = 2, tokens = 0): AssistantMessage {
  return {
    role: "assistant", content, api: "openai-responses", provider: "openai", model: "source-model",
    timestamp, stopReason: "stop",
    usage: { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: tokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}
function searches(): HostedSearchContent[] {
  return [
    { type: "hostedSearch", phase: "server_tool_use", blockId: "srv_1", name: "web_search", input: { query: "local query" } },
    { type: "hostedSearch", phase: "web_search_tool_result", blockId: "srv_1", wire: { type: "web_search_tool_result", tool_use_id: "srv_1", content: [{ type: "web_search_result", encrypted_content: "opaque-result", url: "https://example.test" }] } },
    { type: "hostedSearch", phase: "web_search_call", blockId: "ws_1", status: "in_progress", wire: { type: "web_search_call", id: "ws_1", status: "in_progress", action: { type: "search", query: "local query" } } },
  ];
}
const mistral: Model<"mistral-conversations"> = {
  id: "target-model", name: "test", api: "mistral-conversations", provider: "mistral",
  baseUrl: "http://localhost", reasoning: false, input: ["text"], contextWindow: 100_000, maxTokens: 1000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
async function mistralRequest(content: AssistantMessage["content"]) {
  let body: { messages: { role: string; content?: unknown; tool_calls?: unknown[] }[] } | undefined;
  let fetches = 0;
  const result = await streamMistral(mistral, normalizeContext({ messages: [assistant(content)] }), {
    apiKey: "test", maxRetries: 0,
    fetch: async (_url, init) => {
      fetches++;
      body = JSON.parse(String(init?.body));
      return new Response('data: {"id":"m","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
    },
  }).result();
  expect(result.stopReason).toBe("stop");
  expect(fetches).toBe(1);
  return body!;
}

describe("hosted-search consumers", () => {
  describe("Mistral model switches", () => {
    for (const block of searches()) {
      it(`does not turn ${block.phase} into a malformed function call`, async () => {
        const body = await mistralRequest([block, { type: "text", text: "retained answer" }]);
        const message = body.messages.find(item => item.role === "assistant");
        expect(message?.content).toEqual([{ type: "text", text: "retained answer" }]);
        expect(message).not.toHaveProperty("tool_calls");
        expect(JSON.stringify(body)).not.toContain("opaque-result");
      });
    }
    it("omits search-only history while preserving ordinary function calls", async () => {
      const searchOnly = await mistralRequest(searches());
      expect(searchOnly.messages).toEqual([]);
      const mixed = await mistralRequest([
        ...searches(),
        { type: "thinking", thinking: "retained reasoning" },
        { type: "toolCall", id: "tool_1", name: "read", arguments: { path: "file" } },
      ]);
      const message = mixed.messages.find(item => item.role === "assistant");
      expect(message?.tool_calls).toEqual([
        expect.objectContaining({ id: expect.any(String), type: "function", function: { name: "read", arguments: '{"path":"file"}' } }),
      ]);
      expect(JSON.stringify(message)).not.toContain("retained reasoning");
      expect(mixed.messages.filter(item => item.role === "tool")).toHaveLength(1);
    });
  });


  describe("usage anchors", () => {
    const response = assistant([{ type: "text", text: "answer" }], 10, 100);
    const update: Message = { role: "system", content: "new instruction", timestamp: 20 };
    it("invalidates usage when a newer message is inserted before the response", () => {
      const messages = [update, response];
      expect(getLastAssistantUsageInfo(messages)).toBeUndefined();
      expect(estimateContextTokens(messages)).toMatchObject({ lastUsageIndex: null, tokens: estimateMessageTokens(update) + estimateMessageTokens(response) });
    });
    it("keeps usage when the system update is trailing, then counts that update once", () => {
      expect(estimateContextTokens([response, update])).toEqual({ lastUsageIndex: 0, usageTokens: 100, trailingTokens: estimateMessageTokens(update), tokens: 100 + estimateMessageTokens(update) });
    });
    it("keeps an earlier valid anchor when the later response predates an inserted update", () => {
      const later = assistant(searches(), 15, 300);
      expect(getLastAssistantUsageInfo([response, update, later])?.index).toBe(0);
      expect(estimateContextTokens([response, update, later]).tokens).toBe(100 + estimateMessageTokens(update) + estimateMessageTokens(later));
      expect(getLastAssistantUsageInfo([response, update, { ...later, timestamp: 21 }])?.index).toBe(2);
    });
    for (const timestamp of [undefined, null, "20", NaN, Infinity, -Infinity]) {
      it(`rejects malformed timestamp ${String(timestamp)} without poisoning usage selection`, () => {
        const malformed = { role: "user", content: "private", timestamp } as unknown as Message;
        for (const messages of [[malformed, response], [response, malformed], [malformed, assistant([], 30, 0)]]) {
          expect(() => getLastAssistantUsageInfo(messages)).toThrow(expect.objectContaining({ code: "LOCAL_REQUEST_ERROR", phase: "context-validation" }));
          expect(() => estimateContextTokens(messages)).toThrow(LocalRequestError);
        }
      });
    }
    it("accepts explicit zero timestamps and ties without inventing wall-clock values", () => {
      const original = assistant([], 0, 100);
      const messages: Message[] = [{ role: "system", content: "initial", timestamp: 0 }, original];
      expect(getLastAssistantUsageInfo(messages)?.index).toBe(1);
      expect(estimateContextTokens(messages).tokens).toBe(100);
      expect(original.timestamp).toBe(0);
    });
  });
});
