import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AssistantMessageFrameEncoder,
  LocalRequestError,
  normalizeContext,
  reduceAssistantMessageFrames,
} from "@earendil-works/pi-ai";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageFrame,
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

const require = createRequire(import.meta.url);
const { applyFrame } = await import(pathToFileURL(require.resolve("@earendil-works/pi-agent-core/package.json").replace(/package\.json$/, "dist/harness/pico3/kinds/frames.js")).href);

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
function encode(events: AssistantMessageEvent[]): AssistantMessageFrame[] {
  const encoder = new AssistantMessageFrameEncoder();
  return events.flatMap(event => {
    const frame = encoder.encode(event);
    return frame ? [frame] : [];
  });
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
      expect(JSON.stringify(message?.content)).toContain("retained reasoning");
      expect(mixed.messages.filter(item => item.role === "tool")).toHaveLength(1);
    });
  });

  describe("in-process assistant frames", () => {
    for (const block of searches()) {
      it(`round-trips ${block.phase} and the following text index`, () => {
        const output = assistant([block, { type: "text", text: "answer" }]);
        const frames = encode([
          { type: "start", partial: output },
          { type: "hosted_search_update", contentIndex: 0, partial: output },
          { type: "text_start", contentIndex: 1, partial: output },
          { type: "text_end", contentIndex: 1, content: "answer", partial: output },
        ]);
        expect(frames.map(frame => frame.type)).toEqual(["start", "hosted_search_update", "text_start", "text_end"]);
        expect(reduceAssistantMessageFrames(frames)?.content).toEqual(output.content);
        const tracked: { message?: AssistantMessage } = {};
        for (const frame of frames) applyFrame(tracked, structuredClone(frame));
        expect(tracked.message?.content).toEqual(reduceAssistantMessageFrames(frames)?.content);
      });
    }
    it("replaces snapshots without duplicating blocks and detaches nested wire data", () => {
      const block = searches()[2]!;
      const output = assistant([block]);
      const encoder = new AssistantMessageFrameEncoder();
      const start = encoder.encode({ type: "start", partial: output })!;
      const first = encoder.encode({ type: "hosted_search_update", contentIndex: 0, partial: output })!;
      expect(first).toBeDefined();
      if (block.phase !== "web_search_call") throw new Error("unexpected fixture");
      block.status = "completed";
      block.wire!.status = "completed";
      (block.wire!.action as { query: string }).query = "updated query";
      const last = encoder.encode({ type: "hosted_search_update", contentIndex: 0, partial: output })!;
      expect(reduceAssistantMessageFrames([start, first])?.content[0]).toMatchObject({ status: "in_progress", wire: { action: { query: "local query" } } });
      const frames = [start, first, last, last];
      const reduced = reduceAssistantMessageFrames(frames)!;
      expect(reduced.content).toEqual([block]);
      (reduced.content[0] as typeof block).wire!.status = "mutated";
      expect(reduceAssistantMessageFrames(frames)?.content).toEqual([block]);
    });
    it("preserves multiple search rounds, pair IDs, and ordinary block deltas", () => {
      const output = assistant([...searches(), { type: "text", text: "" }]);
      const encoder = new AssistantMessageFrameEncoder();
      const events: AssistantMessageEvent[] = [
        { type: "start", partial: output },
        ...[0, 1, 2].map(contentIndex => ({ type: "hosted_search_update" as const, contentIndex, partial: output })),
        { type: "text_start", contentIndex: 3, partial: output },
        { type: "text_delta", contentIndex: 3, delta: "answer", partial: output },
        { type: "text_end", contentIndex: 3, content: "answer", partial: output },
      ];
      const frames = events.map(event => encoder.encode(event)).filter((frame): frame is AssistantMessageFrame => frame !== undefined);
      expect(reduceAssistantMessageFrames(frames)?.content).toEqual([...searches(), { type: "text", text: "answer" }]);
    });
    it("rejects wrong block types, identities, and gaps instead of corrupting content", () => {
      const output = assistant([searches()[2]!]);
      const start = { type: "start" as const, partial: assistant([]) };
      const frame: AssistantMessageFrame = { type: "hosted_search_update", contentIndex: 0, content: searches()[2]! };
      expect(() => reduceAssistantMessageFrames([start, { ...frame, contentIndex: 1 } as AssistantMessageFrame])).toThrow(/gap/);
      expect(() => reduceAssistantMessageFrames([start, { type: "text_start", contentIndex: 0, content: { type: "text", text: "safe" } }, frame])).toThrow();
      expect(() => reduceAssistantMessageFrames([start, frame, { ...frame, content: { ...searches()[2]!, blockId: "other" } } as AssistantMessageFrame])).toThrow();
      const encoder = new AssistantMessageFrameEncoder();
      encoder.encode({ type: "start", partial: output });
      encoder.encode({ type: "hosted_search_update", contentIndex: 0, partial: output });
      output.content[0] = { ...searches()[2]!, blockId: "other" };
      expect(() => encoder.encode({ type: "hosted_search_update", contentIndex: 0, partial: output })).toThrow();
      output.content[0] = { type: "text", text: "safe" };
      expect(() => encoder.encode({ type: "hosted_search_update", contentIndex: 0, partial: output })).toThrow();
    });
    it("does not persist parser scratch buffers or fabricate tool fields", () => {
      const streamingBlock = { ...searches()[0]!, index: 0, inputJson: "scratch", partialJson: "scratch" };
      const output = assistant([streamingBlock]);
      const frames = encode([{ type: "start", partial: output }, { type: "hosted_search_update", contentIndex: 0, partial: output }]);
      const reduced = reduceAssistantMessageFrames(frames)!;
      expect(reduced.content[0]).toEqual(searches()[0]);
      expect(reduced.content[0]).not.toHaveProperty("arguments");
    });
    it("preserves error-result wire and legacy fallback semantics", () => {
      const blocks: HostedSearchContent[] = [
        { type: "hostedSearch", phase: "web_search_tool_result", blockId: "s", isError: true, wire: { type: "web_search_tool_result_error", tool_use_id: "s", content: "unavailable" } },
        { type: "hostedSearch", phase: "web_search_call", blockId: "legacy" },
      ];
      const output = assistant(blocks);
      const frames = encode([
        { type: "start", partial: output },
        { type: "hosted_search_update", contentIndex: 0, partial: output },
        { type: "hosted_search_update", contentIndex: 1, partial: output },
      ]);
      expect(reduceAssistantMessageFrames(frames)?.content).toEqual(blocks);
    });
    it("retains thinking and tool frame behavior after a search block", () => {
      const search = searches()[2]!;
      const thinking = { type: "thinking" as const, thinking: "", thinkingSignature: "sig" };
      const toolCall = { type: "toolCall" as const, id: "tool", name: "read", arguments: {} };
      const output = assistant([search, thinking, toolCall]);
      const frames = encode([
        { type: "start", partial: output },
        { type: "hosted_search_update", contentIndex: 0, partial: output },
        { type: "thinking_start", contentIndex: 1, partial: output },
        { type: "thinking_delta", contentIndex: 1, delta: "reason", partial: output },
        { type: "thinking_end", contentIndex: 1, content: "reason", partial: output },
        { type: "toolcall_start", contentIndex: 2, partial: output },
        { type: "toolcall_delta", contentIndex: 2, delta: '{"path":"file"}', partial: output },
        { type: "toolcall_end", contentIndex: 2, toolCall: { ...toolCall, arguments: { path: "file" } }, partial: output },
      ]);
      expect(reduceAssistantMessageFrames(frames)?.content).toEqual([
        search, { ...thinking, thinking: "reason" }, { ...toolCall, arguments: { path: "file" } },
      ]);
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
