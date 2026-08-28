import type { ModelInfo, ThinkingLevel } from "@pi-desktop/shared";
import type { PiModelConfig } from "@pi-desktop/agent-runtime";

export const MODELS_DEV_API_URL = "https://models.dev/api.json";
export const MODELS_DEV_TIMEOUT_MS = 10_000;
const MAX_MODELS_PER_PROVIDER = 500;
const RETRY_AFTER_FAILURE_MS = 60_000;
const DEFAULT_THINKING_LEVELS: ThinkingLevel[] = ["low", "medium", "high"];
const THINKING_LEVELS: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export type ModelsDevModel = {
  providerKey: string;
  providerName: string;
  providerApi?: string;
  modelId: string;
  displayName: string;
  displayNamePublished: boolean;
  reasoning: boolean;
  reasoningPublished: boolean;
  thinkingLevels: ThinkingLevel[];
  input: Array<"text" | "image">;
  inputPublished: boolean;
  capabilities: Array<"text" | "tools" | "vision" | "reasoning" | "json">;
  contextWindow?: number;
  maxTokens?: number;
  cost?: {
    input: number;
    output: number;
    cacheRead: number;
  };
};

type ModelsDevProvider = {
  providerKey: string;
  name: string;
  api?: string;
  models: ModelsDevModel[];
};

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= 0xffff_ffff
    ? value
    : undefined;
}

function normalizeThinkingValue(value: unknown): ThinkingLevel | undefined {
  if (value === "none") return "off";
  return typeof value === "string" &&
    (THINKING_LEVELS as readonly string[]).includes(value)
    ? (value as ThinkingLevel)
    : undefined;
}

/**
 * Convert models.dev's reasoning options into the canonical levels used by
 * PI-Desktop. `toggle` and `budget_tokens` only expose an on/off capability;
 * `medium` is the stable UI representative for the enabled state.
 */
export function thinkingLevelsFromModelsDev(
  reasoning: boolean,
  options: unknown,
): ThinkingLevel[] {
  if (!reasoning) return [];
  const levels = new Set<ThinkingLevel>();
  if (Array.isArray(options)) {
    for (const option of options) {
      const record = asRecord(option);
      const type = nonEmptyString(record?.type);
      if (type === "toggle" || type === "budget_tokens") {
        levels.add("off");
        levels.add("medium");
      }
      if (Array.isArray(record?.values)) {
        for (const value of record.values) {
          const level = normalizeThinkingValue(value);
          if (level) levels.add(level);
        }
      }
    }
  }
  return levels.size > 0 ? THINKING_LEVELS.filter((level) => levels.has(level)) : [...DEFAULT_THINKING_LEVELS];
}

function inputModes(value: unknown): Array<"text" | "image"> {
  if (!Array.isArray(value)) return ["text"];
  const modes = value.filter((item): item is "text" | "image" =>
    item === "text" || item === "image",
  );
  return modes.length > 0 ? [...new Set(modes)] : ["text"];
}

function modelCapabilities(
  reasoning: boolean,
  input: Array<"text" | "image">,
  raw: JsonRecord,
): Array<"text" | "tools" | "vision" | "reasoning" | "json"> {
  const capabilities: Array<"text" | "tools" | "vision" | "reasoning" | "json"> = ["text"];
  if (raw.tool_call === true) capabilities.push("tools");
  if (input.includes("image")) capabilities.push("vision");
  if (reasoning) capabilities.push("reasoning");
  if (raw.structured_output === true) capabilities.push("json");
  return capabilities;
}

function modelFromRaw(
  providerKey: string,
  provider: JsonRecord,
  modelKey: string,
  raw: JsonRecord,
): ModelsDevModel | undefined {
  const modelId = nonEmptyString(raw.id) ?? modelKey.trim();
  if (!modelId) return undefined;
  const modalities = asRecord(raw.modalities);
  const rawInput = modalities?.input;
  const rawOutput = modalities?.output;
  // PI-Desktop's agent transport is text-based. Do not offer audio/video-only
  // entries from the broad models.dev catalog as selectable chat models.
  if (
    (Array.isArray(rawInput) && rawInput.length > 0 && !rawInput.includes("text")) ||
    (Array.isArray(rawOutput) && rawOutput.length > 0 && !rawOutput.includes("text"))
  ) {
    return undefined;
  }
  const input = inputModes(rawInput);
  const displayName = nonEmptyString(raw.name) ?? modelId;
  const displayNamePublished = nonEmptyString(raw.name) !== undefined;
  const reasoningPublished = typeof raw.reasoning === "boolean";
  const reasoning = raw.reasoning === true;
  const inputPublished = Array.isArray(rawInput) && rawInput.length > 0;
  const limit = asRecord(raw.limit);
  const cost = asRecord(raw.cost);
  const contextWindow = positiveInteger(limit?.context);
  const maxTokens = positiveInteger(limit?.output);
  const costInput = positiveNumber(cost?.input);
  const costOutput = positiveNumber(cost?.output);
  const costCacheRead = positiveNumber(cost?.cache_read);
  return {
    providerKey,
    providerName: nonEmptyString(provider.name) ?? providerKey,
    providerApi: nonEmptyString(provider.api),
    modelId,
    displayName,
    displayNamePublished,
    reasoning,
    reasoningPublished,
    thinkingLevels: thinkingLevelsFromModelsDev(reasoning, raw.reasoning_options),
    input,
    inputPublished,
    capabilities: modelCapabilities(reasoning, input, raw),
    ...(contextWindow ? { contextWindow } : {}),
    ...(maxTokens ? { maxTokens } : {}),
    ...(costInput || costOutput || costCacheRead
      ? {
          cost: {
            input: costInput ?? 0,
            output: costOutput ?? 0,
            cacheRead: costCacheRead ?? 0,
          },
        }
      : {}),
  };
}

/** Parse the public models.dev provider/model document without network access. */
export function parseModelsDevCatalog(body: unknown): ModelsDevProvider[] {
  const root = asRecord(body);
  if (!root) throw new Error("models.dev catalog must be an object");
  const providers: ModelsDevProvider[] = [];
  for (const [providerKey, value] of Object.entries(root)) {
    const provider = asRecord(value);
    const rawModels = asRecord(provider?.models);
    if (!provider || !rawModels) continue;
    const parsedModels = Object.entries(rawModels).flatMap(([modelKey, modelValue]) => {
      const model = asRecord(modelValue);
      const parsed = model ? modelFromRaw(providerKey, provider, modelKey, model) : undefined;
      return parsed ? [parsed] : [];
    });
    const models = [...new Map(parsedModels.map((model) => [model.modelId.toLowerCase(), model])).values()]
      .sort((a, b) => a.modelId.localeCompare(b.modelId))
      .slice(0, MAX_MODELS_PER_PROVIDER);
    if (models.length > 0) {
      providers.push({
        providerKey,
        name: nonEmptyString(provider.name) ?? providerKey,
        api: nonEmptyString(provider.api),
        models,
      });
    }
  }
  return providers;
}

function normalizedProviderKey(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/_/g, "-");
}

const KNOWN_PROVIDER_BASE_URLS: Record<string, string[]> = {
  openai: ["https://api.openai.com/v1"],
  anthropic: ["https://api.anthropic.com"],
  google: ["https://generativelanguage.googleapis.com/v1beta"],
  mistral: ["https://api.mistral.ai/v1"],
  xai: ["https://api.x.ai/v1"],
  groq: ["https://api.groq.com/openai/v1"],
  togetherai: ["https://api.together.xyz/v1"],
};

const PROVIDER_ALIASES: Record<string, string[]> = {
  together: ["together", "togetherai"],
  "together-ai": ["together", "togetherai"],
  fireworks: ["fireworks", "fireworks-ai"],
  "fireworks-ai": ["fireworks", "fireworks-ai"],
  kimi: ["kimi-for-coding", "kimi-coding"],
  "kimi-coding": ["kimi-coding", "kimi-for-coding"],
  "google-vertex": ["google-vertex"],
  "azure-openai-responses": ["azure", "azure-cognitive-services"],
  "vercel-ai-gateway": ["vercel"],
  "zai-coding-cn": ["zai", "zai-coding-plan"],
  lmstudio: ["lmstudio", "lm-studio"],
  "lm-studio": ["lmstudio", "lm-studio"],
};

function providerKeyCandidates(value: string | undefined): string[] {
  const key = normalizedProviderKey(value);
  return [...new Set([key, ...(PROVIDER_ALIASES[key] ?? [])])].filter(Boolean);
}

function normalizedApiUrl(value: string | undefined): string | undefined {
  const raw = nonEmptyString(value);
  if (!raw) return undefined;
  try {
    const parsed = new URL(raw);
    const pathname = parsed.pathname
      .replace(/\/+$/, "")
      .replace(/\/(?:v1|v1beta|v1alpha)$/i, "");
    return `${parsed.protocol.toLowerCase()}//${parsed.host.toLowerCase()}${pathname}`;
  } catch {
    return undefined;
  }
}

function apiMatches(left: string | undefined, right: string | undefined): boolean {
  const normalizedLeft = normalizedApiUrl(left);
  const normalizedRight = normalizedApiUrl(right);
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight);
}

export function modelInfoFromModelsDev(
  model: ModelsDevModel,
  providerId: string,
): ModelInfo {
  return {
    modelId: model.modelId,
    displayName: model.displayName,
    providerId,
    ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
    ...(model.maxTokens ? { maxTokens: model.maxTokens } : {}),
    reasoning: model.reasoning,
    supportedThinkingLevels: [...model.thinkingLevels],
    capabilities: [...model.capabilities],
    // `discovered` describes the delivery mechanism; catalogSource lets the
    // settings UI distinguish this authoritative remote catalog from endpoint
    // discovery and the pi-ai fallback without adding a storage enum.
    source: "discovered",
    catalogSource: "models.dev",
  };
}

export function piModelConfigFromModelsDev(
  model: ModelsDevModel,
  fallback: PiModelConfig | undefined,
  baseUrl: string | undefined,
): PiModelConfig {
  const fallbackCost = fallback?.cost ?? {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  };
  const reasoning = model.reasoningPublished ? model.reasoning : fallback?.reasoning ?? false;
  return {
    ...(fallback ?? {
      name: model.modelId,
      baseUrl: baseUrl ?? model.providerApi ?? "",
      reasoning: false,
      input: ["text" as const],
      cost: fallbackCost,
      contextWindow: model.contextWindow ?? 128_000,
      maxTokens: model.maxTokens ?? 8_192,
    }),
    source: "models.dev",
    name: model.displayNamePublished ? model.displayName : fallback?.name ?? model.modelId,
    baseUrl: baseUrl || model.providerApi || fallback?.baseUrl || "",
    reasoning,
    input: model.inputPublished ? [...model.input] : fallback?.input ?? ["text"],
    cost: model.cost
      ? {
          ...fallbackCost,
          input: model.cost.input,
          output: model.cost.output,
          cacheRead: model.cost.cacheRead,
        }
      : fallbackCost,
    contextWindow: model.contextWindow ?? fallback?.contextWindow ?? 128_000,
    maxTokens: model.maxTokens ?? fallback?.maxTokens ?? 8_192,
    ...(reasoning
      ? {
          ...(fallback?.thinkingLevelMap
            ? { thinkingLevelMap: { ...fallback.thinkingLevelMap } }
            : {}),
        }
      : { thinkingLevelMap: undefined }),
  };
}

export class ModelsDevCatalog {
  private providers = new Map<string, ModelsDevProvider>();
  private loadPromise: Promise<boolean> | undefined;
  private lastAttemptAt = 0;
  private loaded = false;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(
    fetchImpl: typeof fetch = fetch,
    timeoutMs = MODELS_DEV_TIMEOUT_MS,
    now: () => number = () => Date.now(),
  ) {
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.now = now;
  }

  async ensureLoaded(): Promise<boolean> {
    if (this.loaded) return true;
    if (
      this.lastAttemptAt > 0 &&
      this.now() - this.lastAttemptAt < RETRY_AFTER_FAILURE_MS
    ) {
      return false;
    }
    return this.refresh();
  }

  async refresh(): Promise<boolean> {
    if (this.loadPromise) return this.loadPromise;
    this.lastAttemptAt = this.now();
    this.loadPromise = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImpl(MODELS_DEV_API_URL, {
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`models.dev catalog request failed (${response.status})`);
        const parsed = parseModelsDevCatalog(await response.json());
        this.providers = new Map(parsed.map((provider) => [provider.providerKey, provider]));
        this.loaded = this.providers.size > 0;
        return this.loaded;
      } catch {
        // Keep the previous successful snapshot, if any. Callers deliberately
        // fall through to pi-ai or provider-specific discovery on failure.
        return this.loaded;
      } finally {
        clearTimeout(timer);
        this.loadPromise = undefined;
      }
    })();
    return this.loadPromise;
  }

  private providerFor(input: {
    vendorKey?: string;
    baseUrl?: string;
  }): ModelsDevProvider | undefined {
    const candidates = new Set(providerKeyCandidates(input.vendorKey));
    for (const provider of this.providers.values()) {
      if (candidates.has(normalizedProviderKey(provider.providerKey))) return provider;
    }
    const byApi = [...this.providers.values()].find((provider) =>
      apiMatches(input.baseUrl, provider.api),
    );
    if (byApi) return byApi;

    const knownKey = Object.entries(KNOWN_PROVIDER_BASE_URLS).find(([, urls]) =>
      urls.some((url) => apiMatches(input.baseUrl, url)),
    )?.[0];
    if (!knownKey) return undefined;
    const knownCandidates = new Set(providerKeyCandidates(knownKey));
    return [...this.providers.values()].find((provider) =>
      knownCandidates.has(normalizedProviderKey(provider.providerKey)),
    );
  }

  findModel(input: {
    vendorKey?: string;
    baseUrl?: string;
    modelId: string;
  }): ModelsDevModel | undefined {
    const provider = this.providerFor(input);
    const modelId = input.modelId.trim().toLowerCase();
    return provider?.models.find((model) => model.modelId.toLowerCase() === modelId);
  }

  modelsForProvider(input: {
    vendorKey?: string;
    baseUrl?: string;
    providerId: string;
  }): ModelInfo[] {
    const provider = this.providerFor(input);
    return provider
      ? provider.models.map((model) => modelInfoFromModelsDev(model, input.providerId))
      : [];
  }
}