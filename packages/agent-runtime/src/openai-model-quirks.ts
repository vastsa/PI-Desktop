/**
 * OpenAI GPT-6 Astra rejects Chat Completions requests that combine function
 * tools with `reasoning_effort`. Official guidance is the Responses API.
 * Astra also rejects `reasoning.effort: "none"`, so turning thinking off must
 * omit the field entirely rather than map `off` → `"none"`.
 */

export function isGpt6AstraModelId(modelId: string | null | undefined): boolean {
  return (modelId ?? "").toLowerCase().includes("gpt-6-astra");
}

/** Official OpenAI / Azure rows — leave third-party gateways alone (see #105). */
export function openAIFamilyVendorForGpt6Astra(
  vendorKey: string | null | undefined,
): boolean {
  const vendor = vendorKey?.trim().toLowerCase() ?? "";
  return vendor === "openai" || vendor === "azure" || vendor === "azure-openai";
}

export function gpt6AstraRequiresResponsesApi(input: {
  modelId: string | null | undefined;
  vendorKey?: string | null;
}): boolean {
  return (
    isGpt6AstraModelId(input.modelId) &&
    openAIFamilyVendorForGpt6Astra(input.vendorKey)
  );
}

/** Null `off` so adapters omit reasoning instead of sending effort `"none"`. */
export function withGpt6AstraThinkingOffOmitted<
  T extends { thinkingLevelMap?: Partial<Record<string, string | null>> },
>(modelId: string | null | undefined, model: T): T {
  if (!isGpt6AstraModelId(modelId)) return model;
  return {
    ...model,
    thinkingLevelMap: { ...model.thinkingLevelMap, off: null },
  };
}
