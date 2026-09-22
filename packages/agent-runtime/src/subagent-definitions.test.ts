import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SUBAGENT_IDLE_TIMEOUT_SECONDS,
  MAX_SUBAGENT_PROVIDERS,
  findSubagentPreset,
  subagentCanMutate,
  type SubagentDefinition,
} from "@pi-desktop/shared";
import {
  BUILTIN_SUBAGENT_DOCUMENTS,
  findSubagentProviderSource,
  loadSubagentDefinitions,
  resolveSubagentProviders,
  subagentDefinitionDir,
  subagentProviderLookupError,
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
      "ui-designer",
    ]);
    expect(definitions).toHaveLength(BUILTIN_SUBAGENT_DOCUMENTS.length);
    // The turn cap is gone (ADR 0253): no builtin document declares one.
    for (const document of BUILTIN_SUBAGENT_DOCUMENTS) {
      expect(document).not.toMatch(/max[_-]?turns/i);
    }
    for (const definition of definitions) {
      expect(definition.source).toBe("builtin");
      expect(definition.description.length).toBeGreaterThan(20);
      expect(definition.prompt.length).toBeGreaterThan(50);
    }
    // Only `fixer` and `ui-designer` may write to the workspace; every other
    // builtin is read-only (the shell delegate reads and runs commands, which
    // is a permission prompt, not an edit). Builtins inherit the parent
    // session's permission mode unless they explicitly opt into a narrower
    // scope.
    const mutating = definitions.filter(
      (definition) =>
        definition.tools.includes("write") || definition.tools.includes("edit"),
    );
    expect(mutating.map((d) => d.name)).toEqual(["fixer", "ui-designer"]);
    expect(mutating[0]?.permission ?? "inherit").toBe("inherit");
    const explorer = definitions.find((definition) => definition.name === "explorer")!;
    expect(explorer.tools).toEqual(["read", "glob", "grep", "bash"]);
    expect(subagentCanMutate(explorer)).toBe(true);
    expect("maxTurns" in explorer).toBe(false);
    expect(explorer.idleTimeoutSeconds).toBe(
      DEFAULT_SUBAGENT_IDLE_TIMEOUT_SECONDS,
    );
    expect(explorer.maxDurationSeconds).toBe(21_600);
    expect(definitions[2].tools).toContain("bash");
    const designer = definitions.find((definition) => definition.name === "ui-designer")!;
    expect(designer.tools).toContain("browser_preview");
    expect("maxTurns" in designer).toBe(false);
    expect(designer.description).toBe(findSubagentPreset("ui-designer")?.description);
    expect(designer.prompt).toBe(findSubagentPreset("ui-designer")?.body.trim());
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
      "---\ndescription: Global explorer.\ntools: [read]\n---\nSearch our way.\n",
      "utf8",
    );
    await writeFile(
      join(dir, "migrator.md"),
      "---\ndescription: Apply a migration.\ntools: [read, edit]\n---\nMigrate.\n",
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
    expect(explorer.tools).toEqual(["read"]);
    expect(definitions.filter((d) => d.name === "explorer")).toHaveLength(1);
    // The shadowed builtin is gone, the other builtins stay.
    expect(definitions.map((d) => d.name)).toContain("code-reviewer");
  });

  it("drops a switched-off builtin from the catalog and keeps it as a builtin row", async () => {
    const { definitions, builtins, diagnostics } = await loadSubagentDefinitions(null, {
      disabledBuiltins: ["fixer"],
    });

    expect(diagnostics).toEqual([]);
    expect(definitions.map((d) => d.name)).not.toContain("fixer");
    expect(definitions.map((d) => d.name)).toContain("explorer");
    // Settings needs the row back: its switch is the only way on again, and a
    // builtin has no document to delete.
    expect(builtins.map((d) => d.name)).toContain("fixer");
    expect(builtins.every((d) => d.source === "builtin")).toBe(true);
  });

  it("lets a user document keep a handle the user switched the builtin off", async () => {
    const { definitions, builtins } = await loadSubagentDefinitions(null, {
      userDocuments: [
        {
          id: "fixer",
          document: "---\nname: fixer\ndescription: Mine.\ntools: [read]\n---\nMine.\n",
          filePath: "/home/.agents/subagents/fixer.md",
        },
      ],
      disabledBuiltins: ["fixer"],
    });

    expect(definitions.find((d) => d.name === "fixer")?.source).toBe("user");
    expect(builtins.map((d) => d.name)).not.toContain("fixer");
  });

  it("reports a malformed document without losing the others", async () => {
    await writeFile(join(dir, "broken.md"), "---\ntools: [read]\n---\n\n", "utf8");
    await writeFile(
      join(dir, "good.md"),
      "---\ndescription: Fine.\ntools: [read, Nope]\n---\nWork.\n",
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
      "---\ndescription: Must not load.\ntools: [read]\n---\nIgnore me.\n",
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
            "---\nname: explorer\ndescription: My explorer.\ntools: [read, grep]\n---\nMine.\n",
          filePath: "/home/.agents/subagents/explorer.md",
        },
        {
          id: "test-runner",
          document:
            "---\nname: test-runner\ndescription: My runner.\ntools: [bash]\n---\nRun it.\n",
          filePath: "/home/.agents/subagents/test-runner.md",
        },
        {
          id: "note-taker",
          document:
            "---\nname: note-taker\ndescription: Take notes.\ntools: [read, write]\n---\nWrite notes.\n",
          filePath: "/home/.agents/subagents/note-taker.md",
        },
      ],
    });

    expect(diagnostics).toEqual([]);
    const byName = new Map(definitions.map((d) => [d.name, d]));
    expect(byName.get("explorer")!.source).toBe("user");
    expect(byName.get("test-runner")!.source).toBe("user");
    expect(byName.get("test-runner")!.filePath).toBe("/home/.agents/subagents/test-runner.md");
    expect(byName.get("note-taker")!.tools).toEqual(["read", "write"]);
    expect(byName.get("code-reviewer")!.source).toBe("builtin");
    expect(definitions.filter((d) => d.name === "explorer")).toHaveLength(1);
  });

  it("reports a malformed user document without losing the others", async () => {
    const { definitions, diagnostics } = await loadSubagentDefinitions(null, {
      userDocuments: [
        { id: "broken", document: "---\ntools: [read]\n---\n\n" },
        {
          id: "fine",
          document: "---\ndescription: Fine.\ntools: [read]\n---\nWork.\n",
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
      tools: ["read"],
      ...(pin ? { model: pin } : {}),
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

  it("matches a unique display name after an ambiguous vendor alias", () => {
    const other = { ...providers[0], id: "33333333-3333-4333-8333-333333333333", name: "Other" };
    expect(findSubagentProviderSource("anthropic", [...providers, other])?.id).toBe(providers[0].id);
    expect(findSubagentProviderSource(other.id, [...providers, other])?.id).toBe(other.id);
  });

  it("does not guess when vendor and display name both collide", () => {
    const other = { ...providers[0], id: "33333333-3333-4333-8333-333333333333" };
    expect(findSubagentProviderSource("anthropic", [...providers, other])).toBeUndefined();
    expect(subagentProviderLookupError("anthropic", [...providers, other])).toBe(
      'provider alias "anthropic" matches multiple accounts; use the exact provider id',
    );
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


it("resolves definition-scoped fallback pins with their own credentials", async () => {
  const { providers, diagnostics } = await resolveSubagentProviders({
    definitions: [{ name: "worker", description: "Fixture", tools: ["read"], prompt: "Finish", source: "user",
      model: { providerId: "primary", modelId: "one" },
      fallbackModels: [{ providerId: "other", modelId: "two" }, { providerId: "missing", modelId: "three" }],
    }],
    providers: [{ id: "primary", name: "Primary" }, { id: "other", name: "Other", headers: { "x-fixture": "backup" } }],
    getSecret: async (id) => `fixture-${id}`,
  });
  expect(providers["primary/one"].apiKey).toBe("fixture-primary");
  expect(providers["other/two"].apiKey).toBe("fixture-other");
  expect(providers["other/two"].headers).toEqual({ "x-fixture": "backup" });
  expect(providers["missing/three"]).toBeUndefined();
  expect(diagnostics).toEqual(['worker: no enabled provider matches "missing"']);
});


it("never resolves a disabled fallback provider", async () => {
  const resolved = await resolveSubagentProviders({
    definitions: [{ name: "worker", description: "Fixture", tools: ["read"], prompt: "Finish", source: "user",
      fallbackModels: [{ providerId: "disabled", modelId: "private" }],
    }],
    providers: [{ id: "disabled", name: "Disabled", enabled: false, authKind: "none" }],
    getSecret: async () => { throw new Error("disabled credentials must not be read"); },
  });
  expect(resolved.providers).toEqual({});
  expect(resolved.diagnostics).toHaveLength(1);
});
