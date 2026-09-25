/**
 * The models a new AI service starts with, so saving a key is enough to chat.
 *
 * Only chat models that can call tools are candidates: an agent turn needs
 * both, and embedding, speech, image, moderation and research endpoints show
 * up in most `/models` answers next to them. When the list carries models.dev
 * metadata, the newest stable models win, one per family, so the picks cover
 * different lines instead of three snapshots of one; the first pick becomes
 * the service's default model. Without metadata (a local server or a private
 * gateway) nothing says which id is the chat model, so only the first
 * candidate is picked and the user adds the rest.
 */
import {
  MODEL_VENDOR_PREFIXES,
  bindingFromModelInfo,
  type ModelBinding,
  type ModelInfo,
} from "@pi-desktop/shared";
import { describeModelsFetchError } from "./model-fetch-error";
import type { ProviderModelsState } from "./useProviderModels";

export const RECOMMENDED_MODEL_LIMIT = 3;

/**
 * Whether a discovery answer is trustworthy enough to preselect from.
 *
 * The service's own list always is. The models.dev fallback is only when the
 * service did not refuse: a named vendor that simply has no `/models` route
 * (404) still accepted the key, but a rejected key, a timeout or a network
 * failure says nothing about whether the key works, and a preselection there
 * would make a broken service look ready to save.
 */
export function canRecommendFrom(
  discovery: Pick<ProviderModelsState, "status" | "source" | "error">,
  namedService: boolean,
): boolean {
  if (discovery.status !== "ready") return false;
  if (discovery.source === "remote") return true;
  if (discovery.source !== "catalog") return false;
  if (!discovery.error) return true;
  return namedService && describeModelsFetchError(discovery.error).kind === "notFound";
}

/**
 * Published output price, in USD per million tokens, above which a model is
 * only picked when nothing cheaper qualifies. Flagship chat models sit well
 * below it; the premium reasoning tiers a vendor ships next to them sit above,
 * and one of those must not become a new service's default by accident.
 */
export const PREMIUM_OUTPUT_COST_PER_MILLION = 100;

const NON_CHAT_MODEL_ID =
  /(embed|rerank|moderation|whisper|tts|transcri|audio|realtime|\blive\b|speech|image|dall-e|imagen|ocr|guard|deep-research|computer-use)/i;

function isCandidate(model: ModelInfo): boolean {
  if (model.status === "deprecated") return false;
  const output = model.modalities?.output;
  if (output && !output.includes("text")) return false;
  if (model.toolCall === false) return false;
  return !NON_CHAT_MODEL_ID.test(model.modelId);
}

/**
 * An aggregator addresses models as `vendor/model`. A path that names none of
 * the known vendors is a community fine-tune or a private route, which should
 * not outrank the mainstream models listed next to it.
 */
function routedThroughUnknownVendor(modelId: string): boolean {
  const segments = modelId.split("/");
  if (segments.length === 1) return false;
  return !segments
    .slice(0, -1)
    .some((segment) => MODEL_VENDOR_PREFIXES.has(segment.toLowerCase()));
}

function isUnstable(model: ModelInfo): boolean {
  return model.experimental === true || model.status === "beta" || model.status === "alpha";
}

function isPremium(model: ModelInfo): boolean {
  return (model.cost?.output ?? 0) > PREMIUM_OUTPUT_COST_PER_MILLION;
}

function publishedDate(model: ModelInfo): string {
  return model.releaseDate ?? model.lastUpdated ?? "";
}

/**
 * Keys compared in order; lower sorts first. A premium tier ranks below a
 * pre-release model: an unexpected bill is worse than an unexpected beta.
 */
function demotions(model: ModelInfo): number[] {
  return [
    routedThroughUnknownVendor(model.modelId) ? 1 : 0,
    model.toolCall === true ? 0 : 1,
    isPremium(model) ? 1 : 0,
    isUnstable(model) ? 1 : 0,
  ];
}

function compareCandidates(
  left: { model: ModelInfo; index: number },
  right: { model: ModelInfo; index: number },
): number {
  const leftKeys = demotions(left.model);
  const rightKeys = demotions(right.model);
  for (let key = 0; key < leftKeys.length; key += 1) {
    if (leftKeys[key] !== rightKeys[key]) return leftKeys[key] - rightKeys[key];
  }
  // ISO dates compare as strings; an undated model sorts after every dated one.
  const leftDate = publishedDate(left.model);
  const rightDate = publishedDate(right.model);
  if (leftDate !== rightDate) return leftDate < rightDate ? 1 : -1;
  // A vendor releases a line together; the pricier sibling is its flagship.
  const leftCost = left.model.cost?.output ?? -1;
  const rightCost = right.model.cost?.output ?? -1;
  if (leftCost !== rightCost) return rightCost - leftCost;
  return left.index - right.index;
}

/**
 * Bindings to preselect for a service whose model list just arrived, best
 * first. Empty when the list holds no chat model that can call tools.
 */
export function recommendModels(
  models: readonly ModelInfo[],
  limit = RECOMMENDED_MODEL_LIMIT,
): ModelBinding[] {
  const candidates = models
    .map((model, index) => ({ model, index }))
    .filter(({ model }) => isCandidate(model));
  if (candidates.length === 0 || limit <= 0) return [];
  if (!candidates.some(({ model }) => model.catalogSource === "models.dev")) {
    return [bindingFromModelInfo(candidates[0].model)];
  }
  const picked: ModelBinding[] = [];
  const families = new Set<string>();
  for (const { model } of [...candidates].sort(compareCandidates)) {
    const family = (model.family ?? model.modelId).toLowerCase();
    if (families.has(family)) continue;
    families.add(family);
    picked.push(bindingFromModelInfo(model));
    if (picked.length === limit) break;
  }
  return picked;
}
