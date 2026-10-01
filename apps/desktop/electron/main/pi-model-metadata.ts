import type { Api, Model, Models } from "@earendil-works/pi-ai";
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
const publishers: Record<string, string> = {
  claude: "anthropic", gpt: "openai", o1: "openai", o3: "openai", o4: "openai",
  gemini: "google", grok: "xai",
  // Open-weight families whose owner publishes the IDs a relay actually serves.
  mimo: "xiaomi", glm: "zai", deepseek: "deepseek",
  kimi: "moonshotai", minimax: "minimax",
};
const leaf = (id: string) => id.toLowerCase().split("/").at(-1);
// Only deployment-added environment/context labels are safe to remove as a
// fallback. Model variants such as `thinking`, `preview`, and dated releases
// are deliberately absent: those can name a distinct model with different
// capabilities. Exact leaves are always checked before this fallback.
const DEPLOYMENT_SUFFIXES = new Set([
  "test", "staging", "canary", "dev",
  "1m", "2m", "4m", "32k", "64k", "128k", "200k", "256k", "512k",
]);
function withoutDeploymentSuffix(id: string): string | undefined {
  const match = /^(.*)[-_:]([a-z0-9]+)$/i.exec(id);
  if (!match || !DEPLOYMENT_SUFFIXES.has(match[2].toLowerCase())) return undefined;
  return match[1];
}
const capabilities = (m: Model<Api>) => JSON.stringify([m.input, m.reasoning, m.contextWindow, m.maxTokens, m.thinkingLevelMap]);

/** Match exact route leaves first, then a narrow deployment-suffix fallback. */
export function relayChatMetadata(models: Models, id: string): Model<Api> | undefined {
  const requested = leaf(id.trim());
  if (!requested) return undefined;
  const available = models.getModelsOfType("chat");
  const findHits = (candidate: string) => available.filter(model => leaf(model.id) === candidate);

  // A provider may append multiple deployment labels (`-1m-test`). Remove
  // only one whitelisted trailing label at a time, stopping at the nearest
  // published base ID. Never rewrite the model ID used on the wire.
  let lookupId = requested;
  let hits = findHits(lookupId);
  while (!hits.length) {
    const base = withoutDeploymentSuffix(lookupId);
    if (!base) break;
    lookupId = base;
    hits = findHits(lookupId);
  }
  if (!hits.length) return undefined;
  const publisher = publishers[lookupId.split(/[-.]/)[0] ?? ""];
  const official = hits.filter(model => model.provider === publisher);
  if (official.length === 1) return official[0];
  return hits.every(model => capabilities(model) === capabilities(hits[0])) ? hits[0] : undefined;
}

/**
 * Display-only compatibility data for speech/embedding/image settings rows that
 * Pi 0.99.1 does not publish. It has no auth, prices, refresh, routing or dispatch.
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
