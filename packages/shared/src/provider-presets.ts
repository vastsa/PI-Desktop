/** Shared identifiers and connection defaults for first-class provider presets. */

export const OPENCODE_GO_API_STYLE = "opencode_go" as const;
export const OPENCODE_GO_NAME = "OpenCode Go";
export const OPENCODE_GO_BASE_URL = "https://opencode.ai/zen/go/v1";

export const ZHIPU_PRESET_IDS = [
  "zhipuai",
  "zhipuai-coding-plan",
  "zai",
  "zai-coding-plan",
] as const;

export type ZhipuPresetId = (typeof ZHIPU_PRESET_IDS)[number];

export type ZhipuEndpointPreset = {
  id: ZhipuPresetId;
  /** models.dev provider key persisted as `vendorKey`. */
  vendorKey: ZhipuPresetId;
  name: string;
  baseUrl: string;
  codingPlan: boolean;
  aliases: readonly string[];
};

export const ZHIPU_ENDPOINT_PRESETS: readonly ZhipuEndpointPreset[] = [
  {
    id: "zhipuai",
    vendorKey: "zhipuai",
    name: "Zhipu AI",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    codingPlan: false,
    aliases: ["zhipu", "bigmodel"],
  },
  {
    id: "zhipuai-coding-plan",
    vendorKey: "zhipuai-coding-plan",
    name: "Zhipu AI Coding Plan",
    baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
    codingPlan: true,
    aliases: ["zai-coding-cn"],
  },
  {
    id: "zai",
    vendorKey: "zai",
    name: "Z.AI",
    baseUrl: "https://api.z.ai/api/paas/v4",
    codingPlan: false,
    aliases: [],
  },
  {
    id: "zai-coding-plan",
    vendorKey: "zai-coding-plan",
    name: "Z.AI Coding Plan",
    baseUrl: "https://api.z.ai/api/coding/paas/v4",
    codingPlan: true,
    aliases: [],
  },
];

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

function presetById(id: ZhipuPresetId): ZhipuEndpointPreset {
  const preset = ZHIPU_ENDPOINT_PRESETS.find((item) => item.id === id);
  if (!preset) throw new Error(`unknown Zhipu preset: ${id}`);
  return preset;
}

/**
 * Resolve a Zhipu / Z.AI named endpoint from a stored row.
 *
 * URL wins when it addresses a known BigModel or Z.AI host, so a Coding Plan
 * path cannot be catalog-matched as the standard API. `vendorKey` covers
 * proxies and pi-ai's `zai-coding-cn` alias.
 */
export function matchZhipuPreset(input: {
  vendorKey?: string;
  baseUrl?: string;
}): ZhipuEndpointPreset | undefined {
  const url = normalizeEndpointUrl(input.baseUrl);
  if (url) {
    const exact = ZHIPU_ENDPOINT_PRESETS.find(
      (preset) => normalizeEndpointUrl(preset.baseUrl) === url,
    );
    if (exact) return exact;
    if (url.includes("open.bigmodel.cn")) {
      return presetById(url.includes("/coding/") ? "zhipuai-coding-plan" : "zhipuai");
    }
    if (url.includes("api.z.ai")) {
      return presetById(url.includes("/coding/") ? "zai-coding-plan" : "zai");
    }
  }
  const key = normalizedVendorKey(input.vendorKey);
  if (!key || key === "custom") return undefined;
  return ZHIPU_ENDPOINT_PRESETS.find(
    (preset) => preset.vendorKey === key || preset.aliases.includes(key),
  );
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
