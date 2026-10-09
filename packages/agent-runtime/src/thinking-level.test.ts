import { describe, expect, it } from "vitest";
import { clampThinkingLevel as clampPiThinkingLevel } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { agentThinkingLevel, clampThinkingLevel, omitThinkingModel, requestThinkingLevel } from "./thinking-level.js";

describe("simple request thinking normalization", () => {
  const providers = builtinProviders();

  for (const providerId of ["openai", "azure", "openai-codex"]) {
    it(`normalizes unsupported off using the published ${providerId} model`, () => {
      const model = providers.find((provider) => provider.id === providerId)
        ?.getModels().find((entry) => entry.id === "gpt-6.1-sol");
      expect(model).toBeDefined();
      if (!model) throw new Error(`Missing ${providerId} GPT-6.1 Sol catalog entry`);
      const effective = clampPiThinkingLevel(model, "off");
      expect(effective).not.toBe("off");
      expect(requestThinkingLevel(model, "off")).toBe(effective);
    });
  }

  it("encodes supported off as absent reasoning without changing Agent bookkeeping", () => {
    const model = providers.find((provider) => provider.id === "openai")
      ?.getModels().find((entry) => !entry.reasoning);
    expect(model).toBeDefined();
    if (!model) throw new Error("Missing non-reasoning catalog model");
    expect(requestThinkingLevel(model, "off")).toBeUndefined();
    expect(requestThinkingLevel(model, "omit")).toBeUndefined();
    expect(agentThinkingLevel("off")).toBe("off");
  });
});

const reasoning = {
  supportsReasoning: true,
  supportedThinkingLevels: ["off", "low", "high"] as const,
};

describe("session thinking omit", () => {
  it("keeps omit on a reasoning model and maps bookkeeping to off", () => {
    expect(clampThinkingLevel(reasoning, "omit")).toBe("omit");
    expect(agentThinkingLevel("omit")).toBe("off");
    expect(agentThinkingLevel("high")).toBe("high");
  });

  it("forces omit to off when the model cannot reason", () => {
    expect(clampThinkingLevel({ supportsReasoning: false, supportedThinkingLevels: ["off"] }, "omit")).toBe("off");
  });

  it("nulls the off mapping so adapters send no thinking field", () => {
    expect(omitThinkingModel({ thinkingLevelMap: { off: "none", high: "high" } }).thinkingLevelMap).toEqual({
      off: null,
      high: "high",
    });
  });
});
