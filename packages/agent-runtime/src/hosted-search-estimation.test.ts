import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import type { AssistantMessage, Model, Api } from "@earendil-works/pi-ai";
import { estimateContextTokens, estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";
import { convertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { LocalRequestError, localRequestErrorDetails, normalizeHostedSearchContent, normalizeContext } from "@earendil-works/pi-ai";
import type { HostedSearchContent, AssistantMessageEvent } from "@earendil-works/pi-ai";

const require = createRequire(import.meta.url);
const compaction = await import(pathToFileURL(require.resolve("@earendil-works/pi-agent-core/package.json").replace(/package\.json$/, "dist/harness/compaction/compaction.js")).href);
const apis = ["openai-responses", "azure-openai-responses", "anthropic-messages"] as const;
function model<TApi extends Api>(api: TApi): Model<TApi> {
  return { id: "test-model", name: "test", api, provider: api === "anthropic-messages" ? "anthropic" : "openai", baseUrl: "http://localhost", reasoning: false, input: ["text"], contextWindow: 100_000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
}
function assistant(content: unknown[], api: Api = "openai-responses", tokens = 0, timestamp = 2): AssistantMessage {
  return { role: "assistant", content, api, provider: model(api).provider, model: "test-model", timestamp, stopReason: "stop", usage: { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: tokens, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } as AssistantMessage;
}
function search(api: Api, size = 1): unknown[] {
  return api === "anthropic-messages" ? [
    { type: "hostedSearch", phase: "server_tool_use", blockId: "srv_1", name: "web_search", input: { query: "q" } },
    { type: "hostedSearch", phase: "web_search_tool_result", blockId: "srv_1", wire: { type: "web_search_tool_result", tool_use_id: "srv_1", content: [{ type: "web_search_result", encrypted_content: "x".repeat(size) }] } },
  ] : [{ type: "hostedSearch", phase: "web_search_call", blockId: "ws_1", wire: { type: "web_search_call", id: "ws_1", status: "completed", action: { type: "search", query: "x".repeat(size) } } }];
}
function sse(api: Api): string {
  return api === "anthropic-messages"
    ? 'event: message_start\ndata: {"type":"message_start","message":{"id":"m","model":"test-model","usage":{"input_tokens":1,"output_tokens":0}}}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n'
    : 'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n';
}
async function run(api: typeof apis[number], content: unknown[], options: Record<string, unknown> = {}) {
  const adapter = await import(`@earendil-works/pi-ai/api/${api}`);
  let fetches = 0;
  let body: Record<string, unknown> | undefined;
  const stream = adapter.streamSimple(model(api), { messages: [assistant(content, api)] }, {
    apiKey: "test", maxRetries: 0,
    fetch: async (_input: unknown, init?: RequestInit) => {
      fetches++;
      body = JSON.parse(String(init?.body));
      return new Response(sse(api), { headers: { "content-type": "text/event-stream" } });
    }, ...options,
  });
  const result = await stream.result();
  return { result, fetches, body };
}

describe("real dependency hosted-search estimation and requests", () => {
  it("preserves text/thinking/tool/image numeric baselines", () => {
    const message = assistant([{ type: "text", text: "12345678" }, { type: "thinking", thinking: "1234" }, { type: "toolCall", id: "t", name: "run", arguments: { a: 1 } }]);
    expect(estimateMessageTokens(message)).toBe(6);
    expect(compaction.estimateTokens(message)).toBe(6);
    expect(estimateMessageTokens({ role: "user", content: [{ type: "image", data: "", mimeType: "image/png" }], timestamp: 1 })).toBe(1200);
    expect(compaction.estimateTokens({ role: "custom", content: "12345" })).toBe(2);
    expect(compaction.estimateTokens({ role: "bashExecution", command: "1234", output: "5678" })).toBe(2);
    expect(compaction.estimateTokens({ role: "branchSummary", summary: "12345" })).toBe(2);
    expect(compaction.estimateTokens({ role: "compactionSummary", summary: "12345" })).toBe(2);
  });
  for (const api of apis) {
    it(`${api}: estimates nameless search blocks with zero usage and growing content`, () => {
      const small = assistant(search(api), api);
      const large = assistant(search(api, 4000), api);
      expect(estimateMessageTokens(small)).toBeGreaterThan(0);
      expect(estimateMessageTokens(large) - estimateMessageTokens(small)).toBeGreaterThan(990);
      expect(compaction.estimateTokens(large)).toBe(estimateMessageTokens(large));
      expect(estimateContextTokens([large]).tokens).toBe(estimateMessageTokens(large));
      expect(compaction.estimateContextTokens([large])).toEqual(estimateContextTokens([large]));
    });
    it(`${api}: shares valid usage and stale-prefix rules`, () => {
      const msg = assistant(search(api, 400), api, 123);
      const newerPrefix = { role: "user" as const, content: "new prefix", timestamp: 10 };
      expect(estimateContextTokens([msg]).tokens).toBe(123);
      expect(compaction.estimateContextTokens([msg]).tokens).toBe(123);
      expect(compaction.estimateContextTokens([newerPrefix, msg])).toEqual(estimateContextTokens([newerPrefix, msg]));
      const tail = assistant(search(api, 200), api, 0, 20);
      expect(estimateContextTokens([msg, tail]).tokens).toBe(123 + estimateMessageTokens(tail));
      for (const stopReason of ["aborted", "error"] as const) {
        const failed = { ...msg, stopReason };
        expect(estimateContextTokens([failed]).lastUsageIndex).toBeNull();
        expect(compaction.estimateContextTokens([failed])).toEqual(estimateContextTokens([failed]));
      }
    });
    it(`${api}: streamSimple replays zero-usage search history through mock fetch`, async () => {
      const { result, fetches, body } = await run(api, search(api));
      expect(result.stopReason).toBe("stop");
      expect(fetches).toBe(1);
      expect(JSON.stringify(body)).toContain(api === "anthropic-messages" ? "encrypted_content" : "web_search_call");
    });
    it(`${api}: rejects unknown phases locally before fetch`, async () => {
      const { result, fetches } = await run(api, [{ type: "hostedSearch", phase: "unknown", blockId: "invalid" }]);
      expect(fetches).toBe(0);
      expect(result.stopReason).toBe("error");
      expect(result.errorDetails).toMatchObject({ code: "LOCAL_REQUEST_ERROR", phase: "context-validation" });
      expect(result.errorMessage).not.toContain("invalid");
    });
    it(`${api}: does not label network TypeError as local`, async () => {
      const { result } = await run(api, [{ type: "text", text: "ok" }], { fetch: async () => { throw new TypeError("socket unavailable"); } });
      expect(result.stopReason).toBe("error");
      expect(result.errorDetails).toBeUndefined();
    });
    it(`${api}: retains phase/causeName for preparation failures before fetch`, async () => {
      const { result, fetches } = await run(api, search(api), { onPayload: () => { throw new TypeError("private payload text"); } });
      expect(fetches).toBe(0);
      expect(result.errorDetails).toEqual({ code: "LOCAL_REQUEST_ERROR", phase: "request-preparation", message: "Local request preparation failed", causeName: "TypeError" });
      expect(result.errorMessage).not.toContain("private");
    });
    it(`${api}: does not label HTTP or response parsing failures as local`, async () => {
      for (const response of [
        new Response('{"error":{"message":"unavailable"}}', { status: 503, headers: { "content-type": "application/json" } }),
        new Response('event: message_start\ndata: not-json\n\nevent: response.completed\ndata: not-json\n\n', { headers: { "content-type": "text/event-stream" } }),
      ]) {
        const { result } = await run(api, [{ type: "text", text: "ok" }], { fetch: async () => response });
        expect(result.stopReason).toBe("error");
        expect(result.errorDetails).toBeUndefined();
      }
    });
    it(`${api}: keeps cancellation aborted without local metadata`, async () => {
      const controller = new AbortController();
      controller.abort();
      const { result, fetches } = await run(api, [{ type: "hostedSearch", phase: "unknown" }], { signal: controller.signal });
      expect(fetches).toBe(0);
      expect(result.stopReason).toBe("aborted");
      expect(result.errorDetails).toBeUndefined();
    });
    it(`${api}: valid usage cannot hide invalid blocks; direct stream fails before fetch`, async () => {
      const adapter = await import(`@earendil-works/pi-ai/api/${api}`);
      const invalid = assistant([{ type: "hostedSearch", phase: "unknown", blockId: "secret" }], api, 100);
      expect(() => estimateContextTokens([invalid])).toThrow(expect.objectContaining({ code: "LOCAL_REQUEST_ERROR" }));
      expect(() => compaction.estimateContextTokens([invalid])).toThrow(expect.objectContaining({ code: "LOCAL_REQUEST_ERROR" }));
      let fetches = 0;
      const result = await adapter.stream(model(api), { messages: [invalid] }, { apiKey: "test", fetch: async () => { fetches++; throw new Error("must not fetch"); } }).result();
      expect(fetches).toBe(0);
      expect(result.errorDetails?.phase).toBe("context-validation");
    });
    it(`${api}: preserves actual buildBaseOptions estimation failures before fetch`, async () => {
      const adapter = await import(`@earendil-works/pi-ai/api/${api}`);
      let fetches = 0;
      const result = await adapter.streamSimple(model(api), { messages: [{ role: "user", content: null, timestamp: 1 }] }, {
        apiKey: "test", fetch: async () => { fetches++; throw new Error("must not fetch"); },
      }).result();
      expect(fetches).toBe(0);
      expect(result.errorDetails).toMatchObject({ code: "LOCAL_REQUEST_ERROR", phase: "context-estimation", causeName: "TypeError" });
    });
  }
  it("does not treat unknown blocks as tool calls or silently return zero", () => {
    expect(() => compaction.estimateTokens({ role: "future", content: [] })).toThrow(expect.objectContaining({ code: "LOCAL_REQUEST_ERROR" }));
    for (const content of [[{ type: "future", name: "fake", arguments: {} }], [{ type: "hostedSearch", phase: "unknown", name: "fake", arguments: {} }]]) {
      expect(() => estimateMessageTokens(assistant(content))).toThrow(expect.objectContaining({ code: "LOCAL_REQUEST_ERROR" }));
      expect(() => compaction.estimateTokens(assistant(content))).toThrow(expect.objectContaining({ code: "LOCAL_REQUEST_ERROR" }));
    }
  });
  it("replays Responses wire only for the same model and estimates it once", () => {
    const content = search("openai-responses", 100);
    const msg = assistant(content);
    const context = normalizeContext({ messages: [msg] });
    const same = convertResponsesMessages(model("openai-responses"), context, new Set(), {});
    const other = convertResponsesMessages({ ...model("openai-responses"), id: "other" }, context, new Set(), {});
    expect(same).toHaveLength(1);
    expect(other).toHaveLength(0);
    expect(estimateMessageTokens(msg, { ...model("openai-responses"), id: "other" })).toBe(0);
    expect(estimateMessageTokens(msg)).toBe(Math.ceil(JSON.stringify(same[0]).length / 4));
    const decorated = { ...(content[0] as object), query: "ignored".repeat(1000), results: [{ url: "ignored".repeat(1000) }] };
    expect(estimateMessageTokens(assistant([decorated]))).toBe(estimateMessageTokens(msg));
  });

  it("replays Responses search history to the Codex Responses adapter", () => {
    const api = "openai-codex-responses";
    const msg = assistant(search(api, 100), api);
    const context = normalizeContext({ messages: [msg] });
    const same = convertResponsesMessages(model(api), context, new Set(), {});
    const other = convertResponsesMessages({ ...model(api), id: "other" }, context, new Set(), {});
    expect(same).toHaveLength(1);
    expect(same[0]).toMatchObject({ type: "web_search_call", id: "ws_1" });
    expect(other).toHaveLength(0);
    expect(estimateMessageTokens(msg, { ...model(api), id: "other" })).toBe(0);
    expect(estimateMessageTokens(msg)).toBe(Math.ceil(JSON.stringify(same[0]).length / 4));
  });
  it("declares search content and events without fake name/arguments", () => {
    const block: HostedSearchContent = { type: "hostedSearch", phase: "web_search_call", blockId: "legacy" };
    const event: AssistantMessageEvent = { type: "hosted_search_update", contentIndex: 0, partial: assistant([block]) };
    expect(event.partial.content[0]).not.toHaveProperty("name");
    expect(event.partial.content[0]).not.toHaveProperty("arguments");
    const replay = convertResponsesMessages(model("openai-responses"), normalizeContext({ messages: [assistant([block])] }), new Set());
    expect(replay).toEqual([{ type: "web_search_call", id: "legacy", status: "completed" }]);
    expect(estimateMessageTokens(assistant([block]))).toBe(Math.ceil(JSON.stringify(replay[0]).length / 4));
  });
  it("matches Anthropic replay estimates across models and search toggles", async () => {
    const adapter = await import("@earendil-works/pi-ai/api/anthropic-messages");
    for (const webSearch of [true, false]) {
      const msg = assistant(search("anthropic-messages", 400), "anthropic-messages");
      let body: { messages: { role: string; content: unknown[] }[]; tools?: { type: string }[] } | undefined;
      await adapter.streamSimple({ ...model("anthropic-messages"), id: "other", webSearch }, normalizeContext({ messages: [msg] }), {
        apiKey: "test", fetch: async (_input, init) => {
          body = JSON.parse(String(init?.body));
          return new Response(sse("anthropic-messages"), { headers: { "content-type": "text/event-stream" } });
        },
      }).result();
      const blocks = body?.messages.find(m => m.role === "assistant")?.content ?? [];
      expect(blocks).toHaveLength(2);
      expect(estimateMessageTokens(msg)).toBe(Math.ceil(blocks.reduce<number>((sum, block) => sum + JSON.stringify(block).length, 0) / 4));
      expect(body?.tools?.some(tool => tool.type.startsWith("web_search")) ?? false).toBe(webSearch);
    }
  });
  it("normalizes legacy missing input and wire IDs but rejects invalid data", () => {
    expect(normalizeHostedSearchContent({ type: "hostedSearch", phase: "server_tool_use", blockId: "s", name: "web_search" })).toMatchObject({ input: {} });
    expect(normalizeHostedSearchContent({ type: "hostedSearch", phase: "web_search_call", wire: { type: "web_search_call", id: "w" } })).toMatchObject({ blockId: "w" });
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    for (const block of [
      { type: "hostedSearch", phase: "web_search_tool_result", blockId: "s" },
      { type: "hostedSearch", phase: "web_search_call", blockId: "s", wire: [] },
      { type: "hostedSearch", phase: "web_search_call", blockId: "s", wire: { type: "other", id: "s" } },
      { type: "hostedSearch", phase: "server_tool_use", blockId: "s", name: "web_search", input: cycle },
    ]) expect(() => estimateMessageTokens(assistant([block]))).toThrow(expect.objectContaining({ code: "LOCAL_REQUEST_ERROR", phase: "context-validation" }));
  });
  it("recognizes only explicit local markers and excludes cause from messages", () => {
    const cause = new TypeError("private request");
    const error = new LocalRequestError("context-estimation", { cause });
    expect(error.cause).toBe(cause);
    expect(error.message).not.toContain("private");
    expect(localRequestErrorDetails(error)).toMatchObject({ code: "LOCAL_REQUEST_ERROR", phase: "context-estimation", causeName: "TypeError" });
    expect(localRequestErrorDetails({ code: "LOCAL_REQUEST_ERROR", phase: "request-preparation" })).toBeDefined();
    expect(localRequestErrorDetails(cause)).toBeUndefined();
    expect(localRequestErrorDetails({ code: "LOCAL_REQUEST_ERROR", phase: "network" })).toBeUndefined();
  });
  it("pi-agent-core preserves streamed and thrown local error details", async () => {
    const { Agent } = await import("@earendil-works/pi-agent-core");
    const adapter = await import("@earendil-works/pi-ai/api/openai-responses");
    for (const streamFn of [
      () => { throw new LocalRequestError("context-estimation", { cause: new TypeError("private") }); },
      () => adapter.streamSimple(model("openai-responses"), normalizeContext({ messages: [assistant([{ type: "hostedSearch", phase: "unknown" }])] }), {
        apiKey: "test", maxRetries: 0, fetch: async () => { throw new Error("must not fetch"); },
      }),
    ]) {
      const agent = new Agent({ initialState: { model: model("openai-responses") }, streamFn });
      await agent.prompt("local only");
      const last = agent.state.messages.at(-1) as AssistantMessage;
      expect(last.stopReason).toBe("error");
      expect(last.errorDetails?.code).toBe("LOCAL_REQUEST_ERROR");
      expect(last.errorMessage).not.toContain("private");
    }
  });
});
