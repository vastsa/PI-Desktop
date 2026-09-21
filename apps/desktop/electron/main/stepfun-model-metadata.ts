import type { ModelsDevModel } from "./models-dev-catalog";

/**
 * First-party metadata while models.dev has no StepFun Step 5 record.
 * https://platform.stepfun.com/docs/zh/guides/models/step-5-preview
 * Verified 2026-09-21: /v1/models publishes max_input_tokens=1024000,
 * enable_vision_input=true and reasoning_effort_support_list=low/medium/high.
 * The documented 64k output ceiling is represented conservatively as 64000.
 * Never infer gateway capabilities from a model name or vendor label alone.
 */
export function stepfunModelSupplement(input: {
  baseUrl?: string;
  modelId: string;
}): ModelsDevModel | undefined {
  if (input.modelId !== "step-5-preview" || !input.baseUrl) return undefined;
  let endpoint: URL;
  try {
    endpoint = new URL(input.baseUrl);
  } catch {
    return undefined;
  }
  if (
    endpoint.origin !== "https://api.stepfun.com" ||
    !["/v1", "/step_plan/v1"].includes(endpoint.pathname.replace(/\/+$/, "")) ||
    endpoint.username || endpoint.password || endpoint.search || endpoint.hash
  ) return undefined;
  return {
    providerKey: "stepfun",
    providerName: "StepFun",
    providerApi: `${endpoint.origin}${endpoint.pathname.replace(/\/+$/, "")}`,
    metadataSource: "provider",
    modelId: "step-5-preview",
    displayName: "Step 5 Preview",
    reasoning: true,
    reasoningPublished: true,
    thinkingLevels: ["low", "medium", "high"],
    reasoningOptions: [{ type: "effort", values: ["low", "medium", "high"] }],
    modalities: { input: ["text", "image", "video"], output: ["text"] },
    modalitiesPublished: true,
    inputPublished: true,
    outputPublished: true,
    toolCall: true,
    structuredOutput: true,
    limit: { context: 1_024_000, input: 1_024_000, output: 64_000 },
  };
}
