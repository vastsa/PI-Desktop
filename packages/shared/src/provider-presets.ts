/** Shared identifiers and connection defaults for first-class provider presets. */

import type { CatalogApiStyle } from "./model-catalog.js";

export const OPENCODE_GO_API_STYLE = "opencode_go" as const;
export const OPENCODE_GO_NAME = "OpenCode Go";
export const OPENCODE_GO_BASE_URL = "https://opencode.ai/zen/go/v1";

export type NamedPresetGroup = "international" | "china";

export type NamedEndpointPreset = {
  id: string;
  /** models.dev provider key persisted as `vendorKey`. */
  vendorKey: string;
  name: string;
  baseUrl: string;
  apiStyle: CatalogApiStyle;
  group: NamedPresetGroup;
  /** i18n key under `settings`. */
  labelKey: string;
  aliases?: readonly string[];
  /** Completions thinking/tool-stream flags for Zhipu / Z.AI hosts. */
  zhipuCompat?: boolean;
};

export const NAMED_ENDPOINT_PRESETS: readonly NamedEndpointPreset[] = [
  {
    id: "openai",
    vendorKey: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    apiStyle: "responses",
    group: "international",
    labelKey: "settings.presetOpenai",
  },
  {
    id: "anthropic",
    vendorKey: "anthropic",
    name: "Anthropic",
    baseUrl: "https://api.anthropic.com",
    apiStyle: "anthropic_messages",
    group: "international",
    labelKey: "settings.presetAnthropic",
  },
  {
    id: "google",
    vendorKey: "google",
    name: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    apiStyle: "google_generative_ai",
    group: "international",
    labelKey: "settings.presetGoogle",
    aliases: ["gemini"],
  },
  {
    id: "openrouter",
    vendorKey: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    apiStyle: "chat_completions",
    group: "international",
    labelKey: "settings.presetOpenrouter",
  },
  {
    id: "groq",
    vendorKey: "groq",
    name: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    apiStyle: "chat_completions",
    group: "international",
    labelKey: "settings.presetGroq",
  },
  {
    id: "xai",
    vendorKey: "xai",
    name: "xAI",
    baseUrl: "https://api.x.ai/v1",
    apiStyle: "chat_completions",
    group: "international",
    labelKey: "settings.presetXai",
  },
  {
    id: "mistral",
    vendorKey: "mistral",
    name: "Mistral",
    baseUrl: "https://api.mistral.ai/v1",
    apiStyle: "chat_completions",
    group: "international",
    labelKey: "settings.presetMistral",
  },
  {
    id: "togetherai",
    vendorKey: "togetherai",
    name: "Together AI",
    baseUrl: "https://api.together.xyz/v1",
    apiStyle: "chat_completions",
    group: "international",
    labelKey: "settings.presetTogether",
    aliases: ["together"],
  },
  {
    id: "fireworks-ai",
    vendorKey: "fireworks-ai",
    name: "Fireworks",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    apiStyle: "chat_completions",
    group: "international",
    labelKey: "settings.presetFireworks",
    aliases: ["fireworks"],
  },
  {
    id: OPENCODE_GO_API_STYLE,
    vendorKey: "opencode-go",
    name: OPENCODE_GO_NAME,
    baseUrl: OPENCODE_GO_BASE_URL,
    apiStyle: OPENCODE_GO_API_STYLE,
    group: "international",
    labelKey: "settings.apiStyleOpenCodeGo",
  },
  {
    id: "zai",
    vendorKey: "zai",
    name: "Z.AI",
    baseUrl: "https://api.z.ai/api/paas/v4",
    apiStyle: "chat_completions",
    group: "international",
    labelKey: "settings.presetZaiApi",
    zhipuCompat: true,
  },
  {
    id: "zai-coding-plan",
    vendorKey: "zai-coding-plan",
    name: "Z.AI Coding Plan",
    baseUrl: "https://api.z.ai/api/coding/paas/v4",
    apiStyle: "chat_completions",
    group: "international",
    labelKey: "settings.presetZaiCodingPlan",
    zhipuCompat: true,
  },
  {
    id: "deepseek",
    vendorKey: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    apiStyle: "chat_completions",
    group: "china",
    labelKey: "settings.presetDeepseek",
  },
  {
    id: "alibaba-cn",
    vendorKey: "alibaba-cn",
    name: "Alibaba (China)",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    apiStyle: "chat_completions",
    group: "china",
    labelKey: "settings.presetAlibabaCn",
    aliases: ["dashscope", "qwen"],
  },
  {
    id: "moonshotai-cn",
    vendorKey: "moonshotai-cn",
    name: "Moonshot AI (China)",
    baseUrl: "https://api.moonshot.cn/v1",
    apiStyle: "chat_completions",
    group: "china",
    labelKey: "settings.presetMoonshotCn",
    aliases: ["moonshot"],
  },
  {
    id: "zhipuai",
    vendorKey: "zhipuai",
    name: "Zhipu AI",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    apiStyle: "chat_completions",
    group: "china",
    labelKey: "settings.presetZhipuApi",
    aliases: ["zhipu", "bigmodel"],
    zhipuCompat: true,
  },
  {
    id: "zhipuai-coding-plan",
    vendorKey: "zhipuai-coding-plan",
    name: "Zhipu AI Coding Plan",
    baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
    apiStyle: "chat_completions",
    group: "china",
    labelKey: "settings.presetZhipuCodingPlan",
    aliases: ["zai-coding-cn"],
    zhipuCompat: true,
  },
  {
    id: "siliconflow-cn",
    vendorKey: "siliconflow-cn",
    name: "SiliconFlow (China)",
    baseUrl: "https://api.siliconflow.cn/v1",
    apiStyle: "chat_completions",
    group: "china",
    labelKey: "settings.presetSiliconflowCn",
  },
  {
    id: "volcengine",
    vendorKey: "volcengine",
    name: "Volcengine Ark",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    apiStyle: "chat_completions",
    group: "china",
    labelKey: "settings.presetVolcengine",
    aliases: ["doubao", "ark"],
  },
  {
    id: "minimax-cn",
    vendorKey: "minimax-cn",
    name: "MiniMax",
    baseUrl: "https://api.minimaxi.com/anthropic/v1",
    apiStyle: "anthropic_messages",
    group: "china",
    labelKey: "settings.presetMinimaxCn",
    aliases: ["minimax"],
  },
  {
    id: "kimi-for-coding",
    vendorKey: "kimi-for-coding",
    name: "Kimi For Coding",
    baseUrl: "https://api.kimi.com/coding/v1",
    apiStyle: "anthropic_messages",
    group: "china",
    labelKey: "settings.presetKimiCoding",
    aliases: ["kimi-coding", "kimi"],
  },
];

export const NAMED_PRESET_GROUPS: readonly NamedPresetGroup[] = ["international", "china"];

export function namedPresetsInGroup(group: NamedPresetGroup): NamedEndpointPreset[] {
  return NAMED_ENDPOINT_PRESETS.filter((preset) => preset.group === group);
}

/** Canonical form of a configured endpoint for preset matching. */
export function normalizeEndpointUrl(value: string | undefined): string | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  try {
    const parsed = new URL(raw);
    const pathname = parsed.pathname.replace(/\/+$/, "");
    return `${parsed.protocol.toLowerCase()}//${parsed.host.toLowerCase()}${pathname}`;
  } catch {
    return raw.replace(/\/+$/, "").toLowerCase();
  }
}

function normalizedVendorKey(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/_/g, "-");
}

function presetByUrl(url: string): NamedEndpointPreset | undefined {
  const exact = NAMED_ENDPOINT_PRESETS.find(
    (preset) => normalizeEndpointUrl(preset.baseUrl) === url,
  );
  if (exact) return exact;
  if (url.includes("open.bigmodel.cn")) {
    return NAMED_ENDPOINT_PRESETS.find((preset) =>
      preset.id === (url.includes("/coding/") ? "zhipuai-coding-plan" : "zhipuai"),
    );
  }
  if (url.includes("api.z.ai")) {
    return NAMED_ENDPOINT_PRESETS.find((preset) =>
      preset.id === (url.includes("/coding/") ? "zai-coding-plan" : "zai"),
    );
  }
  return undefined;
}

/**
 * Resolve a named endpoint from a stored row.
 *
 * URL wins when it addresses a published host, so API vs Coding Plan (or
 * China vs international) cannot be catalog-matched as the wrong record.
 */
export function matchNamedPreset(input: {
  vendorKey?: string;
  baseUrl?: string;
  apiStyle?: string;
}): NamedEndpointPreset | undefined {
  const url = normalizeEndpointUrl(input.baseUrl);
  if (url) {
    const byUrl = presetByUrl(url);
    if (byUrl) return byUrl;
  }
  if (input.apiStyle === OPENCODE_GO_API_STYLE) {
    return NAMED_ENDPOINT_PRESETS.find((preset) => preset.id === OPENCODE_GO_API_STYLE);
  }
  const key = normalizedVendorKey(input.vendorKey);
  if (!key || key === "custom") return undefined;
  return NAMED_ENDPOINT_PRESETS.find(
    (preset) => preset.vendorKey === key || preset.aliases?.includes(key) || preset.id === key,
  );
}

export const ZHIPU_ENDPOINT_PRESETS = NAMED_ENDPOINT_PRESETS.filter(
  (preset) => preset.zhipuCompat,
);

export function matchZhipuPreset(input: {
  vendorKey?: string;
  baseUrl?: string;
}): NamedEndpointPreset | undefined {
  const matched = matchNamedPreset(input);
  return matched?.zhipuCompat ? matched : undefined;
}

export function isZhipuEndpoint(input: {
  vendorKey?: string;
  baseUrl?: string;
}): boolean {
  return matchZhipuPreset(input) !== undefined;
}

/** pi-ai Completions flags for Zhipu / Z.AI thinking and tool streaming. */
export function zhipuRequestCompat(input: {
  vendorKey?: string;
  baseUrl?: string;
}): { thinkingFormat: "zai"; zaiToolStream: true } | undefined {
  return isZhipuEndpoint(input)
    ? { thinkingFormat: "zai", zaiToolStream: true }
    : undefined;
}
