import { describe, expect, it } from "vitest";
import {
  MAX_PROJECT_INSTRUCTIONS_BYTES,
  parseProjectAgentSettings,
  parseProjectCapabilities,
  projectCapabilityAllowed,
} from "./project-capabilities.js";

describe("project capability selections", () => {
  it("distinguishes inherited, empty and explicitly selected catalogs", () => {
    expect(parseProjectCapabilities(undefined)).toBeUndefined();
    expect(parseProjectCapabilities({})).toEqual({});
    expect(parseProjectCapabilities({ skillIds: [] })).toEqual({ skillIds: [] });
    expect(projectCapabilityAllowed(undefined, "future/skill")).toBe(true);
    expect(projectCapabilityAllowed([], "future/skill")).toBe(false);
    expect(projectCapabilityAllowed(["future/skill"], "future/skill")).toBe(true);
    expect(projectCapabilityAllowed(["future/skill"], "FUTURE/skill")).toBe(false);
  });

  it("deduplicates exact IDs while retaining unavailable selections", () => {
    expect(parseProjectCapabilities({ skillIds: ["plugin/one", "plugin/one", "PLUGIN/one"], mcpServerIds: ["missing"] }))
      .toEqual({ skillIds: ["plugin/one", "PLUGIN/one"], mcpServerIds: ["missing"] });
  });

  it.each([null, [], "all", { unknown: [] }, { skillIds: null }, { skillIds: [""] },
    { skillIds: ["  "] }, { skillIds: [7] }, { skillIds: ["bad\u0000id"] },
    { mcpServerIds: ["bad\u0085id"] }, { skillIds: ["界".repeat(171)] },
    { mcpServerIds: Array.from({ length: 513 }, () => "same") },
  ])("rejects invalid selections without widening access: %j", (value) => {
    expect(() => parseProjectCapabilities(value)).toThrow();
  });

  it("validates Markdown using UTF-8 bytes and preserves omitted updates", () => {
    expect(parseProjectAgentSettings({})).toEqual({});
    expect(parseProjectAgentSettings({ capabilities: {}, instructions: "" })).toEqual({ capabilities: {}, instructions: "" });
    expect(parseProjectAgentSettings({ instructions: "a".repeat(MAX_PROJECT_INSTRUCTIONS_BYTES) }).instructions).toHaveLength(MAX_PROJECT_INSTRUCTIONS_BYTES);
    expect(() => parseProjectAgentSettings({ instructions: "界".repeat(10_923) })).toThrow(/UTF-8/);
    expect(() => parseProjectAgentSettings({ instructions: null })).toThrow();
  });
});
