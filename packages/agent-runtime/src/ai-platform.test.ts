import { afterEach, expect, it, vi } from "vitest";
import { AI_PLATFORM_BASE_URL, AI_PLATFORM_VENDOR_KEY, PLATFORM_MEDIA_MODELS } from "@pi-desktop/shared";
import {
  buildProviderModel, createProviderModels, createExtensionAgentModels,
  providerRequestFetch, type RuntimeProviderConfig,
} from "./provider-binding.js";
import { completeOneShot } from "./one-shot-complete.js";
import { genericModelConfig } from "./model-capabilities.js";

const provider: RuntimeProviderConfig = {
  id: "platform-row", name: "Platform", vendorKey: AI_PLATFORM_VENDOR_KEY,
  baseUrl: AI_PLATFORM_BASE_URL, authKind: "api_key_and_base_url",
  apiStyle: "chat_completions", apiKey: "fixture-key", modelId: "fixture-chat",
  supportsReasoning: false, supportedThinkingLevels: ["off"],
};
afterEach(() => vi.unstubAllGlobals());

it.each(PLATFORM_MEDIA_MODELS)("rejects media model %s on the text/one-shot transport before network", async (modelId) => {
  const fetcher = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetcher);
  await expect(completeOneShot({ ...provider, modelId }, {
    messages: [{ role: "user", content: "hello", timestamp: 0 }],
  }, "off")).rejects.toThrow(/PlatformMedia/);
  expect(fetcher).not.toHaveBeenCalled();
});

it("does not let publisher metadata change the gateway protocol, headers or URL", () => {
  const model = buildProviderModel({ ...provider, modelConfig: {
    ...genericModelConfig("fixture-chat", "https://publisher.invalid"),
    api: "anthropic-messages", headers: { Authorization: "publisher-key" },
  } });
  expect(model.baseUrl).toBe(AI_PLATFORM_BASE_URL);
  expect(model.api).toBe("openai-completions");
  expect(model.headers ?? {}).not.toHaveProperty("Authorization");
});

it("binds Anthropic messages to the platform root and signs with the separate API key", () => {
  const config = { ...provider, apiStyle: "anthropic_messages" };
  const model = buildProviderModel(config);
  expect(model.baseUrl).toBe("https://ai.yykkj.com");
  expect(() => createProviderModels(config, model)).not.toThrow();
});

it("rejects old endpoints, alternate model URLs, OAuth and missing credentials before transport", () => {
  expect(() => buildProviderModel({ ...provider, baseUrl: "https://api.openai.com/v1" })).toThrow();
  const model = buildProviderModel(provider);
  expect(() => createProviderModels(provider, { ...model, baseUrl: "https://other.invalid/v1" })).toThrow();
  expect(() => createProviderModels({ ...provider, apiKey: "" }, model)).toThrow(/API key/);
  expect(() => createProviderModels({ ...provider, resolveAuth: async () => ({ apiKey: "oauth-key" }) }, model)).toThrow(/account authentication/);
  expect(() => createExtensionAgentModels({ providerId: "plugin", providerName: "Plugin", model, stream: { stream: () => { throw new Error("Must not run"); }, streamSimple: () => { throw new Error("Must not run"); } } })).toThrow(/Extension-owned/);
});

it("rejects credential redirects and alternate URLs at the request boundary", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("ok"));
  const guarded = providerRequestFetch("openai-completions", fetcher)!;
  await guarded(`${AI_PLATFORM_BASE_URL}/chat/completions`);
  expect(fetcher.mock.calls[0][1]?.redirect).toBe("error");
  await expect(guarded("https://outside.invalid/v1/chat/completions")).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("completes through the real pi adapter with platform URL and independent credential", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response([
    'data: {"id":"fixture","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"platform ok"},"finish_reason":null}]}',
    'data: {"id":"fixture","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
    "data: [DONE]",
  ].join("\n\n") + "\n\n", { headers: { "content-type": "text/event-stream" } }));
  vi.stubGlobal("fetch", fetcher);
  const result = await completeOneShot(provider, {
    messages: [{ role: "user", content: "hello", timestamp: 0 }],
  }, "off");
  expect(result.text).toBe("platform ok");
  expect(fetcher).toHaveBeenCalledTimes(1);
  const [input, init] = fetcher.mock.calls[0];
  expect(String(input)).toBe(`${AI_PLATFORM_BASE_URL}/chat/completions`);
  expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-key");
  expect(init?.redirect).toBe("error");
});
