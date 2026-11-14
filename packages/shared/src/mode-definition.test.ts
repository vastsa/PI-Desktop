import { describe, expect, it } from "vitest";
import {
  MODE_LIMITS,
  isModeId,
  missingModeHeadings,
  modeArtifactPaths,
  modePermissionFor,
  substituteModeVariables,
} from "./mode-definition.js";
import { parseModeDefinition } from "./mode-definition-parse.js";

function parse(frontmatter: unknown, body = "Body.", templates: Record<string, string> = {}) {
  return parseModeDefinition(frontmatter, body, { source: "user", fallbackName: "feature", templates });
}

function errors(frontmatter: unknown, body?: string): string[] {
  const result = parse(frontmatter, body);
  return result.ok ? [] : result.errors;
}

const feature = {
  name: "feature",
  label: "Feature",
  description: "Spec, implement and verify one feature",
  artifacts: {
    spec: { path: ".pi/runs/{{run.id}}/spec.md", template: "templates/spec.md", requiredHeadings: ["Goal", "Acceptance criteria"] },
  },
  budget: { maxTurns: 30 },
  stages: {
    design: {
      permission: "contract",
      prompt: "Write the spec for {{run.input}}.",
      exit: [{ require: "artifact:spec" }, { ask: "user" }],
      next: "implement",
    },
    implement: {
      permission: "agent",
      loop: true,
      prompt: "Implement the approved spec.",
      on: { compaction: [{ inject: "artifact:spec" }] },
      exit: [{ run: "pnpm test", onFail: { retries: 3 } }],
    },
  },
};

describe("parseModeDefinition", () => {
  it("reads a simple mode with defaults", () => {
    const result = parse({ name: "review", permission: "contract" }, "Review only.");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.definition).toMatchObject({
      id: "review",
      label: "review",
      permission: "contract",
      prompt: "Review only.",
      stages: [],
      artifacts: [],
      returnTo: "agent",
    });
  });

  it("falls back to the directory name and agent permission", () => {
    const result = parse(undefined, "Hello");
    expect(result.ok && result.definition.id).toBe("feature");
    expect(result.ok && result.definition.permission).toBe("agent");
  });

  it("reads the ADR staged example", () => {
    const result = parse(feature, "Follow the repository conventions.", { "templates/spec.md": "# Goal\n\n{{run.input}}\n\n# Acceptance criteria\n" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { definition } = result;
    expect(definition.stages.map((stage) => stage.id)).toEqual(["design", "implement"]);
    expect(definition.stages[0]).toMatchObject({ permission: "contract", loop: false, next: "implement" });
    expect(definition.stages[0].exit).toEqual([
      { kind: "require", artifact: "spec", onFail: { retries: MODE_LIMITS.defaultRetries } },
      { kind: "ask" },
    ]);
    expect(definition.stages[1].exit).toEqual([
      { kind: "run", command: "pnpm test", timeoutMinutes: MODE_LIMITS.defaultRunTimeoutMinutes, onFail: { retries: 3 } },
    ]);
    expect(definition.stages[1].onCompaction).toEqual([{ kind: "artifact", artifact: "spec" }]);
    expect(definition.artifacts[0].template).toContain("# Goal");
    expect(definition.budget).toEqual({ maxTurns: 30, maxTokens: null });
    expect(modePermissionFor(definition, "design")).toBe("contract");
    expect(modePermissionFor(definition, "implement")).toBe("agent");
    expect(modePermissionFor(definition)).toBe("agent");
  });

  it("inherits the mode permission in stages", () => {
    const result = parse({ permission: "contract", stages: { only: {} } });
    expect(result.ok && result.definition.stages[0].permission).toBe("contract");
  });

  it("rejects unknown keys at every level", () => {
    expect(errors({ tools: ["Read"] })).toContain("tools: unknown key");
    expect(errors({ stages: { a: { model: "x" } } })).toContain("stages.a.model: unknown key");
    expect(errors({ stages: { a: { on: { after_tool: [] } } } })[0]).toMatch(/unknown event/);
    expect(errors({ stages: { a: { exit: [{ script: "x.js" }] } } })[0]).toMatch(/exactly one of/);
    expect(errors({ stages: { a: { exit: [{ run: "x", onFail: { prompt: "y" } }] } } })).toContain("stages.a.exit[0].onFail.prompt: unknown key");
  });

  it("rejects staged-only keys without stages", () => {
    expect(errors({ budget: { maxTurns: 3 } })).toContain("budget: only valid together with stages");
  });

  it("rejects invalid permission and ids", () => {
    expect(errors({ permission: "auto" })[0]).toMatch(/agent" or "contract/);
    expect(errors({ name: "Bad Name" })[0]).toMatch(/invalid/);
    expect(errors({ stages: { "1x": {} } })[0]).toMatch(/invalid id/);
    expect(isModeId("my-mode")).toBe(true);
    expect(isModeId("../x")).toBe(false);
  });

  it("rejects unknown references", () => {
    expect(errors({ stages: { a: { next: "b" } } })).toContain('stages.a.next: unknown stage "b"');
    expect(errors({ stages: { a: { exit: [{ require: "artifact:spec" }] } } })[0]).toMatch(/unknown artifact "spec"/);
    expect(errors({ stages: { a: { exit: [{ run: "x", onFail: { goto: "z" } }] } } })[0]).toMatch(/unknown stage "z"/);
    expect(errors({ stages: { a: { prompt: "{{inputs.goal}}" } } })[0]).toMatch(/unknown variable/);
  });

  it("requires ask to be the last gate", () => {
    expect(errors({ artifacts: { p: { path: "p.md" } }, stages: { a: { exit: [{ ask: "user" }, { require: "artifact:p" }] } } }))
      .toContain("stages.a.exit: ask must be the last gate");
  });

  it("rejects artifact paths outside the workspace", () => {
    for (const path of ["/etc/x", "../x.md", "a/../../x.md", "~/x", "C:/x", "a\\b.md", "dir/"]) {
      expect(errors({ artifacts: { p: { path } }, stages: { a: {} } }).length, path).toBeGreaterThan(0);
    }
  });

  it("rejects a missing template file", () => {
    expect(errors({ artifacts: { p: { path: "p.md", template: "templates/none.md" } }, stages: { a: {} } })[0]).toMatch(/not found/);
  });

  it("never substitutes run input into commands", () => {
    expect(errors({ stages: { a: { exit: [{ run: "echo {{run.input}}" }] } } })[0]).toMatch(/not allowed here/);
  });

  it("rejects cycles that never wait", () => {
    const result = errors({
      artifacts: { p: { path: "p.md" } },
      stages: {
        a: { next: "b" },
        b: { exit: [{ require: "artifact:p", onFail: { goto: "a" } }] },
      },
    });
    expect(result.some((error) => error.includes("cycle"))).toBe(true);
    expect(errors({
      stages: { a: { next: "b" }, b: { loop: true, exit: [{ run: "x", onFail: { goto: "a" } }] } },
    })).toEqual([]);
  });

  it("enforces limits", () => {
    const stages = Object.fromEntries(Array.from({ length: MODE_LIMITS.stages + 1 }, (_, index) => [`s${index}`, {}]));
    expect(errors({ stages }).some((error) => error.includes("at most"))).toBe(true);
    expect(errors({ stages: { a: { exit: [{ run: "x", onFail: { retries: 11 } }] } } })[0]).toMatch(/0 to 10/);
    expect(errors({ stages: { a: { exit: [{ run: { command: "x", timeoutMinutes: 61 } }] } } })[0]).toMatch(/1 to 60/);
    expect(errors({ stages: { a: {} }, budget: { maxTokens: 10 } })[0]).toMatch(/budget.maxTokens/);
  });

  it("warns about unreachable stages", () => {
    const result = parse({ stages: { a: {}, b: {} } });
    expect(result.ok).toBe(true);
    expect(result.warnings).toContain("stages.b: unreachable from the first stage");
  });

  it("rejects returnTo pointing at itself", () => {
    expect(errors({ name: "feature", returnTo: "feature", stages: { a: {} } })).toContain("returnTo: must name another mode");
  });
});

describe("mode helpers", () => {
  it("substitutes known variables only", () => {
    expect(substituteModeVariables("{{run.id}} {{ run.input }} {{artifacts.spec.path}} {{x}}", {
      runId: "r1",
      runInput: "build it",
      artifactPaths: { spec: ".pi/runs/r1/spec.md" },
    })).toBe("r1 build it .pi/runs/r1/spec.md {{x}}");
  });

  it("resolves artifact paths per run", () => {
    const result = parse(feature, "", { "templates/spec.md": "" });
    expect(result.ok && modeArtifactPaths(result.definition, "abc")).toEqual({ spec: ".pi/runs/abc/spec.md" });
  });

  it("finds missing headings outside code fences", () => {
    const markdown = "# Goal\ntext\n```\n## Evidence\n```\n## acceptance criteria ##\n";
    expect(missingModeHeadings(markdown, ["Goal", "Acceptance criteria", "Evidence"])).toEqual(["Evidence"]);
  });
});
