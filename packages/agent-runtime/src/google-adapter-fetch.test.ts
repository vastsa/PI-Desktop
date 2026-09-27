import { afterEach, describe, expect, it, vi } from "vitest";
import { completeOneShot } from "./one-shot-complete.js";
import { subagentModelBinding } from "./subagent-model-binding.js";
import type { RuntimeProviderConfig } from "./provider-binding.js";

const googleProvider: RuntimeProviderConfig = {
  id: "google", name: "Google Gemini", vendorKey: "google",
  apiStyle: "google_generative_ai", baseUrl: "https://generativelanguage.googleapis.com/v1beta",
  modelId: "gemini-3.8-flash", apiKey: "AIza-fixture", authKind: "api_key",
  supportsReasoning: false, supportedThinkingLevels: ["off"],
};
afterEach(() => vi.unstubAllGlobals());

describe("Gemini model access in the platform edition", () => {
  it("refuses an old Google one-shot configuration before the native adapter can send", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    await expect(completeOneShot(googleProvider, { messages: [] }, "off"))
      .rejects.toMatchObject({ errorCode: "PLATFORM_PROVIDER_REQUIRED" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("refuses native Google subagent bindings before request construction", () => {
    expect(() => subagentModelBinding(
      { provider: googleProvider, thinkingLevel: "off", sessionId: "s" },
      { claim: () => undefined },
    )).toThrow(/only supports AI Aggregation Platform/);
  });
  it("runs Gemini through the platform's OpenAI-compatible route with independent auth", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      'data: {"id":"fixture","choices":[{"index":0,"delta":{"role":"assistant","content":"hello"},"finish_reason":null}]}\n\n' +
      'data: {"id":"fixture","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      { headers: { "content-type": "text/event-stream" } },
    ));
    vi.stubGlobal("fetch", fetcher);
    const result = await completeOneShot({
      ...googleProvider, vendorKey: "ai-aggregation-platform", apiStyle: "chat_completions",
      baseUrl: "https://ai.yykkj.com/v1", apiKey: "fixture-platform-key",
    }, { messages: [{ role: "user", content: "hi", timestamp: 0 }] }, "off");
    expect(result.text).toBe("hello");
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0];
    expect(String(url)).toBe("https://ai.yykkj.com/v1/chat/completions");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-platform-key");
    expect(JSON.parse(String(init?.body)).model).toBe(googleProvider.modelId);
  });
});
