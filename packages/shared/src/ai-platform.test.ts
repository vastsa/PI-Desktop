import { describe, expect, it } from "vitest";
import {
  AI_PLATFORM_BASE_URL, AI_PLATFORM_VENDOR_KEY,
  assertAIPlatformProvider, assertAIPlatformRequestUrl, type PlatformProvider,
} from "./ai-platform.js";

const platform = {
  vendorKey: AI_PLATFORM_VENDOR_KEY, baseUrl: AI_PLATFORM_BASE_URL,
  authKind: "api_key_and_base_url", apiStyle: "chat_completions",
};

describe("platform-only routing contract", () => {
  it.each(["chat_completions", "responses", "anthropic_messages"])("permits %s on the fixed platform", (apiStyle) => {
    expect(() => assertAIPlatformProvider({ ...platform, apiStyle })).not.toThrow();
  });
  it.each<Partial<PlatformProvider>>([
    { baseUrl: "https://api.openai.com/v1" },
    { baseUrl: "https://ai.yykkj.com.evil.test/v1" },
    { baseUrl: "http://ai.yykkj.com/v1" },
    { baseUrl: "https://ai.yykkj.com/v1?target=other" },
    { vendorKey: "openai" }, { authKind: "oauth" }, { authKind: "none" },
    { apiStyle: "google_generative_ai" }, { apiStyle: "openai_codex_responses" },
    { extensionAgentKey: "plugin:agent" }, { ownerPluginId: "plugin" },
    { headers: { aUtHoRiZaTiOn: "Bearer different-account" } },
    { headers: { Host: "another.example" } },
  ])("rejects an alternate route or credential source: %j", (override) => {
    expect(() => assertAIPlatformProvider({ ...platform, ...override })).toThrow(/only supports/);
  });
  it.each([
    "https://ai.yykkj.com/v1/chat/completions", "https://ai.yykkj.com/v1/messages",
    "https://ai.yykkj.com/v1/responses",
  ])("permits platform wire endpoint %s", (url) => {
    expect(() => assertAIPlatformRequestUrl(url)).not.toThrow();
  });
  it.each([
    "https://ai.yykkj.com/v1/../api/user/self", "https://ai.yykkj.com/v1.evil/responses",
    "https://key@ai.yykkj.com/v1/messages", "http://localhost:3000/v1/chat/completions",
  ])("rejects URL escape %s", (url) => {
    expect(() => assertAIPlatformRequestUrl(url)).toThrow();
  });
});
