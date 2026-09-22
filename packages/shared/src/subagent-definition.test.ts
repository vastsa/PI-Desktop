import { describe, expect, it } from "vitest";
import {
  DEFAULT_SUBAGENT_IDLE_TIMEOUT_SECONDS,
  DEFAULT_SUBAGENT_MAX_DURATION_SECONDS,
  DEFAULT_SUBAGENT_TOOLS,
  MAX_SUBAGENT_DEFINITIONS,
  MAX_SUBAGENT_MAX_TOKENS,
  SUBAGENT_ASSIGNABLE_TOOLS,
  SUBAGENT_INHERIT_DENY_TOOLS,
  mergeSubagentDefinitions,
  normalizeSubagentName,
  parseSubagentDefinition,
  resolveSubagentToolNames,
  subagentCanMutate,
  subagentPinnedProviders,
  subagentToolsLabel,
  type SubagentDefinition,
} from "./subagent-definition.js";

function parse(raw: string, fallbackName = "reviewer") {
  return parseSubagentDefinition(raw, { source: "user", fallbackName });
}

function definition(
  overrides: Partial<SubagentDefinition> = {},
): SubagentDefinition {
  return {
    name: "reviewer",
    description: "Reviews a diff.",
    tools: ["Read"],
    prompt: "Review it.",
    source: "user",
    ...overrides,
  };
}

describe("parseSubagentDefinition", () => {
  it("reads the document a project would actually write", () => {
    const result = parse(`---
name: code-reviewer
description: Reviews changed files for correctness bugs.
tools: Read, Grep, Glob
model: anthropic/claude-opus-5
thinkingLevel: high
---

Review the diff and report only defects you can point at a line for.
`);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.definition).toEqual({
      name: "code-reviewer",
      description: "Reviews changed files for correctness bugs.",
      // Written with the pre-rename spellings: the parser normalizes (D621).
      tools: ["read", "grep", "glob"],
      model: { providerId: "anthropic", modelId: "claude-opus-5" },
      thinkingLevel: "high",
      idleTimeoutSeconds: DEFAULT_SUBAGENT_IDLE_TIMEOUT_SECONDS,
      maxDurationSeconds: DEFAULT_SUBAGENT_MAX_DURATION_SECONDS,
      prompt:
        "Review the diff and report only defects you can point at a line for.",
      source: "user",
    });
    expect(result.warnings).toEqual([]);
  });

  it("preserves the no-pass thinking selection", () => {
    const result = parse(`---
description: Uses the provider default.
thinkingLevel: omit
---
Leave the provider's thinking default unchanged.`);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.definition.thinkingLevel).toBe("omit");
    expect(result.warnings).toEqual([]);
  });

  it("is read-only when the document says nothing about tools", () => {
    const result = parse(`---
description: Explains a subsystem.
---
Explain it.`);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.definition.tools).toEqual([...DEFAULT_SUBAGENT_TOOLS]);
    expect(subagentCanMutate(result.definition)).toBe(false);
    expect(result.definition.name).toBe("reviewer");
    expect(result.definition.idleTimeoutSeconds).toBe(
      DEFAULT_SUBAGENT_IDLE_TIMEOUT_SECONDS,
    );
    expect(result.definition.maxDurationSeconds).toBe(
      DEFAULT_SUBAGENT_MAX_DURATION_SECONDS,
    );
    expect(result.definition.permission).toBeUndefined();
  });

  it("parses a declared permission scope and defaults to inherit", () => {
    const scoped = parseSubagentDefinition(
      `---
description: Writes a feature.
tools: [Read, Edit, Write]
permission: accept-edits
---
Implement it.`,
      { source: "user", fallbackName: "fixer" },
    );
    expect(scoped.ok).toBe(true);
    if (!scoped.ok) return;
    expect(scoped.definition.permission).toBe("accept-edits");
    expect(scoped.warnings).toEqual([]);

    const inherited = parse(`---
description: Explains a subsystem.
permission: inherit
---
Explain it.`);
    expect(inherited.ok).toBe(true);
    if (!inherited.ok) return;
    expect(inherited.definition.permission).toBeUndefined();
  });

  it("accepts a permission scope declared by a global user document", () => {
    for (const declared of ["auto", "accept-edits", "ask"]) {
      const result = parse(`---
description: Writes a feature.
tools: [Read, Edit, Write]
permission: ${declared}
---
Implement it.`);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.definition.permission).toBe(declared);
      expect(result.warnings).toEqual([]);
    }

    const inherited = parse(`---
description: Explains a subsystem.
permission: inherit
---
Explain it.`);
    expect(inherited.ok).toBe(true);
    if (!inherited.ok) return;
    expect(inherited.definition.permission).toBeUndefined();
    expect(inherited.warnings).toEqual([]);
  });

  it("warns on an unknown permission scope", () => {
    const result = parse(`---
description: Explains a subsystem.
permission: everything
---
Explain it.`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.definition.permission).toBeUndefined();
    expect(result.warnings.join("\n")).toContain(
      "ignoring unknown permission",
    );
  });

  it("takes mutation rights only when they are declared", () => {
    const result = parse(`---
description: Applies a mechanical rename.
tools:
  - Read
  - Edit
  - Write
---
Rename it.`);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.definition.tools).toEqual(["read", "edit", "write"]);
    expect(subagentCanMutate(result.definition)).toBe(true);
  });

  // Backward compatibility is part of the contract (D621): a document saved
  // before the wire names moved to lowercase keeps granting exactly what it
  // granted, without the user editing the file.
  it("accepts a document written with the pre-rename tool names", () => {
    const legacy = parse(`---
description: Reviews a diff.
tools: [Read, Glob, Grep]
---
Review it.`);

    expect(legacy.ok).toBe(true);
    if (!legacy.ok) return;
    expect(legacy.definition.tools).toEqual(["read", "glob", "grep"]);
    expect(legacy.warnings).toEqual([]);

    const legacyMutating = parse(`---
description: Applies a rename.
tools: [Read, Bash]
---
Rename it.`);

    expect(legacyMutating.ok).toBe(true);
    if (!legacyMutating.ok) return;
    expect(legacyMutating.definition.tools).toEqual(["read", "bash"]);
    expect(subagentCanMutate(legacyMutating.definition)).toBe(true);
  });

  it("expands `*` to every assignable tool", () => {
    const result = parse(`---
description: Does everything.
tools: "*"
---
Go.`);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.definition.tools).toContain("bash");
    expect(result.definition.tools).toContain("write");
    // Plugin, skill and mode tools stay out of a delegate's reach.
    expect(result.definition.tools).not.toContain("task");
    expect(result.definition.tools).not.toContain("tool_search");
    expect(result.definition.tools).not.toContain("A2A");
    expect(result.definition.tools).not.toContain("Peer");
  });

  it("drops unknown tools with a warning instead of failing", () => {
    const result = parse(`---
description: Reads code.
tools: [Read, Teleport, A2A, Peer]
---
Read it.`);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.definition.tools).toEqual(["read"]);
    expect(result.warnings).toEqual([
      'ignoring unknown tool "Teleport"',
      'ignoring unknown tool "A2A"',
      'ignoring unknown tool "Peer"',
    ]);
  });

  it("rejects a tools list where nothing survives", () => {
    const result = parse(`---
description: Reads code.
tools: [Teleport]
---
Read it.`);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContain("`tools` lists no usable tool");
  });

  it("accepts the explicit provider spelling and keeps slashes in model ids", () => {
    const explicit = parse(`---
description: Reads code.
provider: openrouter
model: anthropic/claude-opus-5
---
Read it.`);
    expect(explicit.ok).toBe(true);
    if (explicit.ok) {
      expect(explicit.definition.model).toEqual({
        providerId: "openrouter",
        modelId: "anthropic/claude-opus-5",
      });
    }

    const compact = parse(`---
description: Reads code.
model: openrouter/anthropic/claude-opus-5
---
Read it.`);
    expect(compact.ok).toBe(true);
    if (compact.ok) {
      expect(compact.definition.model).toEqual({
        providerId: "openrouter",
        modelId: "anthropic/claude-opus-5",
      });
    }
  });

  it("fails on a model pin it cannot resolve to a provider", () => {
    const bare = parse(`---
description: Reads code.
model: claude-opus-5
---
Read it.`);
    expect(bare.ok).toBe(false);

    const orphanProvider = parse(`---
description: Reads code.
provider: anthropic
---
Read it.`);
    expect(orphanProvider.ok).toBe(false);
    if (!orphanProvider.ok) {
      expect(orphanProvider.errors).toContain(
        "`provider` given without `model`",
      );
    }
  });

  it("requires a description and a body", () => {
    const noDescription = parse(`---
name: reviewer
---
Review it.`);
    expect(noDescription.ok).toBe(false);
    if (!noDescription.ok) {
      expect(noDescription.errors).toContain("missing `description`");
    }

    const noBody = parse(`---
description: Reviews a diff.
---
`);
    expect(noBody.ok).toBe(false);
    if (!noBody.ok) {
      expect(noBody.errors).toContain(
        "document body is empty (nothing to instruct)",
      );
    }
  });

  it("clamps timeout overrides", () => {
    const timeouts = parse(`---
description: Reads code.
idle-timeout: 5
max-duration: 50000
---
Read it.`);
    expect(timeouts.ok).toBe(true);
    if (timeouts.ok) {
      expect(timeouts.definition.idleTimeoutSeconds).toBe(10);
      expect(timeouts.definition.maxDurationSeconds).toBe(21_600);
      expect(timeouts.warnings).toEqual([
        "clamping `idle-timeout` 5 to 10",
        "clamping `max-duration` 50000 to 21600",
      ]);
    }

    const invalidTimeouts = parse(`---
description: Reads code.
idle-timeout: never
max-duration: 1.5h
---
Read it.`);
    expect(invalidTimeouts.ok).toBe(true);
    if (invalidTimeouts.ok) {
      expect(invalidTimeouts.definition.idleTimeoutSeconds).toBe(
        DEFAULT_SUBAGENT_IDLE_TIMEOUT_SECONDS,
      );
      expect(invalidTimeouts.definition.maxDurationSeconds).toBe(
        DEFAULT_SUBAGENT_MAX_DURATION_SECONDS,
      );
      expect(invalidTimeouts.warnings).toEqual([
        `ignoring invalid \`idle-timeout\` "never" (using ${DEFAULT_SUBAGENT_IDLE_TIMEOUT_SECONDS})`,
        `ignoring invalid \`max-duration\` "1.5h" (using ${DEFAULT_SUBAGENT_MAX_DURATION_SECONDS})`,
      ]);
    }
  });

  it("ignores legacy maxTurns frontmatter without failing or warning", () => {
    // ADR 0253: the turn cap is gone, so `maxTurns` is an unrecognized key
    // like any other. A document that still declares one keeps loading.
    for (const key of ["maxTurns", "max-turns", "max_turns"]) {
      const result = parse(`---
description: Reads code.
${key}: 12
---
Read it.`);

      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect("maxTurns" in result.definition).toBe(false);
      // An unknown key is ignored silently: no warning may mention it.
      expect(
        result.warnings.filter((warning) => /maxTurns|turn/i.test(warning)),
      ).toEqual([]);
    }
  });

  it("reads a declared output cap and keeps the loose frontmatter keys", () => {
    for (const key of ["maxTokens", "max-tokens", "max_tokens"]) {
      const result = parse(`---
description: Reads code.
${key}: 16000
---
Read it.`);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.definition.maxTokens).toBe(16_000);
        expect(result.warnings).toEqual([]);
      }
    }
  });

  it("treats an absent, `none`, or zero output cap as following the model", () => {
    const absent = parse(`---
description: Reads code.
---
Read it.`);
    expect(absent.ok).toBe(true);
    if (absent.ok) expect(absent.definition.maxTokens).toBeUndefined();

    for (const value of ["none", "0", "0.0"]) {
      const result = parse(`---
description: Reads code.
maxTokens: ${value}
---
Read it.`);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.definition.maxTokens).toBeUndefined();
        expect(result.warnings).toEqual([]);
      }
    }
  });

  it("clamps an output cap above the ceiling and ignores one that is not a cap", () => {
    // No model accepts an output limit this high, so it is a typo, and the
    // clamp keeps a document from asking a provider for the impossible.
    const tooLarge = parse(`---
description: Reads code.
max-tokens: 5000000
---
Read it.`);
    expect(tooLarge.ok).toBe(true);
    if (tooLarge.ok) {
      expect(tooLarge.definition.maxTokens).toBe(MAX_SUBAGENT_MAX_TOKENS);
      expect(tooLarge.warnings).toEqual([
        `clamping \`maxTokens\` 5000000 to ${MAX_SUBAGENT_MAX_TOKENS}`,
      ]);
    }

    // A negative or fractional value is not a cap at all; ignoring it leaves
    // the delegate on the model's published limit rather than on a value the
    // provider would reject outright.
    for (const value of ["soon", "-5", "1.5"]) {
      const invalid = parse(`---
description: Reads code.
maxTokens: ${value}
---
Read it.`);
      expect(invalid.ok).toBe(true);
      if (invalid.ok) {
        expect(invalid.definition.maxTokens).toBeUndefined();
        expect(invalid.warnings).toEqual([
          `ignoring invalid \`maxTokens\` "${value}" (following the model limit)`,
        ]);
      }
    }
  });

  it("rejects a name that cannot be used as a Task argument", () => {
    const result = parseSubagentDefinition(
      `---
name: Code Reviewer!
description: Reviews a diff.
---
Review it.`,
      { source: "user" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toMatch(/invalid name/);
    }
  });

  it("fails a document with no frontmatter at all", () => {
    const result = parse("Just some prose.");
    expect(result.ok).toBe(false);
  });

  it("parses tools: inherit as an opt-in parent-tool union", () => {
    const result = parse(`---
description: Works with the parent toolset.
tools: inherit
---
Do the job.`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.definition.inheritTools).toBe(true);
    expect(result.definition.tools).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(subagentCanMutate(result.definition)).toBe(true);
    expect(subagentToolsLabel(result.definition)).toBe("inherit");
  });

  it("parses tools: inherit with assignable extras", () => {
    const result = parse(`---
description: Writes with the parent toolset plus Bash.
tools: [inherit, Bash]
---
Do the job.`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.definition.inheritTools).toBe(true);
    expect(result.definition.tools).toEqual(["bash"]);
    expect(subagentToolsLabel(result.definition)).toBe("inherit + bash");
  });

  it("does not treat inherit as a bare unknown tool", () => {
    const result = parse(`---
description: Only inherit.
tools: inherit, Grep
---
Do the job.`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings).toEqual([]);
    expect(result.definition.inheritTools).toBe(true);
    expect(result.definition.tools).toEqual(["grep"]);
  });
});

describe("resolveSubagentToolNames", () => {
  const parent = [
    "Read",
    "Glob",
    "Grep",
    "Bash",
    "Skill",
    "ToolSearch",
    "Task",
    "TaskWait",
    "asktool",
    "EnterPlanMode",
    "new_context",
    "mcp-foo",
  ];

  it("returns only the declared list when inherit is off", () => {
    expect(
      resolveSubagentToolNames({ tools: ["Read", "Bash"] }, parent),
    ).toEqual(["read", "bash"]);
  });

  it("unions parent tools minus the deny list", () => {
    const resolved = resolveSubagentToolNames(
      { tools: [], inheritTools: true },
      parent,
    );
    expect(resolved).toContain("read");
    expect(resolved).toContain("skill");
    expect(resolved).toContain("mcp-foo");
    expect(resolved).not.toContain("tool_search");
    expect(resolved).not.toContain("new_context");
    for (const denied of SUBAGENT_INHERIT_DENY_TOOLS) {
      expect(resolved).not.toContain(denied);
    }
  });

  it("keeps declared extras and does not duplicate parent names", () => {
    const resolved = resolveSubagentToolNames(
      { tools: ["Edit", "Read"], inheritTools: true },
      parent,
    );
    expect(resolved).toContain("edit");
    expect(resolved).toContain("read");
    expect(resolved.filter((n) => n === "read")).toHaveLength(1);
  });

  it("does not hand a delegate nested Task tools", () => {
    const resolved = resolveSubagentToolNames(
      { tools: [...SUBAGENT_ASSIGNABLE_TOOLS], inheritTools: true },
      ["Task", "TaskList", "Read"],
    );
    // The parent's legacy "Read" normalizes onto the canonical "read" that the
    // declared list already carries, so nothing is duplicated.
    expect(resolved).toEqual([...SUBAGENT_ASSIGNABLE_TOOLS]);
  });

  it("uses a resolved list to decide mutation, not the inherit token", () => {
    expect(
      subagentCanMutate(definition({ tools: [], inheritTools: true }), [
        "Read",
        "Glob",
      ]),
    ).toBe(false);
    expect(
      subagentCanMutate(definition({ tools: [], inheritTools: true }), [
        "Read",
        "Edit",
      ]),
    ).toBe(true);
  });
});

describe("normalizeSubagentName", () => {
  it("turns a file path into a Task argument", () => {
    expect(normalizeSubagentName("/home/.agents/subagents/Code_Reviewer.md")).toBe(
      "code-reviewer",
    );
    expect(normalizeSubagentName("reviewer")).toBe("reviewer");
  });
});

describe("mergeSubagentDefinitions", () => {
  it("lets a global user document shadow the builtin of the same name", () => {
    const merged = mergeSubagentDefinitions([
      definition({ name: "reviewer", source: "builtin", prompt: "builtin" }),
      definition({ name: "reviewer", source: "user", prompt: "user" }),
      definition({ name: "explorer", source: "builtin" }),
    ]);

    expect(merged.definitions).toHaveLength(2);
    const reviewer = merged.definitions.find((d) => d.name === "reviewer");
    expect(reviewer?.source).toBe("user");
    expect(reviewer?.prompt).toBe("user");
    expect(merged.dropped).toEqual([]);
  });

  it("ranks the user's own registry over builtin", () => {
    const merged = mergeSubagentDefinitions([
      definition({ name: "reviewer", source: "builtin", prompt: "builtin" }),
      definition({ name: "reviewer", source: "user", prompt: "user" }),
      definition({ name: "explorer", source: "builtin", prompt: "builtin" }),
      definition({ name: "explorer", source: "user", prompt: "user" }),
    ]);

    expect(merged.definitions).toHaveLength(2);
    expect(merged.definitions.find((d) => d.name === "reviewer")?.prompt).toBe("user");
    expect(merged.definitions.find((d) => d.name === "explorer")?.prompt).toBe("user");
    expect(merged.dropped).toEqual([]);
  });

  it("caps the catalog and reports what it dropped", () => {
    const many = Array.from({ length: MAX_SUBAGENT_DEFINITIONS + 2 }, (_, i) =>
      definition({ name: `agent-${i}`, source: "builtin" }),
    );
    const merged = mergeSubagentDefinitions(many);

    expect(merged.definitions).toHaveLength(MAX_SUBAGENT_DEFINITIONS);
    expect(merged.dropped).toEqual([
      `agent-${MAX_SUBAGENT_DEFINITIONS}`,
      `agent-${MAX_SUBAGENT_DEFINITIONS + 1}`,
    ]);
  });
});

describe("subagentPinnedProviders", () => {
  it("lists each pinned provider once", () => {
    const providers = subagentPinnedProviders([
      definition({ name: "a", model: { providerId: "p1", modelId: "m" } }),
      definition({ name: "b", model: { providerId: "p1", modelId: "m2" } }),
      definition({ name: "c", model: { providerId: "p2", modelId: "m" } }),
      definition({ name: "d" }),
    ]);
    expect(providers).toEqual(["p1", "p2"]);
  });
});


describe("definition fallback models", () => {
  it("keeps primary pins compatible and reads ordered inline and block alternatives", () => {
    for (const list of ["fallbackModels: [vendor/first, Other Gateway/org/second, vendor/first]", "fallback-models:\n  - vendor/first\n  - Other Gateway/org/second\n  - vendor/first"]) {
      const result = parse(`---\nmodel: primary/model\n${list}\ndescription: Fallback fixture.\n---\nFinish.`);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.definition.model).toEqual({ providerId: "primary", modelId: "model" });
      expect(result.definition.fallbackModels).toEqual([
        { providerId: "vendor", modelId: "first" },
        { providerId: "Other Gateway", modelId: "org/second" },
      ]);
    }
    const legacy = parse("---\ndescription: Old document.\n---\nFinish.");
    expect(legacy.ok && legacy.definition.fallbackModels).toBeUndefined();
  });

  it("rejects a malformed fallback rather than silently changing the requested chain", () => {
    const result = parse("---\ndescription: Bad fallback.\nfallbackModels: [vendor/valid, bare-model]\n---\nFinish.");
    expect(result.ok).toBe(false);
  });
});
