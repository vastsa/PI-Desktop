import {
  OPENCODE_GO_API_STYLE,
  OPENCODE_GO_BASE_URL,
  OPENCODE_GO_NAME,
  type ModelBinding,
  type ModelInfo,
  type ProviderPublic,
  type ThinkingLevel,
} from "@pi-desktop/shared";

export function hostFromBaseUrl(baseUrl?: string | null): string {
  if (!baseUrl) return "—";
  try {
    return new URL(baseUrl).host || baseUrl;
  } catch {
    return baseUrl.replace(/^https?:\/\//, "").split("/")[0] || baseUrl;
  }
}

export const API_STYLE_OPTIONS = [
  ["chat_completions", "settings.apiStyleChatCompletions"],
  [OPENCODE_GO_API_STYLE, "settings.apiStyleOpenCodeGo"],
  ["responses", "settings.apiStyleResponses"],
  ["anthropic_messages", "settings.apiStyleAnthropic"],
  ["google_generative_ai", "settings.apiStyleGoogle"],
  ["openai_codex_responses", "settings.apiStyleCodexResponses"],
  ["pi_messages", "settings.apiStylePiMessages"],
] as const;

/**
 * The styles a hand-configured provider may pick. The two vendor-account wire
 * APIs are excluded: they only ever come from a signed-in subscription (the
 * Codex conversation envelope, the radius gateway), and neither works with a
 * pasted key against a base URL the user typed.
 */
export const CUSTOM_API_STYLE_OPTIONS = API_STYLE_OPTIONS.filter(
  ([style]) => style !== "openai_codex_responses" && style !== "pi_messages",
);

export type ApiStyle = (typeof API_STYLE_OPTIONS)[number][0];

export function fixedProviderFieldsForApiStyle(
  apiStyle?: string | null,
): { name: string; baseUrl: string } | null {
  return apiStyle === OPENCODE_GO_API_STYLE
    ? { name: OPENCODE_GO_NAME, baseUrl: OPENCODE_GO_BASE_URL }
    : null;
}

export type ProviderModelDraft = ModelBinding & {
  source: "catalog" | "custom" | "unknown";
};

export function normalizeApiStyle(value?: string | null): ApiStyle {
  return API_STYLE_OPTIONS.some(([style]) => style === value)
    ? (value as ApiStyle)
    : "chat_completions";
}

export type ProviderForm = {
  name: string;
  baseUrl: string;
  models: ProviderModelDraft[];
  apiKey: string;
  apiStyle: ApiStyle;
};

export const EMPTY_PROVIDER_FORM: ProviderForm = {
  name: "",
  baseUrl: "",
  models: [],
  apiKey: "",
  apiStyle: "chat_completions",
};

export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const DEFAULT_MAX_TOKENS = 8_192;
const THINKING_ORDER: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export function isCatalogModel(model: ModelInfo | null | undefined): boolean {
  return model?.source === "bundled" || model?.catalogSource === "models.dev" || model?.catalogSource === "pi-ai";
}

export function modelSource(model: ModelInfo): "catalog" | "custom" {
  return isCatalogModel(model) ? "catalog" : "custom";
}

export function modelDraftFromInfo(model: ModelInfo): ProviderModelDraft {
  const catalogHasThinkingMap = model.thinkingLevelMap !== undefined;
  const thinkingLevels: ThinkingLevel[] = model.supportedThinkingLevels?.length
    ? model.supportedThinkingLevels
    : catalogHasThinkingMap
      ? []
      : model.reasoning === true
        ? (["low", "medium", "high"] as ThinkingLevel[])
        : [];
  const orderedThinkingLevels = [...thinkingLevels].sort(
    (a, b) => THINKING_ORDER.indexOf(a) - THINKING_ORDER.indexOf(b),
  );
  return {
    id: model.modelId,
    contextWindow: model.contextWindow || DEFAULT_CONTEXT_WINDOW,
    maxTokens: model.maxTokens || DEFAULT_MAX_TOKENS,
    thinkingLevels: orderedThinkingLevels,
    defaultThinkingLevel: orderedThinkingLevels.includes("medium")
      ? "medium"
      : orderedThinkingLevels[0] ?? null,
    source: modelSource(model),
  };
}

export function fallbackModelDraft(id: string): ProviderModelDraft {
  return {
    id,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
    thinkingLevels: [],
    defaultThinkingLevel: null,
    source: "custom",
  };
}

export function formFromProvider(provider: ProviderPublic): ProviderForm {
  const models = provider.models?.length
    ? provider.models
    : provider.defaultModelId
      ? [
          {
            id: provider.defaultModelId,
            contextWindow: DEFAULT_CONTEXT_WINDOW,
            maxTokens: DEFAULT_MAX_TOKENS,
            thinkingLevels: [],
            defaultThinkingLevel: null,
          },
        ]
      : [];
  const apiStyle = normalizeApiStyle(provider.apiStyle);
  const fixedFields = fixedProviderFieldsForApiStyle(apiStyle);
  return {
    name: fixedFields?.name ?? provider.name,
    baseUrl: fixedFields?.baseUrl ?? provider.baseUrl ?? "",
    models: models.map((model) => ({ ...model, source: "unknown" as const })),
    apiKey: "",
    apiStyle,
  };
}
