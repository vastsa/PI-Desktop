/**
 * Tests for `subagent-presets`. The presets drive the Subagent editor's
 * "start from template" affordances (issue #60) and must stay in lockstep with
 * `BUILTIN_SUBAGENT_DOCUMENTS` in `agent-runtime/src/subagent-definitions.ts`
 * so the editor pre-fills the same prompt the runtime will execute.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_SUBAGENT_TOOLS } from "./subagent-definition.js";
import {
  SUBAGENT_PRESETS,
  defaultSubagentPresetTools,
  findSubagentPreset,
} from "./subagent-presets.js";

describe("SUBAGENT_PRESETS", () => {
  it("ships the four builtin roles", () => {
    const ids = SUBAGENT_PRESETS.map((preset) => preset.id);
    expect(ids).toEqual(["explorer", "code-reviewer", "test-runner", "fixer"]);
  });

  it("never duplicates a name", () => {
    const names = SUBAGENT_PRESETS.map((preset) => preset.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("declares at least one tool per preset", () => {
    for (const preset of SUBAGENT_PRESETS) {
      expect(preset.tools.length).toBeGreaterThan(0);
    }
  });

  it("writes non-empty body copy", () => {
    for (const preset of SUBAGENT_PRESETS) {
      expect(preset.body.trim().length).toBeGreaterThan(0);
    }
  });

  it("keeps maxTurns inside the published clamp", () => {
    for (const preset of SUBAGENT_PRESETS) {
      expect(preset.maxTurns).toBeGreaterThanOrEqual(0);
      expect(preset.maxTurns).toBeLessThanOrEqual(80);
    }
  });

  it("grants Edit/Write only to roles that need them", () => {
    const fixer = findSubagentPreset("fixer");
    const explorer = findSubagentPreset("explorer");
    const reviewer = findSubagentPreset("code-reviewer");
    const runner = findSubagentPreset("test-runner");
    expect(fixer?.tools).toContain("Edit");
    expect(fixer?.tools).toContain("Write");
    expect(explorer?.tools ?? []).not.toContain("Edit");
    expect(reviewer?.tools ?? []).not.toContain("Edit");
    expect(runner?.tools ?? []).not.toContain("Edit");
  });
});

describe("findSubagentPreset", () => {
  it("returns the matching preset", () => {
    expect(findSubagentPreset("explorer")?.id).toBe("explorer");
    expect(findSubagentPreset("fixer")?.id).toBe("fixer");
  });

  it("returns undefined for unknown ids", () => {
    expect(findSubagentPreset("nope")).toBeUndefined();
    expect(findSubagentPreset("")).toBeUndefined();
  });
});

describe("defaultSubagentPresetTools", () => {
  it("matches the shared default tool list", () => {
    expect(defaultSubagentPresetTools()).toEqual(DEFAULT_SUBAGENT_TOOLS);
  });
});