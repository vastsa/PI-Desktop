import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SUBAGENT_IDLE_TIMEOUT_SECONDS,
  MAX_SUBAGENT_PROVIDERS,
  subagentCanMutate,
  type SubagentDefinition,
} from "@pi-desktop/shared";
import {
  BUILTIN_SUBAGENT_DOCUMENTS,
  loadSubagentDefinitions,
  resolveSubagentProviders,
  subagentDefinitionDir,
  type SubagentProviderSource,
} from "./subagent-definitions.js";
import {
  capabilitiesFromModelConfig,
  genericModelConfig,
} from "./model-capabilities.js";

describe("builtin subagent documents", () => {
  it("parse into read-only delegates plus a write-capable fixer", async () => {
    const { definitions, diagnostics } = await loadSubagentDefinitions(null);

    expect(diagnostics).toEqual([]);
    expect(definitions.map((d) => d.name)).toEqual([
      "explorer",
      "code-reviewer",
      "test-runner",
      "fixer",
    ]);
    expect(definitions).toHaveLength(BUILTIN_SUBAGENT_DOCUMENTS.length);
    for (const definition of definitions) {
      expect(definition.source).toBe("builtin");
      expect(definition.description.length).toBeGreaterThan(20);
      expect(definition.prompt.length).toBeGreaterThan(50);
    }
    // Only `fixer` may write to the workspace; every other builtin is
    // read-only (the shell delegate reads and runs commands, which is a
    // permission prompt, not an edit). Builtins inherit the parent session's
    // permission mode unless they explicitly opt into a narrower scope.
    const mutating = definitions.filter(
      (definition) =>
        definition.tools.includes("Write") || definition.tools.includes("Edit"),
    );
    expect(mutating.map((d) => d.name)).toEqual(["fixer"]);
    expect(mutating[0]?.permission ?? "inherit").toBe("inherit");
    const explorer = definitions.find((definition) => definition.name === "explorer")!;
    expect(explorer.tools).toEqual(["Read", "Glob", "Grep", "Bash"]);
    expect(subagentCanMutate(explorer)).toBe(true);
    expect(explorer.maxTurns).toBe(60);
    expect(explorer.idleTimeoutSeconds).toBe(
      DEFAULT_SUBAGENT_IDLE_TIMEOUT_SECONDS,
    );
    expect(explorer.maxDurationSeconds).toBe(21_600);
    expect(definitions[2].tools).toContain("Bash");
  });
});

describe("loadSubagentDefinitions", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pi-agents-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("loads global definitions and lets them shadow a builtin", async () => {
    await writeFile(
      join(dir, "explorer.md"),
      "---\ndescription: Global explorer.\ntools: [Read]\n---\nSearch our way.\n",
      "utf8",
    );
    await writeFile(
      join(dir, "migrator.md"),
      "---\ndescription: Apply a migration.\ntools: [Read, Edit]\n---\nMigrate.\n",
      "utf8",
    );

    const { definitions, diagnostics } = await loadSubagentDefinitions(null, { overrideDir: dir });

    expect(diagnostics).toEqual([]);
    expect(definitions.slice(0, 2).map((d) => d.name)).toEqual([
      "explorer",
      "migrator",
    ]);
    const explorer = definitions.find((d) => d.name === "explorer")!;
    expect(explorer.source).toBe("user");
    expect(explorer.tools).toEqual(["Read"]);
    expect(definitions.filter((d) => d.name === "explorer")).toHaveLength(1);
    // The shadowed builtin is gone, the other builtins stay.
    expect(definitions.map((d) => d.name)).toContain("code-reviewer");
  });

  it("reports a malformed document without losing the others", async () => {
    await writeFile(join(dir, "broken.md"), "---\ntools: [Read]\n---\n\n", "utf8");
    await writeFile(
      join(dir, "good.md"),
      "---\ndescription: Fine.\ntools: [Read, Nope]\n---\nWork.\n",
      "utf8",
    );

    const { definitions, diagnostics } = await loadSubagentDefinitions(null, { overrideDir: dir });

    expect(definitions.map((d) => d.name)).toContain("good");
    expect(definitions.map((d) => d.name)).not.toContain("broken");
    expect(diagnostics.join("\n")).toContain("missing `description`");
    expect(diagnostics.join("\n")).toContain('ignoring unknown tool "Nope"');
  });

  it("does not read project directories and falls back to builtins", async () => {
    await writeFile(
      join(dir, "project-only.md"),
      "---\ndescription: Must not load.\ntools: [Read]\n---\nIgnore me.\n",
      "utf8",
    );
    const { definitions, diagnostics } = await loadSubagentDefinitions(null);

    expect(subagentDefinitionDir(dir)).toBe(join(homedir(), ".agents", "subagents"));
    expect(definitions.every((d) => d.source === "builtin")).toBe(true);
    expect(definitions.map((d) => d.name)).not.toContain("project-only");
    expect(diagnostics).toEqual([]);
  });

  it("orders global documents before builtins without project sources", async () => {
    const { definitions, diagnostics } = await loadSubagentDefinitions(null, {
      userDocuments: [
        {
          id: "explorer",
          document:
            "---\nname: explorer\ndescription: My explorer.\ntools: [Read, Grep]\n---\nMine.\n",
          filePath: "/home/.agents/subagents/explorer.md",
        },
        {
          id: "test-runner",
          document:
            "---\nname: test-runner\ndescription: My runner.\ntools: [Bash]\n---\nRun it.\n",
          filePath: "/home/.agents/subagents/test-runner.md",
        },
        {
          id: "note-taker",
          document:
            "---\nname: note-taker\ndescription: Take notes.\ntools: [Read, Write]\n---\nWrite notes.\n",
          filePath: "/home/.agents/subagents/note-taker.md",
        },
      ],
    });

    expect(diagnostics).toEqual([]);
    const byName = new Map(definitions.map((d) => [d.name, d]));
    expect(byName.get("explorer")!.source).toBe("user");
    expect(byName.get("test-runner")!.source).toBe("user");
    expect(byName.get("test-runner")!.filePath).toBe("/home/.agents/subagents/test-runner.md");
    expect(byName.get("note-taker")!.tools).toEqual(["Read", "Write"]);
    expect(byName.get("code-reviewer")!.source).toBe("builtin");
    expect(definitions.filter((d) => d.name === "explorer")).toHaveLength(1);
  });

  it("reports a malformed user document without losing the others", async () => {
    const { definitions, diagnostics } = await loadSubagentDefinitions(null, {
      userDocuments: [
        { id: "broken", document: "---\ntools: [Read]\n---\n\n" },
        {
          id: "fine",
          document: "---\ndescription: Fine.\ntools: [Read]\n---\nWork.\n",
        },
      ],
    });

    expect(definitions.map((d) => d.name)).toContain("fine");
    expect(definitions.map((d) => d.name)).not.toContain("broken");
    expect(diagnostics.join("\n")).toContain('user subagent "broken"');
    expect(diagnostics.join("\n")).toContain("missing `description`");
    // The builtins are untouched by one bad registry entry.
    expect(definitions.map((d) => d.name)).toContain("explorer");
  });
});

describe("resolveSubagentProviders", () => {
  const providers: SubagentProviderSource[] = [
    {
      id: "11111111-1111-4111-8111-111111111111",
      name: "Anthropic",
      vendorKey: "anthropic",
      baseUrl: "https://api.anthropic.com",
      authKind: "apiKey",
      apiStyle: "anthropic_messages",
    },
    {
      id: "22222222-2222-4222-8222-222222222222",
      name: "Local Ollama",
      vendorKey: "custom",
      baseUrl: "http://127.0.0.1:11434/v1",
      authKind: "none",
    },
  ];

  function definition(
    name: string,
    pin: { providerId: string; modelId: string } | undefined,
  ): SubagentDefinition {
    return {
      name,
      description: `Delegate ${name}.`,
      tools: ["Read"],
      ...(pin ? { model: pin } : {}),
      maxTurns: 4,
      prompt: "Do the thing.",
      source: "user",
    };
  }

  const getSecret = async (id: string) =>
    id === providers[0].id ? "sk-test" : undefined;

  it("resolves a pin by vendor key, display name or stored id", async () => {
    const { providers: resolved, diagnostics } = await resolveSubagentProviders({
      definitions: [
        definition("a", { providerId: "anthropic", modelId: "claude-haiku-4-5" }),
        definition("b", { providerId: "local ollama", modelId: "qwen3" }),
        definition("c", { providerId: providers[0].id, modelId: "claude-opus-4-5" }),
      ],
      providers,
      getSecret,
      resolveModel: async (provider, modelId) => {
        const modelConfig = {
          ...genericModelConfig(modelId, provider.baseUrl ?? ""),
          source: "models.dev" as const,
          reasoning: provider.vendorKey === "anthropic",
          supportedThinkingLevels: provider.vendorKey === "anthropic"
            ? (["low", "medium", "high"] as const)
            : [],
        };
        return {
          modelConfig,
          capabilities: capabilitiesFromModelConfig(modelConfig),
        };
      },
    });

    expect(diagnostics).toEqual([]);
    expect(Object.keys(resolved).sort()).toEqual(
      [
        "anthropic/claude-haiku-4-5",
        `${providers[0].id}/claude-opus-4-5`,
        "local ollama/qwen3",
      ].sort(),
    );
    const haiku = resolved["anthropic/claude-haiku-4-5"];
    expect(haiku.id).toBe(providers[0].id);
    expect(haiku.modelId).toBe("claude-haiku-4-5");
    expect(haiku.apiKey).toBe("sk-test");
    expect(haiku.apiStyle).toBe("anthropic_messages");
    // Capabilities come from the main-supplied models.dev record, not the session's.
    expect(haiku.supportsReasoning).toBe(true);
    expect(haiku.modelConfig?.source).toBe("models.dev");
    // An `authKind: none` provider needs no secret.
    expect(resolved["local ollama/qwen3"].apiKey).toBe("");
  });

  it("does not guess when a vendor alias matches multiple account rows", async () => {
    const duplicate = {
      ...providers[0],
      id: "33333333-3333-4333-8333-333333333333",
    };
    const { providers: resolved, diagnostics } = await resolveSubagentProviders({
      definitions: [definition("ambiguous", { providerId: "anthropic", modelId: "claude-haiku-4-5" })],
      providers: [...providers, duplicate],
      getSecret,
    });

    expect(resolved).toEqual({});
    expect(diagnostics).toEqual([
      'ambiguous: no enabled provider matches "anthropic"',
    ]);
  });

  it("resolves each distinct pin once and reuses the secret lookup", async () => {
    const spy = vi.fn(getSecret);
    const { providers: resolved } = await resolveSubagentProviders({
      definitions: [
        definition("a", { providerId: "anthropic", modelId: "claude-haiku-4-5" }),
        definition("b", { providerId: "anthropic", modelId: "claude-haiku-4-5" }),
        definition("c", { providerId: "anthropic", modelId: "claude-opus-4-5" }),
        definition("d", undefined),
      ],
      providers,
      getSecret: spy,
    });

    expect(Object.keys(resolved)).toHaveLength(2);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("omits a pin it cannot resolve rather than substituting a provider", async () => {
    const { providers: resolved, diagnostics } = await resolveSubagentProviders({
      definitions: [
        definition("a", { providerId: "openai", modelId: "gpt-5" }),
        definition("b", { providerId: "anthropic", modelId: "claude-haiku-4-5" }),
      ],
      providers,
      getSecret: async () => undefined,
    });

    expect(resolved).toEqual({});
    expect(diagnostics).toEqual([
      'a: no enabled provider matches "openai"',
      'b: provider "Anthropic" has no API key',
    ]);
  });

  it("stops after the pinned-provider cap", async () => {
    const many: SubagentProviderSource[] = Array.from(
      { length: MAX_SUBAGENT_PROVIDERS + 2 },
      (_, index) => ({
        id: `provider-${index}`,
        name: `Provider ${index}`,
        vendorKey: "custom",
        authKind: "none",
      }),
    );
    const { providers: resolved, diagnostics } = await resolveSubagentProviders({
      definitions: many.map((provider, index) =>
        definition(`agent-${index}`, {
          providerId: provider.id,
          modelId: "local-model",
        }),
      ),
      providers: many,
      getSecret: async () => undefined,
    });

    expect(Object.keys(resolved)).toHaveLength(MAX_SUBAGENT_PROVIDERS);
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics[0]).toContain("too many pinned providers");
  });

  it("survives a failing secret lookup", async () => {
    const { providers: resolved, diagnostics } = await resolveSubagentProviders({
      definitions: [definition("a", { providerId: "anthropic", modelId: "claude-haiku-4-5" })],
      providers,
      getSecret: async () => {
        throw new Error("keychain locked");
      },
    });

    expect(resolved).toEqual({});
    expect(diagnostics[0]).toContain("has no API key");
  });
});
