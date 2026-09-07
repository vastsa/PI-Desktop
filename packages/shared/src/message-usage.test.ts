import { describe, expect, it } from "vitest";
import { addUsage, type MessageUsage } from "./types.js";

const parent: MessageUsage = {
  inputTokens: 200,
  outputTokens: 80,
  totalTokens: 280,
};

const subagent: MessageUsage = {
  inputTokens: 100,
  outputTokens: 50,
  cacheReadTokens: 10,
  totalTokens: 160,
};

describe("addUsage", () => {
  it("returns the other side when one argument is missing", () => {
    expect(addUsage(undefined, parent)).toEqual(parent);
    expect(addUsage(parent, undefined)).toEqual(parent);
    expect(addUsage(undefined, undefined)).toBeUndefined();
  });

  it("sums required fields and optional cache/reasoning when either side has them", () => {
    expect(addUsage(parent, subagent)).toEqual({
      inputTokens: 300,
      outputTokens: 130,
      cacheReadTokens: 10,
      totalTokens: 440,
    });
  });
});
