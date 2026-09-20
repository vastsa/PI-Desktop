import { describe, expect, it } from "vitest";
import { agentThinkingLevel, clampThinkingLevel, omitThinkingModel } from "./thinking-level.js";

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
