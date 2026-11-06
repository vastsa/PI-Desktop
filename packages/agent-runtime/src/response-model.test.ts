import { describe, expect, it } from "vitest";
import { concreteResponseModel } from "./response-model.js";

describe("concreteResponseModel", () => {
  it.each([
    ["openrouter/auto", "anthropic/claude-sonnet-4.5", "anthropic/claude-sonnet-4.5"],
    ["claude-opus-4-1", "claude-sonnet-4-5", "claude-sonnet-4-5"],
    ["virtual-fast", "  vendor/model-a  ", "vendor/model-a"],
  ])("keeps a different served model (%s -> %s)", (requested, served, expected) => {
    expect(concreteResponseModel({ responseModel: served }, requested)).toBe(expected);
  });

  it.each([
    ["gpt-4o", "gpt-4o"],
    ["gpt-4o", "gpt-4o-2024-08-06"],
    ["claude-sonnet-4-5", "claude-sonnet-4-5-20250929"],
    ["m", ""],
    ["m", "x".repeat(201)],
    ["m", "evil\u001b]8;;http://x\u0007"],
    ["m", "a\u0085b"],
  ])("drops a redundant or unsafe value (%s / %j)", (requested, served) => {
    expect(concreteResponseModel({ responseModel: served }, requested)).toBeUndefined();
  });

  it("ignores a missing or non-string value", () => {
    expect(concreteResponseModel({}, "m")).toBeUndefined();
    expect(concreteResponseModel({ responseModel: 42 }, "m")).toBeUndefined();
  });
});
