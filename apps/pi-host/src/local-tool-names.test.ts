import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SKILL_TOOL_NAME } from "@pi-desktop/agent-runtime";
import { CANONICAL_TOOL_NAMES } from "@pi-desktop/shared";

/**
 * The headless host serves the skill bridge itself, so its registration name
 * has to be the name the runtime asks for. It used to be a hard-coded `"Skill"`
 * literal, which the rename (D620) would have silently broken: the model calls
 * `skill` and finds no local tool, and no test covered the registration name.
 */
describe("pi-host local tool registration names", () => {
  const source = readFileSync(new URL("./app.ts", import.meta.url), "utf8");

  it("registers the skill bridge under the canonical skill name", () => {
    expect(SKILL_TOOL_NAME).toBe("skill");
    expect([...CANONICAL_TOOL_NAMES]).toContain(SKILL_TOOL_NAME);
    expect(source).toContain("setLocalTool(SKILL_TOOL_NAME");
  });

  it("never registers a local tool under a hard-coded name", () => {
    expect(source).not.toMatch(/setLocalTool\(\s*["'`]/);
  });
});
