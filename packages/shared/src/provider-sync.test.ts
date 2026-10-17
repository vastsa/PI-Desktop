import { describe, expect, it } from "vitest";
import { isSyncableProvider, parseProviderImportPayload, parseProviderImportSummary, PROVIDER_SYNC_MAX_PROVIDERS } from "./provider-sync.js";
import type { ProviderPublic } from "./types/providers.js";

const model = { id: "model/a", contextWindow: 120000, maxTokens: 8000, thinkingLevels: ["off", "high"] as const, defaultThinkingLevel: "high", thinkingProtocol: "adaptive", nativeWebSearch: true };
function payload() {
  return { version: 1, providers: [{ sourceId: "local-1", input: {
    name: "Custom", vendorKey: "custom", type: "openai_compatible", protocol: "openai_compatible",
    baseUrl: "https://models.example/v1", authKind: "api_key_and_base_url", secretValue: "fixture-key",
    models: [{ ...model, thinkingLevels: [...model.thinkingLevels] }], temperature: 0,
  } }], defaultModel: { sourceId: "local-1", modelId: "model/a" } };
}
const provider = { ...payload().providers[0]!.input, id: "local-1", enabled: true, hasSecret: true, supportsReasoning: true, supportedThinkingLevels: ["off", "high"], createdAt: "1", updatedAt: "1" } as ProviderPublic;

describe("provider sync boundary", () => {
  it("preserves current model settings and meaningful zero values", () => {
    const input = payload();
    expect(parseProviderImportPayload(input)).toEqual(input);
    const parsed = parseProviderImportPayload(input);
    input.providers[0]!.input.models[0]!.maxTokens = 1;
    expect(parsed.providers[0]!.input.models![0]!.maxTokens).toBe(8000);
    expect(parsed.providers[0]!.input.temperature).toBe(0);
  });
  it("allows user-created API-key and unauthenticated network providers", () => {
    expect(isSyncableProvider(provider)).toBe(true);
    expect(isSyncableProvider({ ...provider, authKind: "none", hasSecret: false })).toBe(true);
  });
  it.each([
    { authKind: "oauth" }, { hasOauth: true }, { oauthAccountLabel: "account" }, { ownerPluginId: "plugin" },
    { enabled: false }, { hasSecret: false }, { authKind: "aws_sdk_default" }, { protocol: "claude-cli" },
    { vendorKey: "openai-codex" }, { vendorKey: "github-copilot" }, { vendorKey: "ollama" },
    { apiStyle: "openai_codex_responses" }, { baseUrl: "http://localhost:1234/v1" },
    { baseUrl: "http://127.1/v1" }, { baseUrl: "http://[::1]/v1" }, { baseUrl: "http://0.0.0.0/v1" },
    { baseUrl: "http://[::ffff:127.0.0.1]/v1" }, { baseUrl: "file:///models" },
    { baseUrl: "https://user:fixture-key@models.example/v1" }, { baseUrl: "https://models.example?key=fixture-key" },
  ])("excludes nonportable or credential-in-URL rows: %j", (patch) => {
    expect(isSyncableProvider({ ...provider, ...patch })).toBe(false);
  });
  it.each([
    { secretValue: undefined }, { authKind: "oauth" }, { oauthAccountLabel: "fixture-key" }, { ownerPluginId: "plugin" },
    { headers: { Authorization: "fixture-key" } }, { headers: { "x-test": "bad\r\nvalue" } },
    { supportedThinkingLevels: ["secret-level"] }, { temperature: Number.NaN },
    { models: [{ ...model, contextWindow: -1 }] }, { models: [{ ...model, extra: "fixture-key" }] },
    { models: [{ ...model, thinkingLevels: ["not-a-level"] }] }, { models: [{ ...model, defaultThinkingLevel: "low" }] },
    { models: [{ ...model, supportsDocuments: "yes" }] }, { defaultModelId: "missing" },
  ])("rejects malformed inputs without echoing diagnostics: %j", (patch) => {
    const value = payload();
    Object.assign(value.providers[0]!.input, patch);
    expect(() => parseProviderImportPayload(value)).toThrow("Invalid provider import payload");
  });
  it("rejects unknown fields, duplicate ids, oversized batches, and invalid defaults", () => {
    const input = payload();
    for (const value of [null, { ...input, version: 2 }, { ...input, "fixture-key": true },
      { ...input, providers: [] }, { ...input, providers: [input.providers[0], input.providers[0]] },
      { ...input, providers: Array.from({ length: PROVIDER_SYNC_MAX_PROVIDERS + 1 }, (_, i) => ({ ...input.providers[0], sourceId: String(i) })) },
      { ...input, defaultModel: { sourceId: "missing", modelId: "model/a" } },
      { ...input, defaultModel: { sourceId: "local-1", modelId: "missing" } },
    ]) expect(() => parseProviderImportPayload(value)).toThrow("Invalid provider import payload");
  });
  it("sanitizes the returned summary contract", () => {
    const summary = { imported: [{ sourceId: "local-1", providerId: "11111111-1111-4111-8111-111111111111" }], skipped: [], defaultSet: true };
    expect(parseProviderImportSummary(summary)).toEqual(summary);
    expect(() => parseProviderImportSummary({ ...summary, secretValue: "fixture-key" })).toThrow();
    expect(() => parseProviderImportSummary({ imported: [], skipped: [{ sourceId: "local-1", reason: "fixture-key" }], defaultSet: false })).toThrow();
  });
});
