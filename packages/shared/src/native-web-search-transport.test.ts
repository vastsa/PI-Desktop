import { describe, expect, it } from "vitest";
import { nativeWebSearchTransport } from "./native-web-search-transport.js";
import { nativeWebSearchSupportedOn } from "./native-web-search.js";
import { NAMED_ENDPOINT_PRESETS } from "./provider-presets.js";

describe("official native search request routing", () => {
  it("keeps exactly one DeepSeek service preset", () => {
    expect(NAMED_ENDPOINT_PRESETS.filter((preset) => preset.vendorKey === "deepseek").map((preset) => preset.id)).toEqual(["deepseek"]);
  });
  for (const [baseUrl, apiStyle, searchBase] of [
    ["https://api.deepseek.com", "anthropic_messages", "https://api.deepseek.com/anthropic"],
    ["https://api.deepseek.com/v1/", "anthropic_messages", "https://api.deepseek.com/anthropic"],
    ["https://api.x.ai/v1", "responses", "https://api.x.ai/v1"],
    ["https://api.openai.com/v1", "responses", "https://api.openai.com/v1"],
  ]) {
    it(`keeps one saved configuration for ${baseUrl}`, () => {
      const input = { apiStyle: "chat_completions", baseUrl, enabled: true };
      const before = { ...input };
      expect(nativeWebSearchSupportedOn(input.apiStyle, baseUrl)).toBe(true);
      expect(nativeWebSearchTransport(input)).toEqual({ apiStyle, baseUrl: searchBase });
      expect(input).toEqual(before);
      expect(nativeWebSearchTransport({ ...input, enabled: false })).toEqual({ apiStyle: input.apiStyle, baseUrl });
    });
  }

  it("never reroutes relay credentials or guesses from an official-looking hostname", () => {
    for (const baseUrl of [
      "https://relay.example/v1", "https://api.deepseek.com.evil.example",
      "https://api.deepseek.com:8443", "http://api.deepseek.com", "https://api.deepseek.com/private",
      "https://key@api.deepseek.com", "https://api.deepseek.com?key=private", "https://api.deepseek.com/#fragment",
      "https://dashscope.aliyuncs.com/compatible-mode/v1", "https://api.moonshot.cn/v1",
    ]) {
      expect(nativeWebSearchSupportedOn("chat_completions", baseUrl)).toBe(false);
      expect(nativeWebSearchTransport({ apiStyle: "chat_completions", baseUrl, enabled: true }))
        .toEqual({ apiStyle: "chat_completions", baseUrl });
    }
  });

  it("keeps explicit non-Completions protocols and existing search-capable relays unchanged", () => {
    for (const apiStyle of ["anthropic_messages", "responses", "openai_codex_responses", "google_generative_ai", "opencode_go"]) {
      const input = { apiStyle, baseUrl: "https://api.deepseek.com", enabled: true };
      expect(nativeWebSearchTransport(input)).toEqual({ apiStyle, baseUrl: input.baseUrl });
    }
    expect(nativeWebSearchSupportedOn("responses", "https://relay.example/v1")).toBe(true);
    expect(nativeWebSearchSupportedOn("google_generative_ai", "https://generativelanguage.googleapis.com/v1beta")).toBe(false);
  });
});
