import { describe, expect, it } from "vitest";
import {
  gpt6ToolingRequiresResponsesApi,
  isGpt6ToolingModelId,
  withGpt6ToolingThinkingOffOmitted,
} from "./openai-model-quirks.js";

describe("gpt-6 tooling wire quirks", () => {
  it.each(["gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "openai/gpt-6-sol"] as const)(
    "recognizes %s",
    (modelId) => {
      expect(isGpt6ToolingModelId(modelId)).toBe(true);
    },
  );

  it("ignores unrelated gpt-6-looking ids", () => {
    expect(isGpt6ToolingModelId("gpt-6-mini")).toBe(false);
    expect(isGpt6ToolingModelId("gpt-5.6-sol")).toBe(false);
  });

  it("requires Responses only on official OpenAI-family vendors", () => {
    expect(
      gpt6ToolingRequiresResponsesApi({ modelId: "gpt-6-sol", vendorKey: "openai" }),
    ).toBe(true);
    expect(
      gpt6ToolingRequiresResponsesApi({ modelId: "gpt-6-luna", vendorKey: "azure" }),
    ).toBe(true);
    expect(
      gpt6ToolingRequiresResponsesApi({
        modelId: "gpt-6-astra",
        vendorKey: "llmgateway",
      }),
    ).toBe(false);
  });

  it("nulls thinkingLevelMap.off so adapters omit reasoning_effort", () => {
    for (const modelId of ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna"] as const) {
      expect(
        withGpt6ToolingThinkingOffOmitted(modelId, {
          thinkingLevelMap: { off: "none", high: "high" },
        }).thinkingLevelMap,
      ).toEqual({ off: null, high: "high" });
    }
    expect(
      withGpt6ToolingThinkingOffOmitted("gpt-5.6-sol", {
        thinkingLevelMap: { off: "none" },
      }).thinkingLevelMap,
    ).toEqual({ off: "none" });
  });
});
