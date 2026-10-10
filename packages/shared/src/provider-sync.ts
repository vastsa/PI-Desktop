import { HEADER_VALUE_ALLOWED } from "./header-value.js";
import { THINKING_LEVELS, type ModelBinding } from "./types/models.js";
import type { ProviderCreateInput, ProviderPublic } from "./types/providers.js";

/** This document is secret-bearing: SSH stdin / owner-only admin socket only. */
export const PROVIDER_SYNC_MAX_PROVIDERS = 32;
export const PROVIDER_SYNC_MAX_BYTES = 1024 * 1024;
export type ProviderImportPayload = {
  version: 1;
  providers: Array<{ sourceId: string; input: ProviderCreateInput }>;
  defaultModel?: { sourceId: string; modelId: string };
};
export type ProviderImportSummary = {
  imported: Array<{ sourceId: string; providerId: string }>;
  skipped: Array<{ sourceId: string; reason: string }>;
  defaultSet: boolean;
};
export const PROVIDER_SYNC_SKIP_REASONS = ["import_incomplete", "remote_changed", "remote_missing"] as const;

const AUTH_KINDS = new Set(["api_key", "api_key_and_base_url", "bearer", "azure_api_key", "none"]);
const PROTOCOLS = new Set(["openai", "anthropic", "google", "openai_compatible", "custom_http"]);
const API_STYLES = new Set(["auto", "chat_completions", "responses", "anthropic_messages", "google_generative_ai", "opencode_go", "pi_messages"]);
const EXCLUDED_VENDORS = new Set(["claude-cli", "codex", "openai-codex", "github-copilot", "google-antigravity", "google-gemini-cli", "ollama", "lmstudio", "lm-studio", "local"]);
const RESERVED_HEADERS = new Set(["authorization", "proxy-authorization", "x-api-key", "api-key", "x-goog-api-key", "cookie", "set-cookie", "host", "content-type", "content-length", "connection", "transfer-encoding", "te", "trailer", "upgrade", "keep-alive", "chatgpt-account-id", "x-opencode-session"]);
const INPUT_FIELDS = ["name", "vendorKey", "type", "protocol", "baseUrl", "authKind", "models", "defaultModelId", "secretValue", "apiStyle", "headers", "supportsReasoning", "supportedThinkingLevels", "contextWindow", "maxOutputTokens", "temperature"];
const MODEL_FIELDS = ["id", "alias", "contextWindow", "contextWindowSource", "maxTokens", "maxTokensSource", "thinkingLevels", "defaultThinkingLevel", "thinkingProtocol", "supportsImages", "supportsDocuments", "availableForSubagents", "nativeWebSearch"];

function invalid(): never {
  // Never include input values, unknown field names, parser diagnostics or causes.
  throw Object.assign(new Error("Invalid provider import payload"), { errorCode: "INVALID_ARGUMENT" });
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function fields(value: unknown, allowed: readonly string[]): asserts value is Record<string, unknown> {
  if (!record(value) || Object.keys(value).some((key) => !allowed.includes(key))) invalid();
}
function text(value: unknown, max = 256): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && value.trim() === value && !/[\x00-\x1f\x7f]/.test(value);
}
function nonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function levels(value: unknown): boolean {
  return Array.isArray(value) && value.length <= THINKING_LEVELS.length && new Set(value).size === value.length && value.every((level) => THINKING_LEVELS.includes(level));
}
function networkEndpoint(baseUrl: string | undefined, vendorKey: string | undefined): boolean {
  if (!baseUrl) return vendorKey === "openai" || vendorKey === "anthropic" || vendorKey === "google";
  try {
    const url = new URL(baseUrl);
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return false;
    // Do not transfer endpoints that refer to the *desktop's* own runtime.
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host === "[::]" || host === "[::1]" || host.startsWith("[::ffff:")) return false;
    return !/^(127\.|0\.|169\.254\.)/.test(host);
  } catch {
    return false;
  }
}
function syncableConnection(provider: ProviderCreateInput): boolean {
  return AUTH_KINDS.has(provider.authKind ?? "") && PROTOCOLS.has(provider.protocol ?? "")
    && !EXCLUDED_VENDORS.has(provider.vendorKey ?? "")
    && (provider.apiStyle === undefined || API_STYLES.has(provider.apiStyle))
    && networkEndpoint(provider.baseUrl, provider.vendorKey);
}

/** The UI filter is also enforced in main and at the host import boundary. */
export function isSyncableProvider(provider: ProviderPublic): boolean {
  return provider.enabled && !provider.ownerPluginId && !provider.hasOauth && !provider.oauthAccountLabel
    && (provider.authKind === "none" ? !provider.hasSecret : provider.hasSecret)
    && provider.models.length > 0 && syncableConnection(provider);
}

function validateModel(value: unknown): ModelBinding {
  fields(value, MODEL_FIELDS);
  if (!text(value.id) || !nonnegative(value.contextWindow) || !Number.isSafeInteger(value.contextWindow)
    || !nonnegative(value.maxTokens) || !Number.isSafeInteger(value.maxTokens) || !levels(value.thinkingLevels)) invalid();
  if (value.alias !== undefined && !text(value.alias, 60)) invalid();
  for (const key of ["contextWindowSource", "maxTokensSource"] as const) {
    if (value[key] !== undefined && value[key] !== "catalog" && value[key] !== "user") invalid();
  }
  const thinking = value.defaultThinkingLevel;
  if (thinking !== null && thinking !== "omit" && !(typeof thinking === "string" && (value.thinkingLevels as string[]).includes(thinking))) invalid();
  if (value.thinkingProtocol !== undefined && value.thinkingProtocol !== "legacy" && value.thinkingProtocol !== "adaptive") invalid();
  for (const key of ["supportsImages", "supportsDocuments"] as const) {
    if (value[key] !== undefined && value[key] !== null && typeof value[key] !== "boolean") invalid();
  }
  for (const key of ["availableForSubagents", "nativeWebSearch"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "boolean") invalid();
  }
  return value as ModelBinding;
}
function validateInput(value: unknown): ProviderCreateInput {
  fields(value, INPUT_FIELDS);
  if (!text(value.name) || !text(value.vendorKey) || !text(value.protocol) || !text(value.authKind)) invalid();
  if (value.type !== "native" && value.type !== "openai_compatible" && value.type !== "custom") invalid();
  if (value.baseUrl !== undefined && !text(value.baseUrl, 4096)) invalid();
  if (value.apiStyle !== undefined && !text(value.apiStyle)) invalid();
  if (value.supportsReasoning !== undefined && typeof value.supportsReasoning !== "boolean") invalid();
  if (value.supportedThinkingLevels !== undefined && !levels(value.supportedThinkingLevels)) invalid();
  for (const key of ["contextWindow", "maxOutputTokens", "temperature"] as const) {
    if (value[key] !== undefined && (!nonnegative(value[key]) || (key !== "temperature" && !Number.isSafeInteger(value[key])))) invalid();
  }
  if (!Array.isArray(value.models) || value.models.length < 1 || value.models.length > 512) invalid();
  const models = value.models.map(validateModel);
  if (new Set(models.map((model) => model.id)).size !== models.length) invalid();
  if (value.defaultModelId !== undefined && !models.some((model) => model.id === value.defaultModelId)) invalid();
  if (value.headers !== undefined) {
    if (!record(value.headers) || Object.keys(value.headers).length > 32) invalid();
    const seen = new Set<string>();
    for (const [key, header] of Object.entries(value.headers)) {
      const lower = key.toLowerCase();
      if (!/^[0-9A-Za-z][0-9A-Za-z-]{0,255}$/.test(key) || RESERVED_HEADERS.has(lower) || seen.has(lower)
        || typeof header !== "string" || new TextEncoder().encode(header).length > 4096 || !HEADER_VALUE_ALLOWED.test(header)) invalid();
      seen.add(lower);
    }
  }
  if (value.authKind === "none") {
    if (value.secretValue !== undefined) invalid();
  } else if (!text(value.secretValue, 16384)) invalid();
  const input = value as ProviderCreateInput;
  if (!syncableConnection(input)) invalid();
  return input;
}

/** Strict, bounded v1 contract. Validates the whole batch before any mutation. */
export function parseProviderImportPayload(value: unknown): ProviderImportPayload {
  fields(value, ["version", "providers", "defaultModel"]);
  if (value.version !== 1 || !Array.isArray(value.providers) || value.providers.length < 1 || value.providers.length > PROVIDER_SYNC_MAX_PROVIDERS) invalid();
  const seen = new Set<string>();
  const providers = value.providers.map((entry: unknown) => {
    fields(entry, ["sourceId", "input"]);
    if (!text(entry.sourceId) || seen.has(entry.sourceId)) invalid();
    seen.add(entry.sourceId);
    return { sourceId: entry.sourceId, input: validateInput(entry.input) };
  });
  let defaultModel: ProviderImportPayload["defaultModel"];
  if (value.defaultModel !== undefined) {
    const wanted = value.defaultModel;
    fields(wanted, ["sourceId", "modelId"]);
    if (!text(wanted.sourceId) || !text(wanted.modelId)
      || !providers.find((entry) => entry.sourceId === wanted.sourceId)?.input.models?.some((model) => model.id === wanted.modelId)) invalid();
    defaultModel = { sourceId: wanted.sourceId, modelId: wanted.modelId };
  }
  const result: ProviderImportPayload = { version: 1, providers, ...(defaultModel ? { defaultModel } : {}) };
  if (new TextEncoder().encode(JSON.stringify(result)).length > PROVIDER_SYNC_MAX_BYTES) invalid();
  // Snapshot references before the first await in callers.
  return structuredClone(result);
}

/** Do not allow arbitrary host output/extra properties to reach the renderer. */
export function parseProviderImportSummary(value: unknown): ProviderImportSummary {
  fields(value, ["imported", "skipped", "defaultSet"]);
  if (!Array.isArray(value.imported) || !Array.isArray(value.skipped) || typeof value.defaultSet !== "boolean"
    || value.imported.length + value.skipped.length > PROVIDER_SYNC_MAX_PROVIDERS) invalid();
  const seen = new Set<string>();
  for (const entry of value.imported) {
    fields(entry, ["sourceId", "providerId"]);
    if (!text(entry.sourceId) || seen.has(entry.sourceId) || typeof entry.providerId !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(entry.providerId)) invalid();
    seen.add(entry.sourceId);
  }
  for (const entry of value.skipped) {
    fields(entry, ["sourceId", "reason"]);
    if (!text(entry.sourceId) || seen.has(entry.sourceId) || !PROVIDER_SYNC_SKIP_REASONS.some((reason) => reason === entry.reason)) invalid();
    seen.add(entry.sourceId);
  }
  return structuredClone(value) as ProviderImportSummary;
}
