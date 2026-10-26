import { describe, expect, it } from "vitest";
import { normalizeProviderTemplate, parseProviderTemplate, validateManifest, type PluginProviderTemplateV1 } from "./index.js";

const base = { schemaVersion: 1, id: "demo.templates", name: "Templates", version: "1.0.0", main: "main.js" };
const template: PluginProviderTemplateV1 = { version: 1, id: "cloud", name: "Cloud", baseUrl: "https://api.example.com", authKind: "oauth", models: [{ id: "chat" }],
  oauth: { flow: "authorization_code", clientId: "public", authorizationUrl: "https://auth.example.com/authorize", tokenUrl: "https://auth.example.com/token", scopes: ["read"] } };
const manifest = (value: unknown, permissions = ["provider.register"]) => validateManifest({ ...base, permissions, contributes: { providerTemplates: [value] } });

describe("provider templates v1", () => {
  it("accepts declarative OAuth with only register and strips executable configuration for Host rows", () => {
    expect(manifest(template).ok).toBe(true);
    expect(parseProviderTemplate(template).ok).toBe(true);
    expect(normalizeProviderTemplate(template)).toEqual({ id: "cloud", name: "Cloud", baseUrl: "https://api.example.com", authKind: "oauth", models: [{ id: "chat" }], oauth: {} });
    expect(template.oauth?.flow).toBe("authorization_code");
  });
  it("keeps legacy/custom OAuth and adapter permissions", () => {
    const custom = { ...template, oauth: { loginLabel: "Connect" } };
    expect(manifest(custom).ok).toBe(false);
    expect(manifest(custom, ["provider.register", "provider.oauth"]).ok).toBe(true);
    expect(manifest({ ...template, oauth: { flow: "custom" } }, ["provider.register", "provider.oauth"]).ok).toBe(true);
    expect(validateManifest({ ...base, permissions: ["provider.register"], contributes: { providers: [normalizeProviderTemplate(template)] } }).ok).toBe(false);
    expect(manifest({ ...template, adapter: { version: 1, chat: true } }).ok).toBe(false);
    expect(manifest({ ...template, adapter: { version: 1, chat: true } }, ["provider.register", "provider.inference"]).ok).toBe(true);
    expect(manifest(template, []).ok).toBe(false);
  });
  it("accepts device-code declarations and legacy API-key templates", () => {
    expect(manifest({ ...template, oauth: { flow: "device_code", clientId: "public", tokenUrl: "https://auth.example.com/token", deviceAuthorizationUrl: "https://auth.example.com/device" } }).ok).toBe(true);
    expect(manifest({ version: 1, id: "key", name: "Key", baseUrl: "https://api.example.com", models: [] }).ok).toBe(true);
  });
  it.each([
    { ...template, version: 2 }, { ...template, surprise: true }, { ...template, models: [{ id: "x", extra: true }] },
    { ...template, models: [{ id: "x", maxTokens: 0 }] }, { ...template, models: [{ id: "x" }, { id: "x" }] },
    { ...template, oauth: { ...template.oauth, clientSecret: "forbidden" } },
    { ...template, oauth: { ...template.oauth, flow: "unknown" } },
    { ...template, oauth: { flow: null } }, { ...template, oauth: { flow: ["custom"] } },
    { ...template, oauth: { ...template.oauth, tokenUrl: "https:auth.example.com/token" } },
    { ...template, oauth: { ...template.oauth, tokenUrl: "https://auth.example.com/token#" } },
    { ...template, oauth: { ...template.oauth, clientId: "" } },
    { ...template, oauth: { ...template.oauth, tokenUrl: "http://localhost/token" } },
    { ...template, oauth: { ...template.oauth, tokenUrl: "https://user:secret@example.com/token" } },
    { ...template, oauth: { ...template.oauth, tokenUrl: "https://example.com/token#fragment" } },
    { ...template, oauth: { ...template.oauth, authorizationUrl: undefined } },
    { ...template, oauth: { ...template.oauth, redirectPath: "//evil.com" } },
    { ...template, oauth: { ...template.oauth, redirectPath: "/callback?x=1" } },
    { ...template, oauth: { ...template.oauth, scopes: ["read write"] } },
    { ...template, oauth: { ...template.oauth, deviceAuthorizationUrl: "https://auth.example.com/device" } },
    { ...template, oauth: { flow: "custom", clientId: "public" } },
    { ...template, authKind: "api_key" },
  ])("rejects invalid/unknown declaration fields %#", value => {
    expect(parseProviderTemplate(value).ok).toBe(false);
    expect(manifest(value, ["provider.register", "provider.oauth"]).ok).toBe(false);
  });
  it("rejects duplicate IDs within templates and across legacy declarations", () => {
    expect(validateManifest({ ...base, permissions: ["provider.register", "provider.oauth"], contributes: { providers: [normalizeProviderTemplate(template)], providerTemplates: [template] } }).ok).toBe(false);
    expect(validateManifest({ ...base, permissions: ["provider.register"], contributes: { providerTemplates: [template, template] } }).ok).toBe(false);
    expect(validateManifest({ ...base, contributes: { providerTemplates: null } }).ok).toBe(false);
  });
});

describe("versioned template bounds (source SDK)", () => {
  const accepted = (value: unknown) => {
    expect(parseProviderTemplate(value).ok).toBe(true);
    expect(manifest(value).ok).toBe(true);
  };
  const rejected = (value: unknown) => {
    expect(parseProviderTemplate(value).ok).toBe(false);
    expect(manifest(value).ok).toBe(false);
  };
  it.each([
    ["name", 128], ["vendorKey", 128], ["category", 128], ["description", 280],
  ] as const)("bounds %s in UTF-16 units and rejects controls", (field, max) => {
    accepted({ ...template, [field]: "x".repeat(max) });
    rejected({ ...template, [field]: "x".repeat(max + 1) });
    accepted({ ...template, [field]: "😀".repeat(max / 2) });
    rejected({ ...template, [field]: "😀".repeat(max / 2) + "x" });
    for (const bad of ["", "  ", "line\nbreak", "nul\u0000", "del\u007f", "c1\u0085", "c1\u009f", null, 1]) rejected({ ...template, [field]: bad });
  });
  it.each([["category", 128], ["description", 280]] as const)("closes localized %s", (field, max) => {
    accepted({ ...template, [field]: { en: "x".repeat(max), "zh-CN": "中".repeat(max) } });
    for (const value of [{ en: "ok" }, { en: "ok", "zh-CN": "ok", fr: "no" }, { en: "ok", "zh-CN": "x".repeat(max + 1) }, { en: "ok\n", "zh-CN": "ok" }]) rejected({ ...template, [field]: value });
  });
  it("bounds all model text, count, thinking levels and uint32 limits", () => {
    for (const [field, max] of [["id", 256], ["name", 128], ["defaultThinkingLevel", 64]] as const) {
      accepted({ ...template, models: [{ id: "chat", [field]: "x".repeat(max) }] });
      for (const value of ["x".repeat(max + 1), "", "\t", "x\u0080"]) rejected({ ...template, models: [{ id: "chat", [field]: value }] });
    }
    accepted({ ...template, models: Array.from({ length: 64 }, (_, i) => ({ id: `model-${i}` })) });
    rejected({ ...template, models: Array.from({ length: 65 }, (_, i) => ({ id: `model-${i}` })) });
    accepted({ ...template, models: [{ id: "chat", thinkingLevels: Array(16).fill("x".repeat(64)) }] });
    for (const levels of [Array(17).fill("ok"), ["x".repeat(65)], [""], ["x\u009f"]]) rejected({ ...template, models: [{ id: "chat", thinkingLevels: levels }] });
    for (const field of ["contextWindow", "maxTokens"]) {
      accepted({ ...template, models: [{ id: "chat", [field]: 0xffffffff }] });
      for (const value of [0x100000000, -1, 1.5, Infinity, "1", null]) rejected({ ...template, models: [{ id: "chat", [field]: value }] });
    }
    rejected({ ...template, models: [{ id: "chat", supportsImages: 1 }] });
  });
  it("bounds provider IDs, enums and model discovery conditions", () => {
    accepted({ ...template, id: "a".repeat(64) });
    for (const id of ["a".repeat(65), "1bad", "bad.id", "bad\n"]) rejected({ ...template, id });
    rejected({ ...template, apiStyle: "unknown" });
    rejected({ ...template, authKind: "unknown" });
    rejected({ ...template, baseUrl: undefined });
    rejected({ ...template, models: [] });
    rejected({ version: 1, id: "none", name: "None", authKind: "none", models: [] });
  });
  it("accepts bounded transport http(s) and rejects parser-normalized URL hazards", () => {
    const url = "https://api.example.com/";
    accepted({ ...template, baseUrl: url + "x".repeat(2048 - url.length) });
    accepted({ ...template, baseUrl: "http://localhost:8080/v1" });
    for (const baseUrl of [url + "x".repeat(2049 - url.length), "https://", "https:///api.example.com", "https://user:pass@api.example.com", "https://@api.example.com", "https://api.example.com/#", "https://api.example.com/a b", "https://api.example.com/a\u0085b", "https://api.example.com/a\\b", "https://api.example.com/\n", "ftp://api.example.com"]) rejected({ ...template, baseUrl });
  });
  it("bounds OAuth client, label, URLs, scopes and callback path", () => {
    for (const [field, max] of [["clientId", 512], ["loginLabel", 128]] as const) {
      accepted({ ...template, oauth: { ...template.oauth, [field]: "x".repeat(max) } });
      for (const value of ["x".repeat(max + 1), "x\n", "x\u0085"]) rejected({ ...template, oauth: { ...template.oauth, [field]: value } });
    }
    for (const field of ["authorizationUrl", "tokenUrl", "deviceAuthorizationUrl"]) {
      const oauth = field === "deviceAuthorizationUrl" ? { flow: "device_code", clientId: "public", tokenUrl: template.oauth!.tokenUrl, deviceAuthorizationUrl: "https://auth.example.com/device" } : template.oauth;
      const prefix = "https://auth.example.com/";
      accepted({ ...template, oauth: { ...oauth, [field]: prefix + "x".repeat(2048 - prefix.length) } });
      for (const value of [prefix + "x".repeat(2049 - prefix.length), "http://auth.example.com", "https://@auth.example.com", "https://auth.example.com/#", "https://auth.example.com/a b", "https://auth.example.com/a\\b", "https:///auth.example.com"]) rejected({ ...template, oauth: { ...oauth, [field]: value } });
    }
    accepted({ ...template, oauth: { ...template.oauth, scopes: Array.from({ length: 64 }, (_, i) => `${i}`.padEnd(256, "x")), redirectPath: "/" + "x".repeat(255) } });
    for (const scopes of [Array.from({ length: 65 }, (_, i) => `${i}`), ["x".repeat(257)], ["read", "read"], ["read\u0085"], [""]]) rejected({ ...template, oauth: { ...template.oauth, scopes } });
    for (const redirectPath of ["/" + "x".repeat(256), "/../callback", "/./callback", "/a\n"]) rejected({ ...template, oauth: { ...template.oauth, redirectPath } });
  });
  it("leaves legacy declarations unchanged", () => {
    const legacy = { id: "old", name: "x".repeat(129), vendorKey: "x".repeat(129), baseUrl: "https://", models: [{ id: "chat", name: "x".repeat(129) }] };
    expect(validateManifest({ ...base, permissions: ["provider.register"], contributes: { providers: [legacy] } }).ok).toBe(true);
    rejected({ ...legacy, version: 1 });
  });
});
