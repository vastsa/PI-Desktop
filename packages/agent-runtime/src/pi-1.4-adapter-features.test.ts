import { describe, expect, it } from "vitest";
import { normalizeContext, type AssistantMessage, type Message } from "@earendil-works/pi-ai";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { buildProviderModel, createProviderModels, type RuntimeProviderConfig } from "./provider-binding.js";
import { modelConfigFromPi } from "./model-capabilities.js";
import { classifyProviderError, isTransientProviderRetryCode } from "./provider-retry.js";

function anthropic(id: "claude-haiku-5-5" | "claude-opus-5" = "claude-haiku-5-5"): RuntimeProviderConfig {
  const builtin = getBuiltinModel("anthropic", id);
  if (!builtin) throw new Error(`Missing fixture model: ${id}`);
  return {
    id: "desktop-account", name: "Fixture", vendorKey: "anthropic", modelId: id,
    baseUrl: builtin.baseUrl, apiStyle: "anthropic_messages", apiKey: "fixture",
    supportsReasoning: true, supportedThinkingLevels: ["off", "high"],
    modelConfig: { ...modelConfigFromPi(builtin), webSearch: true },
  };
}

function anthropicResponse(): Response {
  const events = [
    { type: "message_start", message: { id: "reply", type: "message", role: "assistant", content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 0 } },
    { type: "message_stop" },
  ];
  return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

type Block = { type: string; name?: string; content?: string | Block[]; thinking?: string; source?: { data: string } };
type Payload = { thinking?: { type: string }; output_config?: unknown; tools: Block[]; messages: Array<{ role: string; content: string | Block[]; output_config?: unknown }> };

async function anthropicRequest(provider: RuntimeProviderConfig, messages: Message[], thinking: "off" | "high" = "off"): Promise<Payload> {
  let payload: Payload | undefined;
  const model = buildProviderModel(provider);
  const result = await createProviderModels(provider, model).streamSimple(model, { messages }, {
    reasoning: thinking === "off" ? undefined : thinking, maxRetries: 0,
    fetch: async (_url, init) => {
      payload = JSON.parse(String(init?.body));
      return anthropicResponse();
    },
  }).result();
  expect(result.stopReason).toBe("stop");
  if (!payload) throw new Error("No fixture request");
  return payload;
}

const usage: AssistantMessage["usage"] = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("Pi 1.4 adapters through Desktop provider binding", () => {
  it.each(["claude-haiku-5-5", "claude-opus-5"] as const)("disables thinking without effort markers while preserving hosted search: %s", async (id) => {
    const payload = await anthropicRequest(anthropic(id), [{ role: "user", content: "Hello", timestamp: 1 }]);
    expect(payload.thinking).toEqual({ type: "disabled" });
    expect(payload.output_config).toBeUndefined();
    expect(payload.messages.every((message) => message.output_config === undefined)).toBe(true);
    expect(payload.tools).toContainEqual({ type: "web_search_20250305", name: "web_search" });
  });

  it("keeps all tool results before images removed from error tool results", async () => {
    const provider = anthropic();
    const model = buildProviderModel(provider);
    const image = { type: "image" as const, mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==" };
    const messages: Message[] = [
      { role: "user", content: "Check images", timestamp: 1 },
      { role: "assistant", api: model.api, provider: model.provider, model: model.id,
        content: [
          { type: "toolCall", id: "failed", name: "Read", arguments: { path: "failed.png" } },
          { type: "toolCall", id: "success", name: "Read", arguments: { path: "success.png" } },
        ], usage, stopReason: "toolUse", timestamp: 2 },
      { role: "toolResult", toolCallId: "failed", toolName: "Read", isError: true, content: [{ type: "text", text: "Image error" }, image], timestamp: 3 },
      { role: "toolResult", toolCallId: "success", toolName: "Read", isError: false, content: [{ type: "text", text: "Image ready" }, image], timestamp: 4 },
    ];
    const payload = await anthropicRequest(provider, messages);
    const turn = payload.messages.find((message) => Array.isArray(message.content) && message.content.some((block) => block.type === "tool_result"));
    const content = turn?.content;
    if (!Array.isArray(content)) throw new Error("Missing tool-result turn");
    expect(content.slice(0, 2).map((block) => block.type)).toEqual(["tool_result", "tool_result"]);
    expect(typeof content[0]?.content).toBe("string");
    expect(content[0]?.content).toContain("Image error");
    const successContent = content[1]?.content;
    if (!Array.isArray(successContent)) throw new Error("Missing successful image content");
    expect(successContent.map((block) => block.type)).toEqual(["text", "image"]);
    expect(content.at(-1)).toMatchObject({ type: "image", source: { data: image.data } });
    expect(messages[2]?.content).toHaveLength(2);
  });

  it("delivers thinking before text when a proxy combines both in one stream chunk", async () => {
    const provider: RuntimeProviderConfig = {
      id: "proxy-account", name: "Fixture", modelId: "fixture", apiKey: "fixture",
      baseUrl: "https://fixture.invalid/v1", supportsReasoning: true, supportedThinkingLevels: ["off", "high"],
    };
    const model = buildProviderModel(provider);
    const response = createProviderModels(provider, model).streamSimple(model, normalizeContext({
      messages: [{ role: "user", content: "Hello", timestamp: 1 }],
    }), {
      reasoning: "high", maxRetries: 0,
      fetch: async () => new Response('data: {"choices":[{"index":0,"delta":{"reasoning_content":"Plan","content":"Answer"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
        headers: { "content-type": "text/event-stream" },
      }),
    });
    const starts: string[] = [];
    for await (const event of response) {
      if (event.type === "thinking_start" || event.type === "text_start") starts.push(event.type);
    }
    const final = await response.result();
    expect(final.stopReason).toBe("stop");
    expect(starts).toEqual(["thinking_start", "text_start"]);
    expect(final.content.map((block) => block.type)).toEqual(["thinking", "text"]);
  });

  it.each([
    "Unable to forward upstream stream",
    "The service is temporarily unavailable",
    "The upstream provider returned an error",
  ])("classifies the newly recognized transient failure for Desktop retries: %s", (errorMessage) => {
    const error = classifyProviderError({
      role: "assistant", api: "openai-completions", provider: "fixture", model: "fixture",
      content: [], usage, timestamp: 1, stopReason: "error", errorMessage,
    });
    expect(error.retriable).toBe(true);
    expect(isTransientProviderRetryCode(error.code)).toBe(true);
  });
});
