import { describe, expect, it } from "vitest";
import type { Message } from "@earendil-works/pi-ai";
import { buildProviderModel, createProviderModels, apiBindingForProviderModel, type RuntimeProviderConfig } from "./provider-binding.js";
import { modelConfigWithBinding } from "./model-capabilities.js";

describe("official search through the existing service", () => {
  it("continues the same DeepSeek conversation when search is enabled then disabled", async () => {
    const history: Message[] = [];
    const paths: string[] = [];
    const bodies: Record<string, unknown>[] = [];
    for (const [turn, enabled] of [false, true, false].entries()) {
      const provider: RuntimeProviderConfig = {
        id: "same-provider", name: "DeepSeek", vendorKey: "deepseek",
        baseUrl: "https://api.deepseek.com", apiStyle: "chat_completions",
        modelId: "deepseek-v4-flash", apiKey: "synthetic-test-key",
        supportsReasoning: false, supportedThinkingLevels: ["off"],
        modelConfig: {
          source: "generic", name: "DeepSeek", baseUrl: "https://api.deepseek.com",
          reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096,
          webSearch: enabled, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      };
      history.push({ role: "user", content: `question-${turn}`, timestamp: turn + 1 });
      const model = buildProviderModel(provider);
      const output = await createProviderModels(provider, model).streamSimple(model, { messages: history }, {
        fetch: async (input, init) => {
          paths.push(new URL(input instanceof Request ? input.url : String(input)).pathname);
          bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          const event = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
          const body = enabled
            ? event("message_start", { message: { id: "m-search", type: "message", role: "assistant", model: model.id,
              content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } }) +
              event("content_block_start", { index: 0, content_block: { type: "server_tool_use", id: "srv-search", name: "web_search", input: { query: "fixture" } } }) +
              event("content_block_stop", { index: 0 }) +
              event("content_block_start", { index: 1, content_block: { type: "web_search_tool_result", tool_use_id: "srv-search",
                content: [{ type: "web_search_result", url: "https://example.invalid/source", title: "Fixture", encrypted_content: "fixture-cipher" }] } }) +
              event("content_block_stop", { index: 1 }) +
              event("content_block_start", { index: 2, content_block: { type: "text", text: "" } }) +
              event("content_block_delta", { index: 2, delta: { type: "text_delta", text: `answer-${turn}` } }) +
              event("content_block_stop", { index: 2 }) +
              event("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } }) +
              event("message_stop", {})
            : `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: `answer-${turn}` }, finish_reason: null }] })}\n\n` +
              `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;
          return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
        },
      }).result();
      expect(output.stopReason).toBe("stop");
      expect(output.content).toContainEqual(expect.objectContaining({ type: "text", text: `answer-${turn}` }));
      if (enabled) expect(output.content).toContainEqual(expect.objectContaining({ type: "hostedSearch" }));
      history.push(output);
    }
    expect(paths).toEqual(["/chat/completions", "/anthropic/v1/messages", "/chat/completions"]);
    expect(JSON.stringify(bodies[1])).toContain("answer-0");
    expect(JSON.stringify(bodies[2])).toContain("answer-1");
    expect(JSON.stringify(bodies[2])).not.toContain("fixture-cipher");
    expect(bodies[2].tools ?? []).toEqual([]);
  });
  for (const [vendorKey, baseUrl, modelId, searchApi, searchPath] of [
    ["deepseek", "https://api.deepseek.com", "deepseek-v4-flash", "anthropic-messages", "/anthropic/v1/messages"],
    ["xai", "https://api.x.ai/v1", "grok-4.7", "openai-responses", "/v1/responses"],
    ["openai", "https://api.openai.com/v1", "gpt-6-sol", "openai-responses", "/v1/responses"],
  ]) {
    for (const enabled of [false, true]) {
      it(`${vendorKey}: only the search opt-in changes the request route (${enabled})`, async () => {
        const provider: RuntimeProviderConfig = {
          id: "fixture-provider", name: "My service", vendorKey, baseUrl, modelId,
          apiStyle: "chat_completions", apiKey: "synthetic-test-key", authKind: "api_key_and_base_url",
          supportsReasoning: false, supportedThinkingLevels: ["off"],
          modelConfig: modelConfigWithBinding({
            source: "generic", name: modelId, baseUrl, reasoning: false, input: ["text"],
            contextWindow: 128000, maxTokens: 4096,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          }, { contextWindow: 128000, maxTokens: 4096, thinkingLevels: ["off"], nativeWebSearch: enabled }),
        };
        const before = structuredClone(provider);
        const model = buildProviderModel(provider);
        expect(apiBindingForProviderModel(provider).api).toBe(model.api);
        expect(model.api).toBe(enabled ? searchApi : "openai-completions");
        let endpoint = "";
        let body: Record<string, unknown> = {};
        let key: string | null = null;
        const result = await createProviderModels(provider, model).streamSimple(model, {
          messages: [{ role: "user", content: "Find release notes", timestamp: 1 }],
        }, { fetch: async (input, init) => {
          endpoint = input instanceof Request ? input.url : String(input);
          body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          const headers = new Headers(init?.headers);
          key = headers.get("x-api-key") ?? headers.get("authorization");
          return new Response("captured offline", { status: 400 });
        } }).result();
        expect(result.stopReason).toBe("error");
        const url = new URL(endpoint);
        expect(url.origin).toBe(new URL(baseUrl).origin);
        expect(url.pathname).toBe(enabled ? searchPath : `${new URL(baseUrl).pathname.replace(/\/$/, "")}/chat/completions`);
        expect(key).toContain("synthetic-test-key");
        expect(body.model).toBe(modelId);
        if (enabled) expect(body.tools).toContainEqual(searchApi === "anthropic-messages"
          ? { type: "web_search_20250305", name: "web_search" } : { type: "web_search" });
        else expect(body.tools ?? []).toEqual([]);
        expect(provider).toEqual(before);
      });
    }
  }
});
