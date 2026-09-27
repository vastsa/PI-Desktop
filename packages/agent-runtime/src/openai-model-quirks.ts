/**
 * GPT-6 Astra / Sol / Luna reject Chat Completions requests that combine
 * function tools with an active `reasoning_effort`. Official guidance is the
 * Responses API. Astra also rejects `reasoning.effort: "none"`, and Sol/Luna
 * only allow tools on Chat Completions when effort is `none`. Turning thinking
 * off must therefore omit the field rather than map `off` → `"none"`.
 */

const GPT6_TOOLING_MODEL_MARKERS = [
  "gpt-6-astra",
  "gpt-6-sol",
  "gpt-6-luna",
] as const;

export function isGpt6ToolingModelId(modelId: string | null | undefined): boolean {
  const id = (modelId ?? "").toLowerCase();
  return GPT6_TOOLING_MODEL_MARKERS.some((marker) => id.includes(marker));
}

/** @deprecated Use {@link isGpt6ToolingModelId}. */
export const isGpt6AstraModelId = isGpt6ToolingModelId;

/** Official OpenAI / Azure rows — leave third-party gateways alone (see #105). */
export function openAIFamilyVendorForGpt6Tooling(
  vendorKey: string | null | undefined,
): boolean {
  const vendor = vendorKey?.trim().toLowerCase() ?? "";
  return vendor === "openai" || vendor === "azure" || vendor === "azure-openai";
}

/** @deprecated Use {@link openAIFamilyVendorForGpt6Tooling}. */
export const openAIFamilyVendorForGpt6Astra = openAIFamilyVendorForGpt6Tooling;

export function gpt6ToolingRequiresResponsesApi(input: {
  modelId: string | null | undefined;
  vendorKey?: string | null;
}): boolean {
  return (
    isGpt6ToolingModelId(input.modelId) &&
    openAIFamilyVendorForGpt6Tooling(input.vendorKey)
  );
}

/** @deprecated Use {@link gpt6ToolingRequiresResponsesApi}. */
export const gpt6AstraRequiresResponsesApi = gpt6ToolingRequiresResponsesApi;

/** Null `off` so adapters omit reasoning instead of sending effort `"none"`. */
export function withGpt6ToolingThinkingOffOmitted<
  T extends { thinkingLevelMap?: Partial<Record<string, string | null>> },
>(modelId: string | null | undefined, model: T): T {
  if (!isGpt6ToolingModelId(modelId)) return model;
  return {
    ...model,
    thinkingLevelMap: { ...model.thinkingLevelMap, off: null },
  };
}

/** @deprecated Use {@link withGpt6ToolingThinkingOffOmitted}. */
export const withGpt6AstraThinkingOffOmitted = withGpt6ToolingThinkingOffOmitted;
