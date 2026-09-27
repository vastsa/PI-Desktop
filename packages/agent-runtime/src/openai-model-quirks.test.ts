import { describe, expect, it } from "vitest";
import {
  gpt6AstraRequiresResponsesApi,
  isGpt6AstraModelId,
  withGpt6AstraThinkingOffOmitted,
} from "./openai-model-quirks.js";

describe("gpt-6-astra wire quirks", () => {
  it("recognizes gpt-6-astra ids", () => {
    expect(isGpt6AstraModelId("gpt-6-astra")).toBe(true);
    expect(isGpt6AstraModelId("openai/gpt-6-astra")).toBe(true);
    expect(isGpt6AstraModelId("gpt-6-sol")).toBe(false);
  });

  it("requires Responses only on official OpenAI-family vendors", () => {
    expect(
      gpt6AstraRequiresResponsesApi({ modelId: "gpt-6-astra", vendorKey: "openai" }),
    ).toBe(true);
    expect(
      gpt6AstraRequiresResponsesApi({ modelId: "gpt-6-astra", vendorKey: "azure" }),
    ).toBe(true);
    expect(
      gpt6AstraRequiresResponsesApi({
        modelId: "gpt-6-astra",
        vendorKey: "llmgateway",
      }),
    ).toBe(false);
    expect(
      gpt6AstraRequiresResponsesApi({ modelId: "gpt-6-sol", vendorKey: "openai" }),
    ).toBe(false);
  });

  it("nulls thinkingLevelMap.off so adapters omit reasoning_effort", () => {
    expect(
      withGpt6AstraThinkingOffOmitted("gpt-6-astra", {
        thinkingLevelMap: { off: "none", high: "high" },
      }).thinkingLevelMap,
    ).toEqual({ off: null, high: "high" });
    expect(
      withGpt6AstraThinkingOffOmitted("gpt-6-sol", {
        thinkingLevelMap: { off: "none" },
      }).thinkingLevelMap,
    ).toEqual({ off: "none" });
  });
});
