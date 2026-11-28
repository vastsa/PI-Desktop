import type { ModelInfo, ModelModality } from "@pi-desktop/shared";
import operationMetadata from "./settings-operation-metadata.json" with { type: "json" };

// Desktop preset IDs predate Pi's namespaces. These aliases select a Pi provider;
// they never change the user's endpoint or on-wire model ID.
export const PI_VENDOR_ALIASES: Record<string, string> = {
  zhipuai: "zai", "zhipuai-coding-plan": "zai-coding-cn",
  "zai-coding-plan": "zai-coding-plan",
};

/**
 * ID family to the publisher that owns the model. An unknown endpoint serving
 * one of these leaves takes that publisher's own record when it publishes the
 * matched base ID, so a reseller's narrower copy never decides the window or
 * thinking shape. Exact IDs win before whitelisted deployment-label fallback;
 * the configured wire ID is never rewritten, and identified providers remain
 * authoritative.
 */
export const RELAY_FAMILY_PUBLISHERS: Record<string, string> = {
  claude: "anthropic", gpt: "openai", o1: "openai", o3: "openai", o4: "openai",
  gemini: "google", grok: "xai",
  // Open-weight families whose owner publishes the IDs a relay actually serves.
  mimo: "xiaomi", glm: "zai", deepseek: "deepseek",
  kimi: "moonshotai", minimax: "minimax",
  qwen: "alibaba", hy: "tencent",
};

/**
 * The publisher that owns the weights behind a served leaf, when the family
 * names one. A generation number rides on the family token (`qwen3`,
 * `hy4-preview`), so the token's letters name the owner; only trailing digits
 * are stripped, and a token registered as-is always wins first, so `o1` stays
 * OpenAI rather than collapsing to an unregistered `o`.
 */
export function relayFamilyPublisher(leafId: string): string | undefined {
  const token = leafId.split(/[-.]/)[0] ?? "";
  for (const candidate of [token, token.replace(/\d+$/, "")]) {
    const publisher = RELAY_FAMILY_PUBLISHERS[candidate];
    if (publisher) return publisher;
  }
  return undefined;
}
const leaf = (id: string) => id.toLowerCase().split("/").at(-1);

/**
 * Display-only compatibility data for speech/embedding/image settings rows that
 * Pi's chat-provider records do not publish. It has no auth, prices, refresh,
 * routing or dispatch.
 * Chat selection and typed Pi operation lookups never consult this data.
 */
export function settingsOperationMetadata(providerId: string, vendor?: string, id?: string): ModelInfo[] {
  const candidates = operationMetadata.filter(row =>
    (!vendor || row.vendor === vendor) && (!id || leaf(row.id) === leaf(id.trim())));
  const unique = new Map<string, typeof candidates>();
  for (const row of candidates) {
    const key = id ? id.trim().toLowerCase() : row.id;
    unique.set(key, [...(unique.get(key) ?? []), row]);
  }
  return [...unique.values()].flatMap(rows => {
    const row = rows[0];
    if (!rows.every(other => JSON.stringify([other.modalities, other.contextWindow, other.maxTokens]) === JSON.stringify([row.modalities, row.contextWindow, row.maxTokens]))) return [];
    const modalities = { input: row.modalities.input as ModelModality[], output: row.modalities.output as ModelModality[] };
    return [{ providerId, modelId: id ?? row.id, displayName: row.name, modalities,
      contextWindow: row.contextWindow, maxTokens: row.maxTokens,
      capabilities: [...new Set([...modalities.input, ...modalities.output])].filter((mode): mode is "text" | "audio" | "video" => mode === "text" || mode === "audio" || mode === "video"),
      source: "bundled" as const }];
  });
}
