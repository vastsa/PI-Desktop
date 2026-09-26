import { readFile } from "node:fs/promises";
import {
  MODEL_VENDOR_PREFIXES,
  NAMED_ENDPOINT_PRESETS,
  catalogModelIdsMatch,
  stripReleaseSuffix,
  stripVariantSuffix,
} from "@pi-desktop/shared";
import type {
  ModelCost,
  ModelCostTier,
  ModelExperimentalMetadata,
  ModelInfo,
  ModelInterleaved,
  ModelLimit,
  ModelModalities,
  ModelModality,
  ModelProviderMetadata,
  ModelReasoningOption,
  ThinkingLevel,
} from "@pi-desktop/shared";
import { genericModelConfig, type ModelConfig } from "@pi-desktop/agent-runtime";

export const MODELS_DEV_API_URL = "https://models.dev/api.json";
export const MODELS_DEV_TIMEOUT_MS = 10_000;
const LOOKUP_MEMO_LIMIT = 1_024;
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
  /** Published adapter package, the most reliable wire-API signal. */
  npm?: string;
  /** Published environment variable names that carry this provider's key. */
  env: string[];
  /** Provider documentation URL, when published. */
  doc?: string;
  models: ModelsDevModel[];
};

export type ModelsDevModel = {
  providerKey: string;
  providerName: string;
  providerApi?: string;
  /**
   * Wire API published for this model (e.g. "openai-responses").
   * models.dev omits it; modelFromRaw fills known ids from RESPONSES_ONLY_MODEL_IDS.
   */
  modelApi?: string;
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
  experimental?: ModelExperimentalMetadata;
  provider?: ModelProviderMetadata;
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

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .map((entry) => nonEmptyString(entry))
        .filter((entry): entry is string => entry !== undefined),
    ),
  ];
}

function publishedMetadata(value: unknown): ModelProviderMetadata | undefined {
  if (typeof value === "string") return nonEmptyString(value);
  return asRecord(value) ?? undefined;
}

function publishedExperimental(value: unknown): ModelExperimentalMetadata | undefined {
  if (typeof value === "boolean") return value;
  return asRecord(value) ?? undefined;
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
  // models.dev effort ladders often omit an off/none value (e.g. grok-4.6).
  // Pin off=null so adapters omit reasoning when thinking is turned off,
  // instead of synthesizing effort: "none" which upstream rejects (#603).
  if (
    Object.keys(map).length > 0 &&
    map.off === undefined &&
    !levels.includes("off")
  ) {
    map.off = null;
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

/**
 * models.dev publishes no per-model wire API, yet some models only serve one.
 * Keep this list to verified responses-only ids; everything else falls back
 * to the provider-wide style (see #105).
 */
const RESPONSES_ONLY_MODEL_IDS: ReadonlySet<string> = new Set([
  "muse-spark-1.2-contributor",
  "muse-spark-1.3-contributor",
]);

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
  const experimental = publishedExperimental(raw.experimental);
  const providerMetadata = publishedMetadata(raw.provider);
  // Scoped to opencode-go on purpose: the same model ids exist under other
  // providers (e.g. meta, llmgateway) where the completions path is correct
  // and must not be rerouted (see #105).
  const modelApi =
    nonEmptyString(raw.api) ??
    (providerKey === "opencode-go" && RESPONSES_ONLY_MODEL_IDS.has(modelId.toLowerCase())
      ? "openai-responses"
      : undefined);
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
    ...(experimental !== undefined ? { experimental } : {}),
    ...(providerMetadata !== undefined ? { provider: providerMetadata } : {}),
    ...(modelApi !== undefined ? { modelApi } : {}),
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
        ...(nonEmptyString(provider.npm) ? { npm: nonEmptyString(provider.npm) } : {}),
        env: stringArray(provider.env),
        ...(nonEmptyString(provider.doc) ? { doc: nonEmptyString(provider.doc) } : {}),
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


/**
 * Vendor routes an id spells on its own, e.g. `openai/gpt-6-astra` and
 * `openai-gpt-6-astra` both say `openai`.
 *
 * This is the vendor signal that survives a gateway: a reseller publishes its
 * own record under its own key, but the route it keeps in the id still names
 * whoever owns the weights.
 *
 * It is not the only one — see `isKnownVendorKey`, which covers ids a vendor
 * publishes without any route, such as Xiaomi's bare `mimo-v2.6-pro`.
 */
function vendorPrefixesInModelId(modelId: string): string[] {
  const normalized = normalizedModelId(modelId);
  const found: string[] = [];
  for (const prefix of MODEL_VENDOR_PREFIXES) {
    if (
      normalized.startsWith(`${prefix}/`) ||
      normalized.startsWith(`${prefix}-`) ||
      normalized.startsWith(`${prefix}.`)
    ) {
      found.push(prefix);
    }
  }
  return found;
}


/**
 * Whether a catalog provider key is itself a vendor name.
 *
 * Used as the second owner signal: a publisher whose own key is a vendor is
 * that vendor describing its own model, which is the same claim a route in the
 * id makes. A reseller never qualifies, because its key (`opencode-go`,
 * `nano-gpt`, `requesty`) is not in the vendor set, so this cannot hand a
 * gateway's mark to a row it merely republishes.
 */
function isKnownVendorKey(providerKey: string): boolean {
  return MODEL_VENDOR_PREFIXES.has(providerKey);
}
function modelVendorPrefixes(model: ModelsDevModel): string[] {
  const prefixes = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value !== "string") return;
    const normalized = normalizedProviderKey(value);
    if (normalized) prefixes.add(normalized);
  };
  add(model.providerKey);
  if (typeof model.provider === "string") add(model.provider);
  const providerRecord = typeof model.provider === "object" ? model.provider : undefined;
  add(providerRecord?.id);
  const npmProvider = nonEmptyString(providerRecord?.npm);
  if (npmProvider) add(npmProvider.split("/").at(-1)?.replace(/^@ai-sdk-/, ""));
  for (const prefix of vendorPrefixesInModelId(model.modelId)) prefixes.add(prefix);
  return [...prefixes];
}

function modelMatchesProvider(model: ModelsDevModel, vendorKey?: string): boolean {
  const candidates = new Set(providerKeyCandidates(vendorKey));
  if (candidates.size === 0 || candidates.has("custom")) return false;
  return modelVendorPrefixes(model).some((prefix) => candidates.has(prefix));
}

const KNOWN_PROVIDER_BASE_URLS: Record<string, string[]> = {
  openai: ["https://api.openai.com/v1", "https://chatgpt.com/backend-api"],
  anthropic: ["https://api.anthropic.com"],
  google: ["https://generativelanguage.googleapis.com/v1beta"],
  mistral: ["https://api.mistral.ai/v1"],
  xai: ["https://api.x.ai/v1"],
  groq: ["https://api.groq.com/openai/v1"],
  togetherai: ["https://api.together.xyz/v1"],
  deepseek: ["https://api.deepseek.com"],
  openrouter: ["https://openrouter.ai/api/v1"],
  "fireworks-ai": ["https://api.fireworks.ai/inference/v1"],
  "alibaba-cn": ["https://dashscope.aliyuncs.com/compatible-mode/v1"],
  "moonshotai-cn": ["https://api.moonshot.cn/v1"],
  "siliconflow-cn": ["https://api.siliconflow.cn/v1"],
  volcengine: ["https://ark.cn-beijing.volces.com/api/v3"],
  // MiniMax exposes both an Anthropic endpoint (the published models.dev
  // URL) and an OpenAI-compatible `/v1` endpoint. Treat the latter as the
  // same provider so a custom OpenAI-style row still inherits M3's vision
  // metadata instead of falling back to a text-only generic model.
  "minimax-cn": [
    "https://api.minimaxi.com/v1",
    "https://api.minimaxi.com/anthropic/v1",
  ],
  minimax: [
    "https://api.minimax.io/v1",
    "https://api.minimax.io/anthropic/v1",
  ],
};

const PROVIDER_ALIASES: Record<string, string[]> = {
  // pi-ai names the ChatGPT subscription adapter `openai-codex`, while
  // models.dev publishes its model metadata under `openai`. Keep the
  // transport identity in provider config, but resolve metadata through the
  // corresponding public catalog provider.
  "openai-codex": ["openai", "openai-codex"],
  "openai-codex-responses": ["openai", "openai-codex"],
  together: ["together", "togetherai"],
  "together-ai": ["together", "togetherai"],
  fireworks: ["fireworks", "fireworks-ai"],
  "fireworks-ai": ["fireworks", "fireworks-ai"],
  kimi: ["kimi-for-coding", "kimi-coding"],
  "kimi-coding": ["kimi-coding", "kimi-for-coding"],
  "google-vertex": ["google-vertex"],
  "azure-openai-responses": ["azure", "azure-cognitive-services"],
  "vercel-ai-gateway": ["vercel"],
  "zai-coding-cn": ["zhipuai-coding-plan", "zai-coding-cn"],
  "zhipuai-coding-plan": ["zhipuai-coding-plan", "zai-coding-cn"],
  zhipu: ["zhipuai"],
  bigmodel: ["zhipuai"],
  dashscope: ["alibaba-cn"],
  qwen: ["alibaba-cn"],
  moonshot: ["moonshotai-cn", "moonshotai"],
  doubao: ["volcengine"],
  ark: ["volcengine"],
  minimax: ["minimax-cn", "minimax"],
  "lm-studio": ["lmstudio", "lm-studio"],
  lmstudio: ["lmstudio", "lm-studio"],
};

function providerKeyCandidates(value: string | undefined): string[] {
  const key = normalizedProviderKey(value);
  return [...new Set([key, ...(PROVIDER_ALIASES[key] ?? [])])].filter(Boolean);
}

/**
 * Publishers this app ships a provider for: the models.dev keys behind the
 * first-class presets and the known endpoints, which mirror the providers pi-ai
 * supports.
 *
 * They are the publishers read first when nothing identifies the row's own
 * publisher. A relay's list can name an id a hundred arbitrary resellers also
 * carry, and a reseller's own flags describe *its* deployment, not the one this
 * row talks to; the vendors and gateways the app actually ships describe the
 * model. Resellers outside this set are still read when none of these states the
 * id, because the alternative is dropping a published model to the generic
 * 128k text-only shape.
 */
const SUPPORTED_PUBLISHER_KEYS: ReadonlySet<string> = new Set(
  [
    ...NAMED_ENDPOINT_PRESETS.map((preset) => preset.vendorKey),
    ...Object.keys(KNOWN_PROVIDER_BASE_URLS),
  ].flatMap((key) => providerKeyCandidates(key)),
);

/**
 * Canonical form of a provider base URL: lowercase origin without a trailing
 * slash and without the trailing API version segment, so a row configured with
 * `.../v1` still matches the documented models.dev endpoint.
 */
export function normalizedApiUrl(value: string | undefined): string | undefined {
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

/** Whether two base URLs address the same provider endpoint. */
export function apiMatches(left: string | undefined, right: string | undefined): boolean {
  const normalizedLeft = normalizedApiUrl(left);
  const normalizedRight = normalizedApiUrl(right);
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight);
}


/**
 * Hostname of a base URL, lowercased, or undefined when it has none.
 *
 * Only the host is read: two paths on one host can be the same publisher's
 * different API surfaces, which is exactly what `apiMatches` cannot see.
 */
function hostOfUrl(value: string | undefined): string | undefined {
  const raw = nonEmptyString(value);
  if (!raw) return undefined;
  try {
    return new URL(raw).host.toLowerCase() || undefined;
  } catch {
    return undefined;
  }
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
  if (model.attachment === true) capabilities.add("attachments");
  if (model.temperature === true) capabilities.add("temperature");
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
  vendorProviderKey?: string,
): ModelInfo {
  const contextWindow = positiveInteger(model.limit.context);
  const maxTokens = positiveInteger(model.limit.output);
  const thinkingLevelMap = thinkingLevelMapFromModelsDev(
    model.reasoningOptions,
    model.thinkingLevels,
  );
  return {
    modelId: model.modelId,
    displayName: model.displayName,
    providerId,
    ...(model.description !== undefined ? { description: model.description } : {}),
    ...(model.family !== undefined ? { family: model.family } : {}),
    ...(model.attachment !== undefined ? { attachment: model.attachment } : {}),
    reasoning: model.reasoning,
    ...(model.reasoningOptions !== undefined ? { reasoningOptions: model.reasoningOptions } : {}),
    ...(thinkingLevelMap !== undefined ? { thinkingLevelMap } : {}),
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
    ...(vendorProviderKey ? { catalogVendorKey: vendorProviderKey } : {}),
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
  if (model.provider !== undefined) {
    config.provider = model.provider;
    config.catalogProvider = model.provider;
  }
  if (model.modelApi !== undefined) config.api = model.modelApi;
  return config;
}

/**
 * Sidecar model config for one provider row: the catalog record when the
 * lookup resolves one, otherwise the generic shape.
 *
 * An Anthropic Messages row the catalog cannot identify (a custom gateway URL
 * serving an id several publishers list) still needs the right thinking wire
 * shape: Opus 4.7+ and the Claude 5 family reject budget thinking with a 400.
 * Whether a Claude id takes adaptive or budget thinking is a property of the
 * model, which Anthropic's own record states, not of the deployment. So only
 * the exact Anthropic id's reasoning options transfer; limits and modalities
 * stay generic because they describe the deployment (#990).
 */
export function catalogModelConfigFor(
  catalog: Pick<ModelsDevCatalog, "findModel" | "anthropicThinkingFor">,
  input: { vendorKey?: string; baseUrl?: string; apiStyle?: string; modelId: string },
): ModelConfig {
  const model = catalog.findModel(input);
  if (!model) {
    const generic = genericModelConfig(input.modelId, input.baseUrl ?? "");
    const thinking = input.apiStyle === "anthropic_messages"
      ? catalog.anthropicThinkingFor(input.modelId)
      : undefined;
    return thinking ? { ...generic, ...thinking } : generic;
  }
  const config = modelConfigFromModelsDev(model, input.baseUrl);
  /*
    A record that states no reasoning shape cannot speak for an Anthropic
    Messages row: a record borrowed from another publisher has its own options
    dropped, and a reseller's record describes the reseller's API. Anthropic's
    own record is what says whether this id takes adaptive or budget thinking,
    and losing that would put a rejected shape on the wire (#990).
  */
  const thinking = input.apiStyle === "anthropic_messages" && !config.reasoningOptions?.length
    ? catalog.anthropicThinkingFor(input.modelId)
    : undefined;
  return thinking ? { ...config, ...thinking } : config;
}

type IndexedModel = { model: ModelsDevModel; provider: ModelsDevProvider };

/**
 * Per-generation candidate index built from a loaded catalog. Bounding the
 * lookup by the number of distinct model ids in the catalog (not by the number
 * of distinct queries) keeps the work of a single session-list read constant
 * regardless of how many distinct bindings it contains: no per-query eviction
 * can force an earlier key to be rescanned. It is rebuilt only when the
 * provider map is replaced and is cleared on a failed or fresh load.
 */
class ModelsDevLookupIndex {
  private readonly byModelId = new Map<string, IndexedModel[]>();

  constructor(providers: ReadonlyMap<string, ModelsDevProvider>) {
    for (const provider of providers.values()) {
      for (const model of provider.models) {
        /*
          Every published model is indexed, including the audio-only ones the
          listing drops: `modelsForProvider` decides which models a row
          *offers*, while this index answers for an ID a row already lists, and
          an endpoint that serves a TTS or ASR id has a published record for
          it. Filtering here is what left such a row on the generic seed.
        */
        const entry: IndexedModel = { model, provider };
        for (const key of registrationKeys(model.modelId)) {
          let bucket = this.byModelId.get(key);
          if (!bucket) {
            bucket = [];
            this.byModelId.set(key, bucket);
          }
          if (!bucket.includes(entry)) bucket.push(entry);
        }
      }
    }
  }

  candidates(requested: string): readonly IndexedModel[] {
    const keys = lookupCandidateKeys(requested);
    if (keys.length === 0) return EMPTY_CANDIDATES;
    if (keys.length === 1) {
      return this.byModelId.get(keys[0]) ?? EMPTY_CANDIDATES;
    }
    const result: IndexedModel[] = [];
    const seen = new Set<IndexedModel>();
    for (const key of keys) {
      const bucket = this.byModelId.get(key);
      if (!bucket) continue;
      for (const entry of bucket) {
        if (!seen.has(entry)) {
          seen.add(entry);
          result.push(entry);
        }
      }
    }
    return result;
  }
}

/** Index only aliases the matcher can accept: exact IDs, the region-stripped
 * form, full slash-path leaves, known-vendor dash/dot prefixes, the supported
 * thinking/agent/latest variants, and published release stamps. The matcher
 * remains the final authority (including known-vendor conflicts), but the index
 * must register every alias the matcher accepts: a key it never indexed is a
 * lookup that can never reach the record. */
function candidateKeys(modelId: string): string[] {
  const normalized = normalizedModelId(modelId);
  if (!normalized) return [];
  const keys = new Set<string>();
  const at = normalized.indexOf("@");
  const base = at > 0 ? normalized.slice(0, at) : normalized;

  const add = (value: string) => {
    if (!value) return;
    keys.add(value);
    const slash = value.lastIndexOf("/");
    if (slash >= 0 && slash < value.length - 1) keys.add(value.slice(slash + 1));
    for (const separator of ["-", "."] as const) {
      for (const vendor of MODEL_VENDOR_PREFIXES) {
        const head = `${vendor}${separator}`;
        if (value.startsWith(head) && value.length > head.length) {
          keys.add(value.slice(head.length));
        }
      }
    }
  };

  /*
    Suffixes are stripped after the region, just as `catalogModelIdsMatch`
    does, and either suffix may be the outer one: `foo-0731-thinking` and
    `foo-thinking-0731` both reach `foo`. Aliases are added from both sides so a
    suffixed catalog id and a suffixed request each find the other.
  */
  const variants = new Set<string>();
  for (const value of [normalized, base]) {
    const withoutVariant = stripVariantSuffix(value);
    const withoutRelease = stripReleaseSuffix(value);
    for (const variant of [
      value,
      withoutVariant,
      withoutRelease,
      stripReleaseSuffix(withoutVariant),
      stripVariantSuffix(withoutRelease),
    ]) {
      variants.add(variant);
    }
  }
  for (const value of variants) add(value);
  return [...keys];
}

function registrationKeys(modelId: string): string[] {
  return candidateKeys(modelId);
}

function lookupCandidateKeys(requested: string): string[] {
  return candidateKeys(requested);
}

const EMPTY_CANDIDATES: readonly IndexedModel[] = [];



/**
 * Middle value of the numbers the publishers state. Even counts take the lower
 * of the two middles, so a borrow never rounds a window up on its own.
 */
function medianOf(values: readonly (number | undefined)[]): number | undefined {
  const present = values.filter((value): value is number => value !== undefined);
  if (present.length === 0) return undefined;
  const sorted = [...present].sort((left, right) => left - right);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? sorted[middle]
    : sorted[middle - 1];
}

/**
 * Record to borrow for an id the row's own catalog provider does not publish.
 *
 * models.dev indexes a gateway's copy of a model under the vendor that owns
 * the weights, so an endpoint serving `Vendor/Model` ids can have no record of
 * its own while several other publishers state the identical id. Borrowing
 * that record is what keeps such a model's context window, tool support and
 * vision visible instead of dropping the row to the generic 128k text-only
 * shape.
 *
 * Two rules keep the result honest about what the endpoint will accept:
 *
 * - Tool support follows the majority of the publishers that state it. One
 *   dissenting reseller must not decide the claim for a deployment it does not
 *   describe, and neither may one agreeing reseller: an id a relay lists can be
 *   stated by a hundred publishers, which is what left whole model lists on the
 *   generic seed before. An even split states no majority and claims nothing.
 * - Every other capability is the *intersection*, so the borrow may only
 *   under-claim. Reasoning, image input and image/PDF attachment are reported
 *   only when every publisher states them, and a user who knows the endpoint
 *   does more can still turn them on in Advanced. Limits are the medians the
 *   publishers state, so neither one host's cap nor one host's round-up
 *   decides them.
 */
/**
 * Whether two ids name one model under different spellings.
 *
 * A publisher-prefixed copy (`anthropic/claude-sonnet-4-5` for
 * `claude-sonnet-4-5`, `mify/mimo-v2.5-pro-0731` for `mimo-v2.5-pro`) and a
 * dated or variant spelling of one id are the same model, so their records may
 * be compared with each other. Two unrelated routes that happen to share a leaf
 * (`provider-a/foo` vs `gateway/foo`) are not: that relation is a coincidence of
 * naming, and nothing may treat it as identity.
 *
 * `catalogModelIdsMatch` stays the matcher of record; this only decides which of
 * its matches a borrow without a provider identity may average.
 */
function sameModelSpelling(catalogId: string, requested: string): boolean {
  const left = catalogId.trim().toLowerCase();
  const right = requested.trim().toLowerCase();
  if (!left || !right) return false;
  if (left === right) return true;
  /*
    Either side may carry a route prefix the other does not: a relay lists
    `test/mimo-v2.5` where the catalog publishes `mimo-v2.5`, and a catalog that
    publishes a routed copy answers for the bare id. Two *different* route paths
    that merely share a leaf still never match.
  */
  if (left.endsWith(`/${right}`) || right.endsWith(`/${left}`)) return true;
  const plain = (id: string) => stripReleaseSuffix(stripVariantSuffix(id));
  const plainLeft = plain(left);
  const plainRight = plain(right);
  if (!plainLeft || !plainRight) return false;
  return (
    plainLeft === plainRight ||
    plainLeft.endsWith(`/${plainRight}`) ||
    plainRight.endsWith(`/${plainLeft}`)
  );
}

/**
 * Record to use when nothing identifies the row's provider.
 *
 * A relay or a gateway the catalog cannot place still serves models the catalog
 * knows, and asking for one of them by id used to answer nothing at all. What
 * every publisher of that model agrees on can be claimed instead: the same
 * intersection and median `borrowedModel` computes for an anchored row.
 *
 * One thing is deliberately not claimed. Which *wire shape* a deployment accepts
 * for reasoning is a property of that deployment — the same model behind an
 * OpenAI-compatible gateway and behind Anthropic's own API takes different
 * reasoning fields — so a record borrowed this way drops its `reasoningOptions`
 * rather than speaking for an endpoint no publisher describes. `catalogModelConfigFor`
 * still applies Anthropic's own shape to an Anthropic Messages row that is left
 * without one.
 */
function unanchoredConsensus(entries: readonly ModelsDevModel[]): ModelsDevModel | undefined {
  const consensus = borrowedModel(entries);
  return consensus ? { ...consensus, reasoningOptions: undefined } : undefined;
}

/**
 * Which publisher's records answer for an id the row's own publisher lacks.
 *
 * Two preferences, in order. The app's supported publishers are read first:
 * they are the vendors and gateways this app ships a provider for, so their
 * records describe the model behind an id a relay lists, while a reseller's own
 * flags describe its own deployment. Within that tier a record published under
 * exactly this id outranks one reached through another spelling of it:
 * `XiaomiMiMo/MiMo-V2.5` is the same model as `mimo-v2.5`, but a publisher that
 * lists only its text half must not narrow what the model's own record states
 * about vision. Only when none of them states the model does the pool widen to
 * every publisher that does — siblings included, as this borrow has always read
 * them — because a relay-only id would otherwise be shown as a generic 128k
 * text-only row although the catalog publishes it.
 */
function borrowPool(
  entries: readonly IndexedModel[],
  requested: string,
): readonly ModelsDevModel[] {
  /*
    A record under this id, or under the same id with a variant or release stamp
    stripped: `mimo-v2.5` answers for `mimo-v2.5-thinking`.
  */
  const closestId = (value: string) =>
    normalizedModelId(stripReleaseSuffix(stripVariantSuffix(value)));
  const requestedClosest = closestId(requested);
  const exact = (entry: IndexedModel) => {
    const id = normalizedModelId(entry.model.modelId);
    return id === requested || closestId(id) === requestedClosest;
  };
  const supported = (entry: IndexedModel) =>
    SUPPORTED_PUBLISHER_KEYS.has(normalizedProviderKey(entry.provider.providerKey));
  const tiers = [
    entries.filter((entry) => supported(entry) && exact(entry)),
    entries.filter(supported),
    entries,
  ];
  const pool = tiers.find((tier) => tier.length > 0) ?? [];
  return pool.map((entry) => entry.model);
}

/**
 * Markers a deployment appends to a published id to name its own variant of it:
 * a canary label, a context size, a preview channel. `test/mimo-v2.5-pro-test`
 * and `gemini-2.5-pro-1m` are the published models with such a marker appended.
 *
 * Only a marker on this list is read that way. `-asr`, `-pro` or `-mini` name
 * models of their own, so an unpublished id that carries one of those stays
 * unknown instead of borrowing a sibling model's limits.
 */
const DEPLOYMENT_MARKER_SUFFIXES: ReadonlySet<string> = new Set([
  "test",
  "staging",
  "canary",
  "dev",
  "alpha",
  "beta",
  "rc",
  "exp",
  "experimental",
  "preview",
  "free",
  "trial",
  "thinking",
  "think",
  "agent",
  "latest",
  "1k",
  "2k",
  "4k",
  "32k",
  "64k",
  "128k",
  "200k",
  "256k",
  "512k",
  "1m",
  "2m",
  "4m",
]);

/** The id without one trailing deployment marker, or the id unchanged. */
function dropDeploymentMarker(value: string): string {
  const match = /^(.*)[-_:]([a-z0-9]+)$/i.exec(value);
  if (!match) return value;
  return DEPLOYMENT_MARKER_SUFFIXES.has(match[2].toLowerCase()) ? match[1] : value;
}

/**
 * Published ids to read when nothing the catalog publishes matches the id the
 * service serves: the id behind a route prefix, and that id without one
 * deployment marker. Each is looked up as a whole published id, so nothing here
 * follows a chain of aliases.
 */
function fallbackLookupIds(requested: string): string[] {
  const ids: string[] = [];
  const push = (value: string) => {
    if (value && value !== requested && !ids.includes(value)) ids.push(value);
  };
  const leaf = requested.slice(requested.lastIndexOf("/") + 1);
  push(leaf);
  push(dropDeploymentMarker(leaf));
  push(dropDeploymentMarker(requested));
  return ids;
}

/**
 * The value most entries that state one agree on, or undefined when they split.
 *
 * A single dissenting publisher must not decide a claim, and a single agreeing
 * one must not either: an id in a relay's list can be stated by a hundred
 * resellers, and one reseller's flag is not evidence about the deployment this
 * row talks to. An even split states no majority, so nothing is claimed.
 */
function majorityOf(values: readonly (boolean | undefined)[]): boolean | undefined {
  const stated = values.filter((value): value is boolean => value !== undefined);
  if (stated.length === 0) return undefined;
  const yes = stated.filter(Boolean).length;
  if (yes * 2 > stated.length) return true;
  if (yes * 2 < stated.length) return false;
  return undefined;
}

function borrowedModel(entries: readonly ModelsDevModel[]): ModelsDevModel | undefined {
  if (entries.length === 0) return undefined;
  const toolCall = majorityOf(entries.map((model) => model.toolCall));
  const every = (pick: (model: ModelsDevModel) => boolean | undefined): boolean | undefined =>
    entries.every((model) => pick(model) === true) ? true
      : entries.every((model) => pick(model) === false) ? false
      : undefined;
  const base = entries[0];
  const keptModality = (modality: ModelModality): boolean =>
    entries.every((model) => model.modalities.input.includes(modality));
  const inputModalities = base.modalities.input.filter(keptModality);
  const outputModalities = base.modalities.output.filter((modality) =>
    entries.every((model) => model.modalities.output.includes(modality)),
  );
  const context = medianOf(entries.map((model) => model.limit.context));
  const output = medianOf(entries.map((model) => model.limit.output));
  const source = entries.find(
    (model) =>
      (context === undefined || model.limit.context === context) &&
      (output === undefined || model.limit.output === output),
  ) ?? base;
  const reasoning = every((model) => model.reasoning) === true;
  return {
    ...source,
    // Capabilities that must never be asserted on one publisher's word alone.
    toolCall,
    reasoning,
    thinkingLevels: reasoning ? source.thinkingLevels : [],
    structuredOutput: every((model) => model.structuredOutput),
    attachment: every((model) => model.attachment),
    modalities: {
      input: inputModalities.length > 0 ? inputModalities : ["text"],
      output: outputModalities.length > 0 ? outputModalities : ["text"],
    },
    limit: {
      ...(context !== undefined ? { context } : {}),
      ...(output !== undefined ? { output } : {}),
    },
  };
}

export class ModelsDevCatalog {
  private providers = new Map<string, ModelsDevProvider>();
  private lookupIndex: ModelsDevLookupIndex | undefined;
  /** Host → publishers, derived from the current provider map. */
  private hostIndex: Map<string, ModelsDevProvider[]> | undefined;
  private readonly lookupMemo = new Map<string, ModelsDevModel | undefined>();
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
  private localLoadPromise: Promise<boolean> | undefined;

  constructor(options: ModelsDevCatalogOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? MODELS_DEV_TIMEOUT_MS;
    this.now = options.now ?? (() => Date.now());
    this.catalogPath = options.catalogPath;
  }

  /** Load the bundled release snapshot; this never performs network I/O. */
  async loadLocal(): Promise<boolean> {
    if (this.localLoadPromise) return this.localLoadPromise;
    if (this.localLoadAttempted) return this.loaded;
    this.localLoadAttempted = true;
    this.localLoadPromise = (async () => {
      try {
        const raw = JSON.parse(await readFile(this.catalogPath, "utf8")) as unknown;
        const parsed = parseModelsDevCatalog(raw);
        if (parsed.length === 0) throw new Error("models.dev snapshot contained no providers");
        this.providers = new Map(parsed.map((provider) => [provider.providerKey, provider]));
        // Replacing the provider map invalidates the derived lookup index.
        this.lookupIndex = undefined;
        this.hostIndex = undefined;
        this.lookupMemo.clear();
        this.loaded = true;
        this.source = "bundled";
        this.lastError = undefined;
      } catch (error) {
        this.loaded = false;
        this.lastError = error instanceof Error ? error.message : String(error);
      }
      return this.loaded;
    })();
    try {
      return await this.localLoadPromise;
    } finally {
      this.localLoadPromise = undefined;
    }
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
        // Replacing the provider map invalidates the derived lookup index.
        this.lookupIndex = undefined;
        this.hostIndex = undefined;
        this.lookupMemo.clear();
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
    const apiProviders = [...this.providers.values()].filter((provider) =>
      apiMatches(input.baseUrl, provider.api),
    );
    if (apiProviders.length > 0) {
      // A shared API endpoint does not identify which publisher owns a custom
      // model. Never pick the first provider simply because it was indexed first.
      return apiProviders.find((provider) =>
        candidates.has(normalizedProviderKey(provider.providerKey)),
      ) ?? (apiProviders.length === 1 ? apiProviders[0] : undefined);
    }
    const knownKey = Object.entries(KNOWN_PROVIDER_BASE_URLS).find(([, urls]) =>
      urls.some((url) => apiMatches(input.baseUrl, url)),
    )?.[0];
    if (knownKey) {
      const knownCandidates = new Set(providerKeyCandidates(knownKey));
      const knownProvider = [...this.providers.values()].find((provider) =>
        knownCandidates.has(normalizedProviderKey(provider.providerKey)),
      );
      if (knownProvider) return knownProvider;
    }
    const byKey = [...this.providers.values()].find((provider) =>
      candidates.has(normalizedProviderKey(provider.providerKey)),
    );
    return byKey ?? this.providerForUniqueHost(input.baseUrl);
  }

  /**
   * Publisher that uniquely owns this host, when nothing else identified the row.
   *
   * A custom endpoint on a published host is still that publisher's deployment:
   * a user who types `https://open.bigmodel.cn/api/v1` for the Responses API is
   * on Zhipu, not on an anonymous gateway. The catalog's own `api` host is the
   * evidence, and it is only used when exactly one provider publishes from it,
   * so a shared or unknown host still resolves to nothing — missing metadata
   * stays ahead of wrong metadata.
   *
   * Built lazily from the current provider map and cleared with the lookup
   * index, so it can never describe a previous catalog generation.
   */
  private providerForUniqueHost(baseUrl: string | undefined): ModelsDevProvider | undefined {
    const host = hostOfUrl(baseUrl);
    if (!host) return undefined;
    if (!this.hostIndex) {
      const index = new Map<string, ModelsDevProvider[]>();
      for (const provider of this.providers.values()) {
        const providerHost = hostOfUrl(provider.api);
        if (!providerHost) continue;
        const bucket = index.get(providerHost);
        if (bucket) bucket.push(provider);
        else index.set(providerHost, [provider]);
      }
      this.hostIndex = index;
    }
    const bucket = this.hostIndex.get(host);
    return bucket?.length === 1 ? bucket[0] : undefined;
  }

  findModel(input: { vendorKey?: string; baseUrl?: string; modelId: string }): ModelsDevModel | undefined {
    const requested = normalizedModelId(input.modelId);
    if (!requested) return undefined;
    // Resolve through the index of the current catalog generation. The candidate
    // set is bounded by the catalog's model count, never by the number of
    // distinct lookups a single read performs, so no eviction policy can force
    if (!this.lookupIndex) this.lookupIndex = new ModelsDevLookupIndex(this.providers);
    // Memoize the exact lookup so repeated reads of the same binding never re-touch
    // the matched model. The memo is bounded and cleared wholesale on pressure;
    // even if many distinct keys clear it mid-read, re-resolution goes through the
    // small candidate index, never a full catalog scan.
    const memoKey = `${input.vendorKey ?? ""}\u0000${input.baseUrl ?? ""}\u0000${requested}`;
    if (this.lookupMemo.has(memoKey)) return this.lookupMemo.get(memoKey);
    const preferredProvider = this.providerFor(input);
    // Keep the same tie-breaking order as the scanned lookup: preferred-provider
    // entries first, then the remaining providers in provider-map order.
    const preferred: IndexedModel[] = [];
    const rest: IndexedModel[] = [];
    for (const entry of this.lookupIndex.candidates(requested)) {
      (entry.provider === preferredProvider ? preferred : rest).push(entry);
    }
    const candidates: Array<{
      model: ModelsDevModel;
      provider: ModelsDevProvider;
      score: number;
      exact: boolean;
    }> = [];
    for (const { model, provider } of [...preferred, ...rest]) {
      // A known endpoint must not inherit another provider's capabilities.
      if (preferredProvider && provider !== preferredProvider) continue;
      if (!catalogModelIdsMatch(model.modelId, requested)) continue;
      const exact = model.modelId.toLowerCase() === requested;
      let score = exact ? 20 : 10;
      if (provider === preferredProvider) score += 100;
      if (apiMatches(input.baseUrl, provider.api)) score += 80;
      if (modelMatchesProvider(model, input.vendorKey)) score += 60;
      candidates.push({ model, provider, score, exact });
    }
    candidates.sort((left, right) =>
      right.score - left.score || left.model.modelId.length - right.model.modelId.length,
    );
    /*
    /*
      A record the catalog publishes under exactly this id is this id's record.
      Supported aliases — a release stamp, a thinking variant, a route leaf —
      also reach a *shorter* sibling, and answering with that sibling would
      attach another deployment's limits and capabilities to the row. So exact
      candidates discard the alias-derived ones before the ambiguity test, which
      is what keeps `foo-v2-0731` on its own record while a catalog that only
      publishes `foo-v2` still answers it.
    */
    const exactCandidates = candidates.filter((candidate) => candidate.exact);
    const pool = exactCandidates.length > 0 ? exactCandidates : candidates;
    /* Within the row's own catalog provider this is an exact-provider lookup:
       the provider identity is known, so its record for the id — a direct hit
       or a supported alias — is authoritative.

       With no provider identity the scores prove nothing about identity, so a
       catalog answer is only usable when it is unambiguous — and only over the
       alias-derived pool, since an exact record already outranks its aliases.
       Two providers publishing the same id must not have one chosen for the
       other. */
    const resolved = pool[0]?.model;
    const result = preferredProvider
      ? resolved
      : pool.length === 1 ? resolved : undefined;
    /* The row's own catalog provider did not publish this id. Borrowing needs a
       known provider identity to anchor on: the row resolved to a catalog
       provider whose own records are authoritative, so anything missing from it
       can be checked against the other publishers of the exact id instead of
       dropping the model to the generic shape.

       This only fills a miss the lookup already had — a record the preferred
       provider does publish stays authoritative.

       With no provider identity at all the scores still prove nothing about
       identity, so no single publisher's record is adopted. What the publishers
       of the *same model in another spelling* state is a different question, and
       its answer can be claimed without adopting any one deployment's claims:
       the publishers this app ships answer first, tool support follows the ones
       that state it, capabilities are under-claimed and the limits are the lower
       median. Two routes that merely share a leaf (`provider-a/foo` vs
       `gateway/foo`) never enter that set, so an id whose identity is genuinely
       unknown still resolves to nothing. */
    let borrowed = result ??
      (preferredProvider
        ? this.borrowedAcrossProviders(input)
        : unanchoredConsensus(
            borrowPool(
              candidates.filter((candidate) => sameModelSpelling(candidate.model.modelId, requested)),
              requested,
            ),
          ));
    /*
      Nothing the catalog publishes answered for the id as served. A deployment
      can put the model behind a route prefix or append a marker of its own
      (`test/mimo-v2.5`, `mimo-v2.5-pro-test`), and the model is still the one
      the catalog publishes. Reading that whole published id is the last resort,
      so a suffix the catalog uses for models of its own — `-asr`, `-tts`,
      `-voiceclone` — cannot turn an unknown id into a different model's record.
    */
    if (!borrowed) {
      for (const fallbackId of fallbackLookupIds(requested)) {
        borrowed = this.borrowedAcrossProviders(input, fallbackId);
        if (borrowed) break;
      }
    }
    // Cache the result (a miss included) so a repeated miss is also O(1) and
    // cannot grow the candidate index with query-dependent keys.
    this.lookupMemo.set(memoKey, borrowed);
    if (this.lookupMemo.size > LOOKUP_MEMO_LIMIT) this.lookupMemo.clear();
    return borrowed;
  }

  /**
   * Exact-id fallback across catalog providers, used only when the row resolved
   * to a catalog provider that published nothing for the id.
   *
   * A gateway's copy of a model is indexed under the vendor that owns the
   * weights, so an endpoint serving `Vendor/Model` ids routinely has no record
   * of its own while other publishers state the identical id. Their record is
   * what keeps that model's window, tool support and vision visible.
   *
   * Three rules keep this from borrowing anything identity-sensitive:
   *
   * - A provider sharing the row's own endpoint is an alias for the row, not an
   *   independent source. Its failure to publish the id is an answer about this
   *   deployment, so nothing is borrowed past it.
   * - The publishers this app ships a provider for answer before arbitrary
   *   resellers do, in the same order the unanchored borrow uses: an id a
   *   supported publisher states describes the model, while a reseller's copy
   *   describes its own deployment of it.
   * - Only an identical id transfers, and only as a whole published id: a
   *   record the index reaches through an alias — a bare route leaf behind a
   *   prefix, a vendor-prefixed variant — describes a *different* id.
   *
   * `lookupId` reads the record of a published id the served name reduces to
   * (`test/mimo-v2.5-pro-test` → `mimo-v2.5-pro`); it is only used when nothing
   * published answered for the served id itself.
   */
  private borrowedAcrossProviders(
    input: { vendorKey?: string; baseUrl?: string; modelId: string },
    lookupId?: string,
  ): ModelsDevModel | undefined {
    // `findModel` already rejected an empty id; normalize here so the compare
    // below is case-insensitive against the catalog's own normalization.
    const requested = lookupId ?? normalizedModelId(input.modelId);
    const matches: IndexedModel[] = [];
    const seen = new Set<string>();
    for (const candidate of this.lookupIndex?.candidates(requested) ?? []) {
      const { model, provider } = candidate;
      // The row's endpoint owns its own answers, including a negative one.
      if (apiMatches(input.baseUrl, provider.api)) continue;
      if (normalizedModelId(model.modelId) !== requested) continue;
      const key = `${provider.providerKey}\u0000${model.modelId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      matches.push({ model, provider });
    }
    return borrowedModel(borrowPool(matches, requested));
  }

  /**
   * Thinking wire metadata Anthropic publishes for exactly this id, or nothing.
   * Aliases and other publishers' copies never answer: only Anthropic's own
   * record states which thinking shape a Claude model accepts.
   */
  anthropicThinkingFor(
    modelId: string,
  ): Pick<ModelConfig, "reasoningOptions" | "thinkingLevelMap"> | undefined {
    const requested = normalizedModelId(modelId);
    const model = this.providers.get("anthropic")?.models.find(
      (candidate) => normalizedModelId(candidate.modelId) === requested,
    );
    if (!model?.reasoning || !model.reasoningOptions?.length) return undefined;
    const thinkingLevelMap = thinkingLevelMapFromModelsDev(
      model.reasoningOptions,
      model.thinkingLevels,
    );
    return {
      reasoningOptions: model.reasoningOptions,
      ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
    };
  }

  modelsForProvider(input: {
    vendorKey?: string;
    baseUrl?: string;
    providerId: string;
    /**
     * Include the models this provider publishes next to its chat models —
     * embedding, speech, image and reranking endpoints. The settings picker
     * asks for them because it renders the service's own catalog of what the
     * credential can call; session and agent paths keep the default, which is
     * the text models they can actually run.
     */
    includeNonChat?: boolean;
  }): ModelInfo[] {
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
          if (seen.has(key)) return false;
          if (!input.includeNonChat && !isTextAgentModel(model)) return false;
          if (!preferredProvider && !modelMatchesProvider(model, input.vendorKey)) return false;
          seen.add(key);
          return true;
        })
        .map((model) =>
          modelInfoFromModelsDev(
            model,
            input.providerId,
            this.vendorProviderKeyForModel({
              vendorKey: input.vendorKey,
              baseUrl: input.baseUrl,
              modelId: model.modelId,
            }),
          ),
        ),
    );
  }

  /** models.dev provider key for a configured row, when the catalog knows it. */
  providerKeyForRow(input: { vendorKey?: string; baseUrl?: string }): string | undefined {
    return this.providerFor(input)?.providerKey;
  }

  /**
   * Catalog provider key of the vendor that OWNS a model id — not the host
   * whose record this lookup happened to score highest.
   *
   * A custom OpenAI-compatible row serves several vendors at once, so its own
   * base URL resolves to no catalog provider (`providerKeyForRow` answers
   * nothing), while every id it serves is still published somewhere under a
   * vendor route such as `openai/gpt-6-astra`. Reading that route across all
   * publishers names the owner, so a row can carry its own vendor's identity
   * instead of inheriting whichever gateway's record won.
   *
   * Metadata only: it changes no capability, limit, or wire id, and it never
   * overrides `providerKeyForRow`. Used to choose a display mark.
   */
  vendorProviderKeyForModel(input: {
    vendorKey?: string;
    baseUrl?: string;
    modelId: string;
  }): string | undefined {
    const requested = normalizedModelId(input.modelId);
    if (!requested) return undefined;
    // Reuse the same generation-indexed candidate set `findModel` searches, so
    // this costs one map lookup rather than a catalog scan.
    if (!this.lookupIndex) this.lookupIndex = new ModelsDevLookupIndex(this.providers);
    const publishers = this.lookupIndex.candidates(requested);
    const spellings = [
      requested,
      ...publishers.flatMap((entry) => entry.model.modelId),
    ];
    const published = this.providers;
    // Strongest signal first: the vendor route inside the id itself.
    for (const prefix of [...new Set(spellings.flatMap(vendorPrefixesInModelId))]) {
      for (const key of providerKeyCandidates(prefix)) {
        if (published.has(key)) return key;
      }
    }
    /* Then the publisher's own identity, for ids that carry no route. Xiaomi
       publishes `mimo-v2.6-pro` under its own key with no `xiaomi/` prefix, so
       the id alone names nothing. A publisher whose own key IS a known vendor
       is that vendor describing its own model, which is the same claim the
       route makes — and a reseller is never mistaken for one, because its key
       (`opencode-go`, `nano-gpt`) is not in the vendor set and so is skipped. */
    for (const entry of publishers) {
      const key = normalizedProviderKey(entry.provider.providerKey);
      if (!isKnownVendorKey(key)) continue;
      for (const candidate of providerKeyCandidates(key)) {
        if (published.has(candidate)) return candidate;
      }
    }
    return undefined;
  }
}
