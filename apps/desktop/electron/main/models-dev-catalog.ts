import { readFile } from "node:fs/promises";
import type {
  ModelCost,
  ModelCostTier,
  ModelInfo,
  ModelInterleaved,
  ModelLimit,
  ModelModalities,
  ModelModality,
  ModelReasoningOption,
  ThinkingLevel,
} from "@pi-desktop/shared";
import type { ModelConfig } from "@pi-desktop/agent-runtime";

export const MODELS_DEV_API_URL = "https://models.dev/api.json";
export const MODELS_DEV_TIMEOUT_MS = 10_000;
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 8_192;
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
const MODEL_MODALITIES: readonly ModelModality[] = [
  "text",
  "image",
  "audio",
  "video",
  "pdf",
];

type JsonRecord = Record<string, unknown>;

export type ModelsDevProvider = {
  providerKey: string;
  name: string;
  api?: string;
  models: ModelsDevModel[];
};

export type ModelsDevModel = {
  providerKey: string;
  providerName: string;
  providerApi?: string;
  modelId: string;
  displayName: string;
  description?: string;
  family?: string;
  attachment?: boolean;
  reasoning: boolean;
  reasoningPublished: boolean;
  reasoningOptions?: ModelReasoningOption[];
  thinkingLevels: ThinkingLevel[];
  modalities: ModelModalities;
  modalitiesPublished: boolean;
  inputPublished: boolean;
  outputPublished: boolean;
  toolCall?: boolean;
  structuredOutput?: boolean;
  temperature?: boolean;
  knowledge?: string;
  releaseDate?: string;
  lastUpdated?: string;
  openWeights?: boolean;
  limit: ModelLimit;
  cost?: ModelCost;
  interleaved?: ModelInterleaved;
  status?: string;
  experimental?: boolean;
  provider?: string;
};

export type ModelsDevCatalogStatus = {
  loaded: boolean;
  source: "bundled" | "remote" | "empty";
  catalogPath: string;
  fetchedAt?: string;
  providerCount: number;
  modelCount: number;
  lastError?: string;
};

export type ModelsDevCatalogOptions = {
  /** Checked-in/release-packaged api.json; never a user-data path. */
  catalogPath: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
};

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 0xffff_ffff
    ? value
    : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  const number = nonNegativeInteger(value);
  return number !== undefined && number > 0 ? number : undefined;
}

function parseModality(value: unknown): ModelModality | undefined {
  return typeof value === "string" && MODEL_MODALITIES.includes(value as ModelModality)
    ? (value as ModelModality)
    : undefined;
}

function parseModalities(value: unknown): {
  modalities: ModelModalities;
  published: boolean;
  inputPublished: boolean;
  outputPublished: boolean;
} {
  const record = asRecord(value);
  const rawInput = Array.isArray(record?.input) ? record.input : undefined;
  const rawOutput = Array.isArray(record?.output) ? record.output : undefined;
  const input = rawInput?.map(parseModality).filter(
    (item): item is ModelModality => item !== undefined,
  ) ?? [];
  const output = rawOutput?.map(parseModality).filter(
    (item): item is ModelModality => item !== undefined,
  ) ?? [];
  return {
    modalities: {
      input: input.length > 0 ? [...new Set(input)] : ["text"],
      output: output.length > 0 ? [...new Set(output)] : ["text"],
    },
    published: rawInput !== undefined || rawOutput !== undefined,
    inputPublished: rawInput !== undefined && input.length > 0,
    outputPublished: rawOutput !== undefined && output.length > 0,
  };
}

function normalizeThinkingValue(value: unknown): ThinkingLevel | undefined {
  if (value === "none") return "off";
  return typeof value === "string" &&
    (THINKING_LEVELS as readonly string[]).includes(value)
    ? (value as ThinkingLevel)
    : undefined;
}

function parseReasoningOptions(value: unknown): ModelReasoningOption[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const options = value.flatMap((entry) => {
    const record = asRecord(entry);
    const type = nonEmptyString(record?.type);
    if (!type) return [];
    const values = Array.isArray(record?.values)
      ? record.values.filter(
          (item): item is string | null => typeof item === "string" || item === null,
        )
      : undefined;
    const min = nonNegativeNumber(record?.min);
    const max = nonNegativeNumber(record?.max);
    return [{
      type,
      ...(values ? { values } : {}),
      ...(min !== undefined ? { min } : {}),
      ...(max !== undefined ? { max } : {}),
    }];
  });
  return options;
}

/** Convert models.dev reasoning options into the canonical UI levels. */
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
  return levels.size > 0
    ? THINKING_LEVELS.filter((level) => levels.has(level))
    : [...DEFAULT_THINKING_LEVELS];
}

function thinkingLevelMapFromModelsDev(
  options: ModelReasoningOption[] | undefined,
  levels: ThinkingLevel[],
): Partial<Record<ThinkingLevel, string | null>> | undefined {
  if (!options?.length) return undefined;
  const map: Partial<Record<ThinkingLevel, string | null>> = {};
  for (const option of options) {
    if (option.type === "toggle" || option.type === "budget_tokens") {
      if (levels.includes("off")) map.off = "none";
      if (levels.includes("medium")) map.medium = "medium";
    }
    for (const value of option.values ?? []) {
      const level = normalizeThinkingValue(value);
      if (level && typeof value === "string") map[level] = value;
    }
  }
  return Object.keys(map).length > 0 ? map : undefined;
}

function parseLimit(value: unknown): ModelLimit {
  const record = asRecord(value);
  const context = nonNegativeInteger(record?.context);
  const input = nonNegativeInteger(record?.input);
  const output = nonNegativeInteger(record?.output);
  return {
    ...(context !== undefined ? { context } : {}),
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
  };
}

function parseCostTier(value: unknown): ModelCostTier | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const input = nonNegativeNumber(record.input);
  const output = nonNegativeNumber(record.output);
  const cacheRead = nonNegativeNumber(record.cache_read);
  const cacheWrite = nonNegativeNumber(record.cache_write);
  const tierRecord = asRecord(record.tier);
  const tierType = nonEmptyString(tierRecord?.type);
  const tierSize = positiveInteger(tierRecord?.size);
  if (
    input === undefined &&
    output === undefined &&
    cacheRead === undefined &&
    cacheWrite === undefined &&
    !tierType &&
    tierSize === undefined
  ) return undefined;
  return {
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(cacheRead !== undefined ? { cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWrite } : {}),
    ...(tierType || tierSize !== undefined
      ? {
          tier: {
            ...(tierType ? { type: tierType } : {}),
            ...(tierSize !== undefined ? { size: tierSize } : {}),
          },
        }
      : {}),
  };
}

function parseCost(value: unknown): ModelCost | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const input = nonNegativeNumber(record.input);
  const output = nonNegativeNumber(record.output);
  const cacheRead = nonNegativeNumber(record.cache_read);
  const cacheWrite = nonNegativeNumber(record.cache_write);
  const reasoning = nonNegativeNumber(record.reasoning);
  const inputAudio = nonNegativeNumber(record.input_audio);
  const outputAudio = nonNegativeNumber(record.output_audio);
  const contextOver = asRecord(record.context_over_200k);
  const contextOver200k = contextOver
    ? {
        ...(nonNegativeNumber(contextOver.input) !== undefined
          ? { input: nonNegativeNumber(contextOver.input) }
          : {}),
        ...(nonNegativeNumber(contextOver.output) !== undefined
          ? { output: nonNegativeNumber(contextOver.output) }
          : {}),
        ...(nonNegativeNumber(contextOver.cache_read) !== undefined
          ? { cacheRead: nonNegativeNumber(contextOver.cache_read) }
          : {}),
        ...(nonNegativeNumber(contextOver.cache_write) !== undefined
          ? { cacheWrite: nonNegativeNumber(contextOver.cache_write) }
          : {}),
      }
    : undefined;
  const tiers = Array.isArray(record.tiers)
    ? record.tiers
        .map(parseCostTier)
        .filter((item): item is ModelCostTier => item !== undefined)
    : undefined;
  if (
    input === undefined &&
    output === undefined &&
    cacheRead === undefined &&
    cacheWrite === undefined &&
    reasoning === undefined &&
    inputAudio === undefined &&
    outputAudio === undefined &&
    !contextOver200k &&
    !tiers?.length
  ) return undefined;
  return {
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(cacheRead !== undefined ? { cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWrite } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(inputAudio !== undefined ? { inputAudio } : {}),
    ...(outputAudio !== undefined ? { outputAudio } : {}),
    ...(contextOver200k ? { contextOver200k } : {}),
    ...(tiers?.length ? { tiers } : {}),
  };
}

function parseInterleaved(value: unknown): ModelInterleaved | undefined {
  if (typeof value === "boolean") return value;
  const record = asRecord(value);
  const field = nonEmptyString(record?.field);
  return field ? { field } : undefined;
}

function modelFromRaw(
  providerKey: string,
  provider: JsonRecord,
  modelKey: string,
  raw: JsonRecord,
): ModelsDevModel | undefined {
  const modelId = nonEmptyString(raw.id) ?? modelKey.trim();
  if (!modelId) return undefined;
  const modalityResult = parseModalities(raw.modalities);
  const reasoningPublished = typeof raw.reasoning === "boolean";
  const reasoning = raw.reasoning === true;
  const reasoningOptions = parseReasoningOptions(raw.reasoning_options);
  const limit = parseLimit(raw.limit);
  const displayName = nonEmptyString(raw.name) ?? modelId;
  const inputPublished = modalityResult.inputPublished;
  const outputPublished = modalityResult.outputPublished;
  return {
    providerKey,
    providerName: nonEmptyString(provider.name) ?? providerKey,
    ...(nonEmptyString(provider.api) ? { providerApi: nonEmptyString(provider.api) } : {}),
    modelId,
    displayName,
    ...(nonEmptyString(raw.description) ? { description: nonEmptyString(raw.description) } : {}),
    ...(nonEmptyString(raw.family) ? { family: nonEmptyString(raw.family) } : {}),
    ...(typeof raw.attachment === "boolean" ? { attachment: raw.attachment } : {}),
    reasoning,
    reasoningPublished,
    ...(reasoningOptions ? { reasoningOptions } : {}),
    thinkingLevels: thinkingLevelsFromModelsDev(reasoning, raw.reasoning_options),
    modalities: modalityResult.modalities,
    modalitiesPublished: modalityResult.published,
    inputPublished,
    outputPublished,
    ...(typeof raw.tool_call === "boolean" ? { toolCall: raw.tool_call } : {}),
    ...(typeof raw.structured_output === "boolean" ? { structuredOutput: raw.structured_output } : {}),
    ...(typeof raw.temperature === "boolean" ? { temperature: raw.temperature } : {}),
    ...(nonEmptyString(raw.knowledge) ? { knowledge: nonEmptyString(raw.knowledge) } : {}),
    ...(nonEmptyString(raw.release_date) ? { releaseDate: nonEmptyString(raw.release_date) } : {}),
    ...(nonEmptyString(raw.last_updated) ? { lastUpdated: nonEmptyString(raw.last_updated) } : {}),
    ...(typeof raw.open_weights === "boolean" ? { openWeights: raw.open_weights } : {}),
    limit,
    ...(parseCost(raw.cost) ? { cost: parseCost(raw.cost) } : {}),
    ...(parseInterleaved(raw.interleaved) !== undefined
      ? { interleaved: parseInterleaved(raw.interleaved) }
      : {}),
    ...(nonEmptyString(raw.status) ? { status: nonEmptyString(raw.status) } : {}),
    ...(typeof raw.experimental === "boolean" ? { experimental: raw.experimental } : {}),
    ...(nonEmptyString(raw.provider) ? { provider: nonEmptyString(raw.provider) } : {}),
  };
}

/** Parse the public models.dev document without network access. */
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
    const models = [
      ...new Map(parsedModels.map((model) => [model.modelId.toLowerCase(), model])).values(),
    ]
      .sort((a, b) => a.modelId.localeCompare(b.modelId));
    if (models.length > 0) {
      providers.push({
        providerKey,
        name: nonEmptyString(provider.name) ?? providerKey,
        ...(nonEmptyString(provider.api) ? { api: nonEmptyString(provider.api) } : {}),
        models,
      });
    }
  }
  return providers;
}

function normalizedProviderKey(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/_/g, "-");
}

function normalizedModelId(value: string): string {
  return value.trim().toLowerCase();
}

function modelIdMatches(candidate: string, requested: string): boolean {
  const left = normalizedModelId(candidate);
  const right = normalizedModelId(requested);
  return left === right || left.endsWith(`/${right}`) || right.endsWith(`/${left}`);
}

function modelVendorPrefixes(model: ModelsDevModel): string[] {
  const prefixes = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value !== "string") return;
    const normalized = normalizedProviderKey(value);
    if (normalized) prefixes.add(normalized);
  };
  add(model.providerKey);
  add(model.provider);
  const slash = model.modelId.indexOf("/");
  if (slash > 0) add(model.modelId.slice(0, slash));
  return [...prefixes];
}

function modelMatchesProvider(model: ModelsDevModel, vendorKey?: string): boolean {
  const candidates = new Set(providerKeyCandidates(vendorKey));
  if (candidates.size === 0 || candidates.has("custom")) return false;
  return modelVendorPrefixes(model).some((prefix) => candidates.has(prefix));
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
  "lm-studio": ["lmstudio", "lm-studio"],
  lmstudio: ["lmstudio", "lm-studio"],
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

function isTextAgentModel(model: ModelsDevModel): boolean {
  return model.modalities.input.includes("text") && model.modalities.output.includes("text");
}

function adapterInput(modalities: ModelModalities): Array<"text" | "image"> {
  const input = modalities.input.filter(
    (item): item is "text" | "image" => item === "text" || item === "image",
  );
  return input.includes("text") ? input : ["text"];
}

function capabilityList(model: ModelsDevModel): ModelInfo["capabilities"] {
  const capabilities = new Set<ModelInfo["capabilities"][number]>(["text"]);
  if (model.toolCall === true) capabilities.add("tools");
  if (model.reasoning) capabilities.add("reasoning");
  if (model.structuredOutput === true) capabilities.add("json");
  for (const modality of model.modalities.input) {
    if (modality === "image") capabilities.add("vision");
    if (modality === "audio") capabilities.add("audio");
    if (modality === "video") capabilities.add("video");
    if (modality === "pdf") capabilities.add("pdf");
  }
  for (const modality of model.modalities.output) {
    if (modality === "audio") capabilities.add("audio");
    if (modality === "video") capabilities.add("video");
    if (modality === "pdf") capabilities.add("pdf");
  }
  return [...capabilities];
}

export function modelInfoFromModelsDev(
  model: ModelsDevModel,
  providerId: string,
): ModelInfo {
  const contextWindow = positiveInteger(model.limit.context);
  const maxTokens = positiveInteger(model.limit.output);
  return {
    modelId: model.modelId,
    displayName: model.displayName,
    providerId,
    ...(model.description !== undefined ? { description: model.description } : {}),
    ...(model.family !== undefined ? { family: model.family } : {}),
    ...(model.attachment !== undefined ? { attachment: model.attachment } : {}),
    reasoning: model.reasoning,
    ...(model.reasoningOptions !== undefined ? { reasoningOptions: model.reasoningOptions } : {}),
    ...(model.toolCall !== undefined ? { toolCall: model.toolCall } : {}),
    ...(model.structuredOutput !== undefined ? { structuredOutput: model.structuredOutput } : {}),
    ...(model.temperature !== undefined ? { temperature: model.temperature } : {}),
    ...(model.knowledge !== undefined ? { knowledge: model.knowledge } : {}),
    ...(model.releaseDate !== undefined ? { releaseDate: model.releaseDate } : {}),
    ...(model.lastUpdated !== undefined ? { lastUpdated: model.lastUpdated } : {}),
    modalities: model.modalities,
    ...(model.openWeights !== undefined ? { openWeights: model.openWeights } : {}),
    ...(Object.keys(model.limit).length > 0 ? { limit: model.limit } : {}),
    ...(model.cost !== undefined ? { cost: model.cost } : {}),
    ...(model.interleaved !== undefined ? { interleaved: model.interleaved } : {}),
    ...(model.status !== undefined ? { status: model.status } : {}),
    ...(model.experimental !== undefined ? { experimental: model.experimental } : {}),
    ...(model.provider !== undefined ? { provider: model.provider } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    capabilities: capabilityList(model),
    supportedThinkingLevels: [...model.thinkingLevels],
    source: "discovered",
    catalogSource: "models.dev",
  };
}

/** Convert one complete models.dev record into the sidecar model config. */
export function modelConfigFromModelsDev(
  model: ModelsDevModel,
  baseUrl?: string,
): ModelConfig {
  const contextWindow = positiveInteger(model.limit.context) ?? DEFAULT_CONTEXT_WINDOW;
  const maxTokens = positiveInteger(model.limit.output) ?? DEFAULT_MAX_TOKENS;
  const reasoning = model.reasoningPublished ? model.reasoning : false;
  const thinkingLevels = reasoning ? [...model.thinkingLevels] : [];
  const cost: NonNullable<ModelConfig["cost"]> = {
    input: model.cost?.input ?? 0,
    output: model.cost?.output ?? 0,
    cacheRead: model.cost?.cacheRead ?? 0,
    cacheWrite: model.cost?.cacheWrite ?? 0,
    ...(model.cost?.reasoning !== undefined ? { reasoning: model.cost.reasoning } : {}),
    ...(model.cost?.inputAudio !== undefined ? { inputAudio: model.cost.inputAudio } : {}),
    ...(model.cost?.outputAudio !== undefined ? { outputAudio: model.cost.outputAudio } : {}),
    ...(model.cost?.contextOver200k ? { contextOver200k: model.cost.contextOver200k } : {}),
    ...(model.cost?.tiers ? { tiers: model.cost.tiers } : {}),
  };
  const config: ModelConfig = {
    source: "models.dev",
    name: model.displayName,
    baseUrl: baseUrl ?? model.providerApi ?? "",
    reasoning,
    supportedThinkingLevels: thinkingLevels,
    modalities: model.modalities,
    limit: {
      ...model.limit,
      context: model.limit.context ?? contextWindow,
      input: model.limit.input ?? contextWindow,
      output: model.limit.output ?? maxTokens,
    },
    cost,
    input: adapterInput(model.modalities),
    contextWindow,
    maxTokens,
  };
  if (model.description !== undefined) config.description = model.description;
  if (model.family !== undefined) config.family = model.family;
  if (model.attachment !== undefined) config.attachment = model.attachment;
  if (model.reasoningOptions !== undefined) config.reasoningOptions = model.reasoningOptions;
  const thinkingLevelMap = thinkingLevelMapFromModelsDev(model.reasoningOptions, thinkingLevels);
  if (thinkingLevelMap) config.thinkingLevelMap = thinkingLevelMap;
  if (model.toolCall !== undefined) config.toolCall = model.toolCall;
  if (model.structuredOutput !== undefined) config.structuredOutput = model.structuredOutput;
  if (model.temperature !== undefined) config.temperature = model.temperature;
  if (model.knowledge !== undefined) config.knowledge = model.knowledge;
  if (model.releaseDate !== undefined) config.releaseDate = model.releaseDate;
  if (model.lastUpdated !== undefined) config.lastUpdated = model.lastUpdated;
  if (model.openWeights !== undefined) config.openWeights = model.openWeights;
  if (model.interleaved !== undefined) config.interleaved = model.interleaved;
  if (model.status !== undefined) config.status = model.status;
  if (model.experimental !== undefined) config.experimental = model.experimental;
  if (model.provider !== undefined) config.provider = model.provider;
  return config;
}

export class ModelsDevCatalog {
  private providers = new Map<string, ModelsDevProvider>();
  private loadPromise: Promise<boolean> | undefined;
  private loaded = false;
  private source: ModelsDevCatalogStatus["source"] = "empty";
  private fetchedAt: string | undefined;
  private lastError: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly catalogPath: string;
  private localLoadAttempted = false;

  constructor(options: ModelsDevCatalogOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? MODELS_DEV_TIMEOUT_MS;
    this.now = options.now ?? (() => Date.now());
    this.catalogPath = options.catalogPath;
  }

  /** Load the bundled release snapshot; this never performs network I/O. */
  async loadLocal(): Promise<boolean> {
    if (this.localLoadAttempted) return this.loaded;
    this.localLoadAttempted = true;
    try {
      const raw = JSON.parse(await readFile(this.catalogPath, "utf8")) as unknown;
      const parsed = parseModelsDevCatalog(raw);
      if (parsed.length === 0) throw new Error("models.dev snapshot contained no providers");
      this.providers = new Map(parsed.map((provider) => [provider.providerKey, provider]));
      this.loaded = true;
      this.source = "bundled";
      this.lastError = undefined;
    } catch (error) {
      this.loaded = false;
      this.lastError = error instanceof Error ? error.message : String(error);
    }
    return this.loaded;
  }

  /** Ensure the release snapshot is available without contacting the network. */
  async ensureLoaded(): Promise<boolean> {
    return this.loadLocal();
  }

  /** Refresh the in-memory snapshot for the current process; never writes user data. */
  async refresh(): Promise<boolean> {
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImpl(MODELS_DEV_API_URL, {
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`models.dev catalog request failed (${response.status})`);
        }
        const parsed = parseModelsDevCatalog(await response.json());
        if (parsed.length === 0) throw new Error("models.dev catalog contained no usable providers");
        this.providers = new Map(parsed.map((provider) => [provider.providerKey, provider]));
        this.loaded = true;
        this.source = "remote";
        this.fetchedAt = new Date(this.now()).toISOString();
        this.lastError = undefined;
        return true;
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
        return false;
      } finally {
        clearTimeout(timer);
        this.loadPromise = undefined;
      }
    })();
    return this.loadPromise;
  }

  getStatus(): ModelsDevCatalogStatus {
    return {
      loaded: this.loaded,
      source: this.source,
      catalogPath: this.catalogPath,
      ...(this.fetchedAt ? { fetchedAt: this.fetchedAt } : {}),
      providerCount: this.providers.size,
      modelCount: [...this.providers.values()].reduce(
        (count, provider) => count + provider.models.length,
        0,
      ),
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  private providerFor(input: { vendorKey?: string; baseUrl?: string }): ModelsDevProvider | undefined {
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

  findModel(input: { vendorKey?: string; baseUrl?: string; modelId: string }): ModelsDevModel | undefined {
    const requested = normalizedModelId(input.modelId);
    if (!requested) return undefined;
    const preferredProvider = this.providerFor(input);
    const providers = preferredProvider
      ? [preferredProvider, ...[...this.providers.values()].filter((item) => item !== preferredProvider)]
      : [...this.providers.values()];
    const candidates: Array<{ model: ModelsDevModel; score: number }> = [];
    for (const provider of providers) {
      for (const model of provider.models) {
        if (!isTextAgentModel(model) || !modelIdMatches(model.modelId, requested)) continue;
        let score = model.modelId.toLowerCase() === requested ? 20 : 10;
        if (provider === preferredProvider) score += 100;
        if (apiMatches(input.baseUrl, provider.api)) score += 80;
        if (modelMatchesProvider(model, input.vendorKey)) score += 60;
        candidates.push({ model, score });
      }
    }
    candidates.sort((left, right) =>
      right.score - left.score || left.model.modelId.length - right.model.modelId.length,
    );
    return candidates[0]?.model;
  }

  modelsForProvider(input: { vendorKey?: string; baseUrl?: string; providerId: string }): ModelInfo[] {
    const preferredProvider = this.providerFor(input);
    const providers = preferredProvider
      ? [preferredProvider]
      : [...this.providers.values()].filter((provider) =>
          provider.models.some((model) => modelMatchesProvider(model, input.vendorKey)),
        );
    const seen = new Set<string>();
    return providers.flatMap((provider) =>
      provider.models
        .filter((model) => {
          const key = normalizedModelId(model.modelId);
          if (!isTextAgentModel(model) || seen.has(key)) return false;
          if (!preferredProvider && !modelMatchesProvider(model, input.vendorKey)) return false;
          seen.add(key);
          return true;
        })
        .map((model) => modelInfoFromModelsDev(model, input.providerId)),
    );
  }
}
