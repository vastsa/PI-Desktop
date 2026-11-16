import { describe, expect, it } from "vitest";
import type { ModeDefinition, ModeTurnContext } from "@pi-desktop/shared";
import { builtinModeDefinition, loadModeDefinitions } from "../mode-definitions.js";
import { modePolicyLevel, offersAgentModeOnlyTools, ownModeDefinition } from "./mode-policy.js";

function builtin(id: "agent" | "plan" | "goal"): ModeDefinition {
  const definition = builtinModeDefinition(id);
  if (!definition) throw new Error(`builtin ${id} missing`);
  return definition;
}

/** A user mode whose definition permission and stage permissions differ. */
const STAGED = loadModeDefinitions({
  userDocuments: [{
    dirName: "review-fix",
    filePath: "/home/user/.pi/modes/review-fix/mode.md",
    templates: {},
    source: `---
permission: contract
stages:
  review:
    permission: contract
    next: fix
  fix:
    permission: agent
---
Review, then fix.
`,
  }],
}).definitions.find((definition) => definition.id === "review-fix");

function staged(): ModeDefinition {
  if (!STAGED) throw new Error("staged fixture failed to load");
  return STAGED;
}

function turn(stageId: string): ModeTurnContext {
  return { runId: "run-1", stageId, origin: "user", enteredStage: true, input: "x", artifactPaths: {} };
}

describe("modePolicyLevel", () => {
  it("uses the stage permission while a run turn is present", () => {
    expect(modePolicyLevel({ modeId: "review-fix", definition: staged(), modeTurn: turn("fix") })).toBe("agent");
    expect(modePolicyLevel({ modeId: "review-fix", definition: staged(), modeTurn: turn("review") })).toBe("contract");
    // Goal's definition is agent-level; its only stage is agent-level too.
    expect(modePolicyLevel({ modeId: "goal", definition: builtin("goal"), modeTurn: turn("work") })).toBe("agent");
  });

  it("fails closed when the run turn names a stage the definition lacks", () => {
    expect(modePolicyLevel({ modeId: "review-fix", definition: staged(), modeTurn: turn("deploy") })).toBe("contract");
  });

  it("uses the definition permission without a run turn", () => {
    expect(modePolicyLevel({ modeId: "review-fix", definition: staged() })).toBe("contract");
    expect(modePolicyLevel({ modeId: "goal", definition: builtin("goal") })).toBe("agent");
    expect(modePolicyLevel({ modeId: "plan", definition: builtin("plan") })).toBe("contract");
    expect(modePolicyLevel({ modeId: "agent", definition: builtin("agent") })).toBe("agent");
  });

  it("maps builtins without a definition: agent → agent, plan and goal → contract", () => {
    expect(modePolicyLevel({ modeId: "agent" })).toBe("agent");
    expect(modePolicyLevel({ modeId: "plan" })).toBe("contract");
    expect(modePolicyLevel({ modeId: "goal" })).toBe("contract");
  });

  it("fails closed to contract for an unknown id without a definition, even with a run turn", () => {
    expect(modePolicyLevel({ modeId: "reviewer" })).toBe("contract");
    expect(modePolicyLevel({ modeId: "reviewer", modeTurn: turn("fix") })).toBe("contract");
  });

  it("ignores a definition that belongs to another mode", () => {
    // A goal snapshot must not grant its agent permission to Plan.
    expect(ownModeDefinition("plan", builtin("goal"))).toBeUndefined();
    expect(modePolicyLevel({ modeId: "plan", definition: builtin("goal"), modeTurn: turn("work") })).toBe("contract");
    expect(modePolicyLevel({ modeId: "reviewer", definition: staged(), modeTurn: turn("fix") })).toBe("contract");
  });
});

describe("offersAgentModeOnlyTools", () => {
  it("is limited to the builtin Agent mode id", () => {
    expect(offersAgentModeOnlyTools("agent")).toBe(true);
    for (const id of ["plan", "goal", "review-fix", "builder"]) expect(offersAgentModeOnlyTools(id)).toBe(false);
  });
});
