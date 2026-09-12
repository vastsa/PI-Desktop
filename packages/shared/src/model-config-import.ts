/**
 * Parse model/provider configuration from the same local agent stores the
 * session importer already scans. Secrets stay on the draft; the public
 * candidate sent to the renderer never includes a key.
 *
 * Explicit import only — D007 still forbids auto-import of `~/.pi`.
 */

import {
  apiStyleForAdapter,
  bindingForCustomModel,
  type CatalogApiStyle,
} from "./model-catalog.js";
import { matchNamedPreset, normalizeEndpointUrl } from "./provider-presets.js";
import type { ModelBinding, ProviderCreateInput, ThinkingLevel } from "./types.js";

export const MODEL_CONFIG_IMPORT_SOURCES = [
  "claude-code",
  "opencode",
  "codex",
  "pi",
  "cc-switch",
] as const;

export type ModelConfigImportSource = (typeof MODEL_CONFIG_IMPORT_SOURCES)[number];

export type ModelConfigImportCandidate = {
  source: ModelConfigImportSource;
  externalId: string;
  name: string;
  baseUrl: string | null;
  apiStyle: CatalogApiStyle;
  modelIds: string[];
  hasSecret: boolean;
};

export type ModelConfigImportDraft = ModelConfigImportCandidate & {
  vendorKey: string;
  models: ModelBinding[];
  secretValue?: string;
  supportsReasoning?: boolean;
};

export type ModelConfigImportRunResult = {
  imported: number;
  skipped: number;
  failed: number;
};

export type ModelConfigImportEnv = Record<string, string | undefined>;

/** One provider row from CC Switch (`~/.cc-switch/cc-switch.db` or legacy JSON). */
export type CcSwitchProviderRow = {
  id: string;
  appType: string;
  name: string;
  settingsConfig: unknown;
};

const MAX_MODELS_PER_PROVIDER = 64;
const MAX_NAME_LENGTH = 80;

const API_STYLE_ALIASES: Record<string, CatalogApiStyle> = {
  chat: "chat_completions",
  chat_completions: "chat_completions",
  "chat-completions": "chat_completions",
  completions: "chat_completions",
  "openai-chat": "chat_completions",
  "openai-completions": "chat_completions",
  openai_completions: "chat_completions",
  responses: "responses",
  "openai-responses": "responses",
  openai_responses: "responses",
  anthropic: "anthropic_messages",
  anthropic_messages: "anthropic_messages",
  "anthropic-messages": "anthropic_messages",
  google: "google_generative_ai",
  google_generative_ai: "google_generative_ai",
  "google-generative-ai": "google_generative_ai",
  openai_codex_responses: "openai_codex_responses",
  "openai-codex-responses": "openai_codex_responses",
  "openai-codex": "openai_codex_responses",
  pi_messages: "pi_messages",
  "pi-messages": "pi_messages",
  opencode_go: "opencode_go",
  "opencode-go": "opencode_go",
};

export function isModelConfigImportSource(
  value: unknown,
): value is ModelConfigImportSource {
  return (
    typeof value === "string" &&
    (MODEL_CONFIG_IMPORT_SOURCES as readonly string[]).includes(value)
  );
}

export function modelConfigImportKey(
  source: ModelConfigImportSource,
  externalId: string,
): string {
  return `${source}:${externalId}`;
}

export function publicModelConfigCandidate(
  draft: ModelConfigImportDraft,
): ModelConfigImportCandidate {
  return {
    source: draft.source,
    externalId: draft.externalId,
    name: draft.name,
    baseUrl: draft.baseUrl,
    apiStyle: draft.apiStyle,
    modelIds: draft.modelIds,
    hasSecret: draft.hasSecret,
  };
}

export function providerCreateInputFromDraft(
  draft: ModelConfigImportDraft,
): ProviderCreateInput {
  return {
    name: draft.name,
    vendorKey: draft.vendorKey,
    type: "openai_compatible",
    protocol: "openai_compatible",
    baseUrl: draft.baseUrl ?? undefined,
    authKind: "api_key_and_base_url",
    models: draft.models,
    defaultModelId: draft.models[0]?.id,
    secretValue: draft.secretValue,
    apiStyle: draft.apiStyle,
    supportsReasoning: draft.supportsReasoning,
  };
}

export function existingProviderMatchKey(input: {
  baseUrl?: string | null;
  apiStyle?: string | null;
  vendorKey?: string | null;
}): string {
  const url = normalizeEndpointUrl(input.baseUrl ?? undefined);
  const style = (input.apiStyle ?? "").trim().toLowerCase();
  if (url) return `url:${url}|${style}`;
  return `vendor:${(input.vendorKey ?? "custom").trim().toLowerCase()}|${style}`;
}

export function draftMatchesExisting(
  draft: Pick<
    ModelConfigImportDraft,
    "baseUrl" | "apiStyle" | "vendorKey" | "secretValue" | "hasSecret"
  >,
  existing: Array<{
    baseUrl?: string | null;
    apiStyle?: string | null;
    vendorKey?: string | null;
    secretValue?: string;
    hasSecret?: boolean;
  }>,
): boolean {
  const key = existingProviderMatchKey(draft);
  return existing.some(
    (row) =>
      existingProviderMatchKey(row) === key &&
      importCredentialsMatch(draft, row),
  );
}

/**
 * Endpoint identity alone is not enough for an imported provider: two CC
 * Switch profiles may intentionally point at one gateway with different API
 * keys. The raw values stay in Electron main; this comparison is never used
 * for the public renderer candidate.
 */
function importCredentialsMatch(
  left: { secretValue?: string; hasSecret?: boolean },
  right: { secretValue?: string; hasSecret?: boolean },
): boolean {
  const leftSecret = sanitizeSecret(left.secretValue);
  const rightSecret = sanitizeSecret(right.secretValue);
  if (leftSecret || rightSecret) return leftSecret === rightSecret;
  return left.hasSecret !== true && right.hasSecret !== true;
}

export function parseJsonDocument(text: string): unknown | null {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // fall through to JSONC
  }
  try {
    return JSON.parse(stripTrailingCommas(stripJsonc(text))) as unknown;
  } catch {
    return null;
  }
}

/** Strip line and block comments that sit outside JSON strings. */
function stripJsonc(text: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  let quote = "";
  let escaped = false;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) inString = false;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "/") {
      i += 2;
      while (i < text.length && text[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i + 1 < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * Drop a comma that only whitespace separates from a closing `}` or `]`.
 * JSONC editors leave these behind routinely (opencode.jsonc in particular),
 * and `JSON.parse` rejects the whole document over one of them. Runs on
 * comment-free text so a `,` inside a comment cannot confuse it; commas inside
 * strings are left alone.
 */
function stripTrailingCommas(text: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  let quote = "";
  let escaped = false;
  while (i < text.length) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) inString = false;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j += 1;
      if (text[j] === "}" || text[j] === "]") {
        i += 1;
        continue;
      }
    }
    out += ch;
    i += 1;
  }
  return out;
}

export function parseClaudeCodeModelConfig(
  settings: unknown,
  localSettings?: unknown,
): ModelConfigImportDraft[] {
  const global = asRecord(settings) ?? {};
  const local = asRecord(localSettings) ?? {};
  const env = {
    ...stringMap(global.env),
    ...stringMap(local.env),
  };
  const baseUrl = firstString(env.ANTHROPIC_BASE_URL, env.ANTHROPIC_API_URL);
  const secret = firstSecret(
    env.ANTHROPIC_API_KEY,
    env.ANTHROPIC_AUTH_TOKEN,
  );
  const modelIds = uniqueModelIds([
    firstString(local.model, global.model),
    env.ANTHROPIC_DEFAULT_SONNET_MODEL,
    env.ANTHROPIC_DEFAULT_OPUS_MODEL,
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
    env.ANTHROPIC_MODEL,
  ]);
  if (modelIds.length === 0) return [];
  if (!baseUrl && !secret) return [];
  return [
    finishDraft({
      source: "claude-code",
      externalId: "default",
      name: "Claude Code",
      baseUrl,
      apiStyle: "anthropic_messages",
      vendorHint: baseUrl ? "custom" : "anthropic",
      modelIds,
      secretValue: secret,
    }),
  ].filter((draft): draft is ModelConfigImportDraft => draft !== null);
}

export function parseOpenCodeModelConfig(
  config: unknown,
  auth?: unknown,
  env: ModelConfigImportEnv = {},
): ModelConfigImportDraft[] {
  const root = asRecord(config) ?? {};
  const providers = asRecord(root.provider) ?? asRecord(root.providers) ?? {};
  const authMap = asRecord(auth) ?? {};
  const defaultModel = firstString(root.model);
  const drafts: ModelConfigImportDraft[] = [];
  for (const [id, raw] of Object.entries(providers)) {
    const record = asRecord(raw);
    if (!record) continue;
    const options = asRecord(record.options) ?? {};
    const baseUrl = firstString(
      options.baseURL,
      options.baseUrl,
      record.baseURL,
      record.baseUrl,
    );
    const npm = firstString(record.npm, record.adapter);
    const apiStyle =
      resolveApiStyle(firstString(record.api, options.api, record.apiStyle)) ??
      (npm ? apiStyleForAdapter(npm) : undefined);
    const ownModelIds = modelIdsFromUnknown(record.models);
    const modelIds = uniqueModelIds([
      ...ownModelIds,
      ...(ownModelIds.length === 0 ? [defaultModelForProvider(id, defaultModel)] : []),
    ]);
    if (modelIds.length === 0) continue;
    const secret = firstSecret(
      resolveSecret(options.apiKey ?? record.apiKey, env),
      authApiKey(authMap[id]),
      secretFromAuthHeader(options.headers ?? record.headers),
    );
    const draft = finishDraft({
      source: "opencode",
      externalId: id,
      name: firstString(record.name, record.label) || id,
      baseUrl,
      apiStyle: apiStyle ?? "chat_completions",
      vendorHint: id,
      modelIds,
      secretValue: secret,
      models: modelBindingsFromUnknown(record.models, modelIds),
    });
    if (draft) drafts.push(draft);
  }
  return drafts;
}

export function parseCodexModelConfig(
  toml: string,
  env: ModelConfigImportEnv = {},
): ModelConfigImportDraft[] {
  const extracted = parseTomlSubset(toml);
  const drafts: ModelConfigImportDraft[] = [];
  const defaultModel = stringValue(extracted.root.model);
  for (const [tableKey, fields] of extracted.tables) {
    if (!tableKey.startsWith("model_providers.")) continue;
    const id = tableKey.slice("model_providers.".length);
    if (!id) continue;
    if (fields.requires_openai_auth === true && !stringValue(fields.env_key) && !stringValue(fields.api_key)) {
      continue;
    }
    const baseUrl = stringValue(fields.base_url) ?? stringValue(fields.baseUrl);
    const envKey = stringValue(fields.env_key) ?? stringValue(fields.envKey);
    const secret = firstSecret(
      resolveSecret(stringValue(fields.api_key) ?? stringValue(fields.apiKey), env),
      envKey ? env[envKey] : undefined,
    );
    const wire = stringValue(fields.wire_api) ?? stringValue(fields.wireApi);
    const modelIds = uniqueModelIds([
      defaultModel,
      ...splitCsv(stringValue(fields.models)),
    ]);
    if (modelIds.length === 0) continue;
    const draft = finishDraft({
      source: "codex",
      externalId: id,
      name: stringValue(fields.name) || id,
      baseUrl,
      apiStyle: resolveApiStyle(wire) ?? "chat_completions",
      vendorHint: id,
      modelIds,
      secretValue: secret,
    });
    if (draft) drafts.push(draft);
  }
  return drafts;
}

export function parsePiModelConfig(
  modelsJson: unknown,
  env: ModelConfigImportEnv = {},
): ModelConfigImportDraft[] {
  const root = asRecord(modelsJson) ?? {};
  const providers = asRecord(root.providers) ?? (looksLikeProviderMap(root) ? root : {});
  const drafts: ModelConfigImportDraft[] = [];
  for (const [id, raw] of Object.entries(providers)) {
    if (id === "providers") continue;
    const record = asRecord(raw);
    if (!record) continue;
    const baseUrl = firstString(record.baseUrl, record.baseURL, record.url);
    const apiStyle = resolveApiStyle(firstString(record.api, record.apiStyle, record.type));
    const headers = asRecord(record.headers);
    const secret = firstSecret(
      resolveSecret(record.apiKey ?? record.api_key, env),
      secretFromAuthHeader(headers),
    );
    const modelEntries = Array.isArray(record.models) ? record.models : [];
    const modelIds = uniqueModelIds(modelEntries.map(modelIdFromUnknown));
    if (modelIds.length === 0) continue;
    const reasoning = modelEntries.some((entry) => asRecord(entry)?.reasoning === true);
    const draft = finishDraft({
      source: "pi",
      externalId: id,
      name: firstString(record.name, record.label) || id,
      baseUrl,
      apiStyle: apiStyle ?? "chat_completions",
      vendorHint: id,
      modelIds,
      secretValue: secret,
      supportsReasoning: reasoning || undefined,
      models: modelEntries
        .map((entry) => bindingFromPiModel(entry))
        .filter((binding): binding is ModelBinding => binding !== null),
    });
    if (draft) drafts.push(draft);
  }
  return drafts;
}

const CC_SWITCH_APP_TYPES = [
  "claude",
  "claude-desktop",
  "codex",
  "gemini",
  "grokbuild",
  "opencode",
  "openclaw",
  "hermes",
  "pi",
] as const;

/**
 * Parse CC Switch's legacy `~/.cc-switch/config.json` (`MultiAppConfig`).
 * Each app key holds `{ providers: { [id]: { name, settingsConfig } } }`.
 */
export function parseCcSwitchConfigJson(document: unknown): CcSwitchProviderRow[] {
  const root = asRecord(document);
  if (!root) return [];
  const rows: CcSwitchProviderRow[] = [];
  for (const appType of CC_SWITCH_APP_TYPES) {
    const app = asRecord(root[appType]);
    const providers = asRecord(app?.providers);
    if (!providers) continue;
    for (const [id, raw] of Object.entries(providers)) {
      const record = asRecord(raw);
      if (!record) continue;
      rows.push({
        id: firstString(record.id) || id,
        appType,
        name: firstString(record.name) || id,
        settingsConfig: record.settingsConfig ?? record.settings_config ?? record,
      });
    }
  }
  return rows;
}

export function parseCcSwitchProviders(
  rows: CcSwitchProviderRow[],
  env: ModelConfigImportEnv = {},
): ModelConfigImportDraft[] {
  const drafts: ModelConfigImportDraft[] = [];
  for (const row of rows) {
    drafts.push(...parseCcSwitchProvider(row, env));
  }
  return drafts;
}

function parseCcSwitchProvider(
  row: CcSwitchProviderRow,
  env: ModelConfigImportEnv,
): ModelConfigImportDraft[] {
  const appType = row.appType.trim().toLowerCase();
  if (appType === "claude" || appType === "claude-desktop") {
    const parsed = parseClaudeCodeModelConfig(row.settingsConfig);
    if (parsed.length > 0) return retagCcSwitch(row, parsed);
    const settings = asRecord(row.settingsConfig);
    const envMap = stringMap(settings?.env);
    const secret = firstSecret(envMap.ANTHROPIC_API_KEY, envMap.ANTHROPIC_AUTH_TOKEN);
    const baseUrl = firstString(envMap.ANTHROPIC_BASE_URL, envMap.ANTHROPIC_API_URL);
    if (!baseUrl && !secret) return [];
    const draft = finishDraft({
      source: "cc-switch",
      externalId: `${row.appType}:${row.id}`,
      name: row.name || row.id,
      baseUrl: firstString(envMap.ANTHROPIC_BASE_URL, envMap.ANTHROPIC_API_URL),
      apiStyle: "anthropic_messages",
      vendorHint: firstString(envMap.ANTHROPIC_BASE_URL) ? "custom" : "anthropic",
      modelIds: ["default"],
      secretValue: secret,
    });
    return draft ? [draft] : [];
  }
  if (appType === "opencode" || appType === "hermes") {
    return retagCcSwitch(
      row,
      parseOpenCodeModelConfig({ provider: { [row.id]: row.settingsConfig } }, undefined, env),
    );
  }
  if (appType === "pi") {
    return retagCcSwitch(
      row,
      parsePiModelConfig({ providers: { [row.id]: row.settingsConfig } }, env),
    );
  }
  if (appType === "codex" || appType === "grokbuild") {
    return parseCcSwitchTomlApp(row, env, appType === "codex" ? "responses" : "chat_completions");
  }
  if (appType === "gemini") {
    return parseCcSwitchGemini(row, env);
  }
  return [];
}

function parseCcSwitchTomlApp(
  row: CcSwitchProviderRow,
  env: ModelConfigImportEnv,
  fallbackStyle: CatalogApiStyle,
): ModelConfigImportDraft[] {
  const settings = asRecord(row.settingsConfig) ?? {};
  const toml = typeof settings.config === "string" ? settings.config : "";
  const auth = asRecord(settings.auth) ?? {};
  const authSecret = firstSecret(firstString(auth.OPENAI_API_KEY, auth.api_key));
  const parsed = parseCodexModelConfig(toml, env);
  const withAuth = parsed.map((draft) => ({
    ...draft,
    secretValue: draft.secretValue ?? authSecret,
    hasSecret: Boolean(draft.secretValue ?? authSecret),
  }));
  if (withAuth.length > 0) return retagCcSwitch(row, withAuth);
  const baseUrl = toml.match(/base_url\s*=\s*"([^"]+)"/)?.[1];
  const model = toml.match(/^\s*model\s*=\s*"([^"]+)"/m)?.[1];
  const secret = authSecret;
  if (!baseUrl && !secret) return [];
  const draft = finishDraft({
    source: "cc-switch",
    externalId: `${row.appType}:${row.id}`,
    name: row.name || row.id,
    baseUrl,
    apiStyle: fallbackStyle,
    vendorHint: baseUrl ? "custom" : row.appType,
    modelIds: model ? [model] : ["default"],
    secretValue: secret,
  });
  return draft ? [draft] : [];
}

function parseCcSwitchGemini(
  row: CcSwitchProviderRow,
  env: ModelConfigImportEnv,
): ModelConfigImportDraft[] {
  const settings = asRecord(row.settingsConfig) ?? {};
  const envMap = stringMap(settings.env);
  const config = asRecord(settings.config) ?? {};
  const baseUrl = firstString(
    envMap.GOOGLE_GEMINI_BASE_URL,
    envMap.GEMINI_BASE_URL,
    envMap.GOOGLE_API_BASE,
  );
  const secret = firstSecret(
    resolveSecret(envMap.GEMINI_API_KEY, env),
    resolveSecret(envMap.GOOGLE_API_KEY, env),
  );
  const modelIds = uniqueModelIds([
    firstString(config.model, settings.model, envMap.GEMINI_MODEL, envMap.GOOGLE_MODEL),
  ]);
  const named = matchNamedPreset({ baseUrl: baseUrl ?? undefined, vendorKey: "google" });
  if (!baseUrl && !secret) return [];
  const draft = finishDraft({
    source: "cc-switch",
    externalId: `${row.appType}:${row.id}`,
    name: row.name || row.id,
    baseUrl,
    apiStyle: named?.apiStyle ?? (baseUrl ? "chat_completions" : "google_generative_ai"),
    vendorHint: baseUrl && !named ? "custom" : "google",
    modelIds: modelIds.length > 0 ? modelIds : ["default"],
    secretValue: secret,
  });
  return draft ? [draft] : [];
}

function retagCcSwitch(
  row: CcSwitchProviderRow,
  drafts: ModelConfigImportDraft[],
): ModelConfigImportDraft[] {
  return drafts.map((draft) => ({
    ...draft,
    source: "cc-switch",
    externalId:
      drafts.length === 1
        ? `${row.appType}:${row.id}`
        : `${row.appType}:${row.id}:${draft.externalId}`,
    name: clipName(row.name || draft.name),
  }));
}

type DraftSeed = {
  source: ModelConfigImportSource;
  externalId: string;
  name: string;
  baseUrl?: string | null;
  apiStyle: CatalogApiStyle;
  vendorHint?: string;
  modelIds: string[];
  secretValue?: string;
  supportsReasoning?: boolean;
  models?: ModelBinding[];
};

function finishDraft(seed: DraftSeed): ModelConfigImportDraft | null {
  const modelIds = uniqueModelIds(seed.modelIds).slice(0, MAX_MODELS_PER_PROVIDER);
  if (modelIds.length === 0) return null;
  const trimmedUrl = seed.baseUrl?.trim() || null;
  const preset = matchNamedPreset({
    vendorKey: seed.vendorHint,
    baseUrl: trimmedUrl ?? undefined,
    apiStyle: seed.apiStyle,
  });
  const vendorKey =
    trimmedUrl && !preset
      ? "custom"
      : (preset?.vendorKey ??
        (seed.vendorHint && seed.vendorHint !== "custom" ? seed.vendorHint : "custom"));
  const models =
    seed.models && seed.models.length > 0
      ? dedupeBindings(seed.models).slice(0, MAX_MODELS_PER_PROVIDER)
      : modelIds.map((id) => bindingForCustomModel(id));
  if (models.length === 0) return null;
  const secret = sanitizeSecret(seed.secretValue);
  return {
    source: seed.source,
    externalId: seed.externalId.trim() || "default",
    name: clipName(seed.name || preset?.name || seed.externalId),
    baseUrl: trimmedUrl,
    apiStyle: seed.apiStyle,
    modelIds: models.map((model) => model.id),
    hasSecret: Boolean(secret),
    vendorKey,
    models,
    secretValue: secret,
    supportsReasoning: seed.supportsReasoning,
  };
}

function clipName(name: string): string {
  const trimmed = name.replace(/\s+/g, " ").trim();
  if (!trimmed) return "Imported provider";
  return trimmed.length > MAX_NAME_LENGTH
    ? `${trimmed.slice(0, MAX_NAME_LENGTH - 1)}...`
    : trimmed;
}

export function resolveApiStyle(raw?: string | null): CatalogApiStyle | undefined {
  if (!raw) return undefined;
  const key = raw.trim().toLowerCase().replace(/\s+/g, "-");
  return API_STYLE_ALIASES[key] ?? API_STYLE_ALIASES[key.replace(/_/g, "-")];
}

function resolveSecret(raw: unknown, env: ModelConfigImportEnv): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("env:")) {
    const name = trimmed.slice(4).trim();
    return name ? sanitizeSecret(env[name]) : undefined;
  }
  const braced = trimmed.match(/^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/);
  if (braced) return sanitizeSecret(env[braced[1]]);
  return sanitizeSecret(trimmed);
}

function isPlaceholderSecret(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;
  if (/^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(trimmed)) return true;
  if (/your[_-]?api[_-]?key/i.test(trimmed)) return true;
  if (/^changeme$/i.test(trimmed)) return true;
  if (/^x+$/i.test(trimmed)) return true;
  return false;
}

function sanitizeSecret(value?: string | null): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed || isPlaceholderSecret(trimmed)) return undefined;
  return trimmed;
}

function firstSecret(...values: Array<string | undefined | null>): string | undefined {
  for (const value of values) {
    const secret = sanitizeSecret(value);
    if (secret) return secret;
  }
  return undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function uniqueModelIds(values: Array<string | undefined | null>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const id = value?.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringMap(value: unknown): Record<string, string> {
  const record = asRecord(value);
  if (!record) return {};
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(record)) {
    if (typeof raw === "string" && raw.trim()) out[key] = raw;
  }
  return out;
}

function modelIdsFromUnknown(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(modelIdFromUnknown).filter((id): id is string => !!id);
  const record = asRecord(value);
  if (!record) return [];
  return Object.keys(record).filter((key) => key.trim());
}

function modelIdFromUnknown(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  const record = asRecord(value);
  return firstString(record?.id, record?.model, record?.modelID, record?.modelId);
}

function modelBindingsFromUnknown(value: unknown, fallbackIds: string[]): ModelBinding[] {
  const record = asRecord(value);
  if (record) {
    const bindings: ModelBinding[] = [];
    for (const [id, raw] of Object.entries(record)) {
      const binding = bindingFromGenericModel(id, asRecord(raw));
      if (binding) bindings.push(binding);
    }
    if (bindings.length > 0) return bindings;
  }
  if (Array.isArray(value)) {
    const bindings = value
      .map((entry) => bindingFromGenericModel(modelIdFromUnknown(entry) ?? "", asRecord(entry)))
      .filter((binding): binding is ModelBinding => binding !== null);
    if (bindings.length > 0) return bindings;
  }
  return fallbackIds.map((id) => bindingForCustomModel(id));
}

function bindingFromGenericModel(
  id: string,
  record: Record<string, unknown> | null,
): ModelBinding | null {
  const modelId = firstString(id, record?.id);
  if (!modelId) return null;
  const base = bindingForCustomModel(modelId);
  const limit = asRecord(record?.limit);
  const contextWindow = positiveInt(
    record?.contextWindow ?? record?.context_window ?? limit?.context,
  );
  const maxTokens = positiveInt(
    record?.maxTokens ?? record?.max_tokens ?? record?.maxOutputTokens ?? limit?.output,
  );
  return {
    ...base,
    contextWindow: contextWindow ?? base.contextWindow,
    maxTokens: maxTokens ?? base.maxTokens,
  };
}

function bindingFromPiModel(value: unknown): ModelBinding | null {
  if (typeof value === "string") return bindingForCustomModel(value);
  const record = asRecord(value);
  const id = firstString(record?.id);
  if (!id) return null;
  const binding = bindingFromGenericModel(id, record);
  if (!binding) return null;
  const input = Array.isArray(record?.input) ? record.input : [];
  const supportsImages = input.includes("image") ? true : binding.supportsImages;
  if (record?.reasoning === true) {
    return {
      ...binding,
      thinkingLevels: ["off", "low", "medium", "high"] satisfies ThinkingLevel[],
      defaultThinkingLevel: "medium",
      supportsImages,
    };
  }
  return supportsImages === binding.supportsImages ? binding : { ...binding, supportsImages };
}

function dedupeBindings(models: ModelBinding[]): ModelBinding[] {
  const seen = new Set<string>();
  const out: ModelBinding[] = [];
  for (const model of models) {
    const id = model.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ ...model, id });
  }
  return out;
}

function positiveInt(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.round(n);
}

function defaultModelForProvider(providerId: string, model?: string): string | undefined {
  if (!model) return undefined;
  const slash = model.indexOf("/");
  if (slash <= 0) return model;
  const prefix = model.slice(0, slash);
  const id = model.slice(slash + 1);
  return prefix === providerId ? id : undefined;
}

function authApiKey(value: unknown): string | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const kind = firstString(record.type, record.kind)?.toLowerCase();
  if (kind && kind !== "api" && kind !== "apikey" && kind !== "api_key") return undefined;
  return firstString(record.key, record.apiKey, record.token);
}

function secretFromAuthHeader(headers: unknown): string | undefined {
  const record = asRecord(headers);
  const value = firstString(
    record?.Authorization,
    record?.authorization,
    record?.["x-api-key"],
    record?.["X-Api-Key"],
  );
  if (!value) return undefined;
  const bearer = value.match(/^Bearer\s+(.+)$/i);
  return sanitizeSecret(bearer ? bearer[1] : value);
}

function looksLikeProviderMap(root: Record<string, unknown>): boolean {
  return Object.values(root).some((value) => {
    const record = asRecord(value);
    return Boolean(record && (record.baseUrl || record.baseURL || record.models || record.api));
  });
}

function splitCsv(value?: string): string[] {
  if (!value) return [];
  return value.split(/[,\s]+/).map((part) => part.trim()).filter(Boolean);
}

function stringValue(value: TomlValue | undefined): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

type TomlValue = string | number | boolean;

type TomlExtract = {
  root: Record<string, TomlValue>;
  tables: Map<string, Record<string, TomlValue>>;
};

/**
 * Minimal TOML reader for Codex `config.toml`: root keys plus `[table]`
 * assignments. Arrays-of-tables and inline tables are ignored.
 */
function parseTomlSubset(text: string): TomlExtract {
  const root: Record<string, TomlValue> = {};
  const tables = new Map<string, Record<string, TomlValue>>();
  let current: Record<string, TomlValue> = root;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) continue;
    if (line.startsWith("[[")) continue;
    if (line.startsWith("[")) {
      const header = parseTomlTableHeader(line);
      if (!header) continue;
      const existing = tables.get(header) ?? {};
      tables.set(header, existing);
      current = existing;
      continue;
    }
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().replace(/^["']|["']$/g, "");
    const parsed = parseTomlValue(line.slice(eq + 1));
    if (!key || !parsed) continue;
    current[key] = parsed.value;
  }
  return { root, tables };
}

function parseTomlTableHeader(line: string): string | null {
  if (!line.startsWith("[") || !line.endsWith("]")) return null;
  const inner = line.slice(1, -1).trim();
  const parts: string[] = [];
  let rest = inner;
  while (rest.length > 0) {
    rest = rest.trimStart();
    if (rest.startsWith('"') || rest.startsWith("'")) {
      const quoted = parseQuoted(rest, rest[0] as '"' | "'");
      if (!quoted) return null;
      parts.push(quoted.value);
      rest = quoted.rest.trimStart();
      if (rest.startsWith(".")) rest = rest.slice(1);
      continue;
    }
    const match = rest.match(/^([A-Za-z0-9_-]+)/);
    if (!match) return null;
    parts.push(match[1]);
    rest = rest.slice(match[1].length).trimStart();
    if (rest.startsWith(".")) rest = rest.slice(1);
  }
  return parts.join(".");
}

function stripTomlComment(line: string): string {
  let inString = false;
  let quote = "";
  let escaped = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      continue;
    }
    if (ch === "#") return line.slice(0, i);
  }
  return line;
}

function parseQuoted(
  input: string,
  quote: "'" | '"',
): { value: string; rest: string } | null {
  if (!input.startsWith(quote)) return null;
  if (quote === "'") {
    const end = input.indexOf("'", 1);
    if (end < 0) return null;
    return { value: input.slice(1, end), rest: input.slice(end + 1) };
  }
  let out = "";
  for (let i = 1; i < input.length; i += 1) {
    const ch = input[i];
    if (ch === "\\") {
      const next = input[i + 1];
      if (next === undefined) return null;
      const map: Record<string, string> = { n: "\n", t: "\t", r: "\r", '"': '"', "\\": "\\" };
      out += map[next] ?? next;
      i += 1;
      continue;
    }
    if (ch === '"') return { value: out, rest: input.slice(i + 1) };
    out += ch;
  }
  return null;
}

function parseTomlValue(raw: string): { value: TomlValue; rest: string } | null {
  const trimmed = raw.trimStart();
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
    return parseQuoted(trimmed, trimmed[0] as '"' | "'");
  }
  if (trimmed.startsWith("true") && isValueBoundary(trimmed[4])) {
    return { value: true, rest: trimmed.slice(4) };
  }
  if (trimmed.startsWith("false") && isValueBoundary(trimmed[5])) {
    return { value: false, rest: trimmed.slice(5) };
  }
  const num = trimmed.match(/^-?\d+(?:\.\d+)?/);
  if (num && isValueBoundary(trimmed[num[0].length])) {
    return { value: Number(num[0]), rest: trimmed.slice(num[0].length) };
  }
  return null;
}

function isValueBoundary(ch: string | undefined): boolean {
  return !ch || /[\s#,}\]]/.test(ch);
}
