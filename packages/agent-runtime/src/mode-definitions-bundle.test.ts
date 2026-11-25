import { describe, expect, it } from "vitest";
import { loadModeDefinitions, parseUserModeDocument, type UserModeDocument } from "./mode-definitions.js";
import { readModeBundleReferences, renameModeBundle } from "./mode-definitions-bundle.js";

const BUNDLE_SOURCE = `name: sisyphus
label: Sisyphus
description: Split the work, keep the review separate
permission: agent
promptFile: prompts/orchestrator.md
subagents:
  - agents/oracle.agent.md
  - agents/fixer.agent.md
includeGlobalSubagents: false
disabledSkills:
  - verify-delivery
`;

const ORACLE = `---
name: oracle
description: Judge the technical trade-offs
tools: Read, Grep
---
You are the Oracle. Answer the question you were asked.
`;

const FIXER = `---
name: fixer
description: Make the change
tools: inherit
---
You are the Fixer.
`;

function bundleDocument(overrides: Partial<UserModeDocument> = {}): UserModeDocument {
  return {
    dirName: "sisyphus",
    filePath: "/home/user/.pi/modes/sisyphus/mode.md",
    source: "",
    templates: {},
    bundle: {
      filePath: "/home/user/.pi/modes/sisyphus/mode.yaml",
      source: BUNDLE_SOURCE,
      prompt: { path: "prompts/orchestrator.md", text: "You are the orchestrator.\n" },
      subagents: [
        { path: "agents/oracle.agent.md", text: ORACLE },
        { path: "agents/fixer.agent.md", text: FIXER },
      ],
    },
    ...overrides,
  };
}

describe("readModeBundleReferences", () => {
  it("reads the four bundle keys and keeps the mode fields separate", () => {
    const result = readModeBundleReferences(BUNDLE_SOURCE);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.references).toEqual({
      promptFile: "prompts/orchestrator.md",
      subagents: ["agents/oracle.agent.md", "agents/fixer.agent.md"],
      includeGlobalSubagents: false,
      disabledSkills: ["verify-delivery"],
    });
    // Bundle keys are not mode fields, so the mode parser never sees them.
    expect(Object.keys(result.frontmatter).sort()).toEqual(
      ["description", "label", "name", "permission"],
    );
  });

  it("defaults includeGlobalSubagents to false, so globals are opt-in", () => {
    const result = readModeBundleReferences("name: solo\npromptFile: prompt.md\n");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.references.includeGlobalSubagents).toBe(false);
    expect(result.references.disabledSkills).toEqual([]);
    expect(result.references.subagents).toEqual([]);
  });

  it("requires promptFile", () => {
    const result = readModeBundleReferences("name: solo\n");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual([
      "promptFile: required; name the mode's prompt document inside the mode directory",
    ]);
  });

  it.each([
    ["../escape.md", /promptFile: must stay inside the mode directory/],
    ["/etc/passwd", /promptFile: must be relative to the mode directory/],
    ["C:/windows/x.md", /promptFile: must be relative to the mode directory/],
    ["~/x.md", /promptFile: must be relative to the mode directory/],
    ["prompts\\x.md", /promptFile: use forward slashes/],
    [".hidden/x.md", /promptFile: must not use hidden path segments/],
  ])("rejects the reference %s", (reference, message) => {
    // Single quotes keep the backslash literal so our own check sees it.
    const result = readModeBundleReferences(`name: solo\npromptFile: '${reference}'\n`);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join("\n")).toMatch(message);
  });

  it("rejects a misspelled key instead of ignoring it", () => {
    const result = readModeBundleReferences(
      `name: solo\npromptFile: prompt.md\nincludeGlobalSubagent: true\n`,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual(["includeGlobalSubagent: unknown key in mode.yaml"]);
  });

  it("rejects a duplicate subagent path and a duplicate skill id", () => {
    const result = readModeBundleReferences(
      [
        "name: solo",
        "promptFile: prompt.md",
        "subagents: [agents/a.md, agents/a.md]",
        "disabledSkills: [one, one]",
        "",
      ].join("\n"),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual([
      'subagents[1]: "agents/a.md" is listed twice',
      'disabledSkills[1]: "one" is listed twice',
    ]);
  });

  it("rejects anchors and aliases like every other mode document", () => {
    const result = readModeBundleReferences(
      "name: solo\npromptFile: &p prompt.md\nsubagents: [*p]\n",
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join("\n")).toMatch(/anchors|aliases/);
  });
});

describe("parseUserModeDocument", () => {
  it("assembles a bundle definition with private delegates and skill switches", () => {
    const parsed = parseUserModeDocument(bundleDocument(), { source: "user", fallbackName: "sisyphus" });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.definition.bundle?.subagents.map((role) => role.name)).toEqual(["oracle", "fixer"]);
    expect(parsed.definition.bundle?.includeGlobalSubagents).toBe(false);
    expect(parsed.definition.bundle?.disabledSkills).toEqual(["verify-delivery"]);
    expect(parsed.definition.prompt).toBe("You are the orchestrator.");
    expect(parsed.definition.label).toBe("Sisyphus");
  });

  it("gives a private delegate its file name when the document omits name", () => {
    const document = bundleDocument();
    document.bundle!.source = "name: sisyphus\npromptFile: prompts/orchestrator.md\nsubagents: [agents/oracle.agent.md]\n";
    document.bundle!.subagents = [{ path: "agents/oracle.agent.md", text: "---\ndescription: Judge\n---\nBody.\n" }];

    const parsed = parseUserModeDocument(document, { source: "user", fallbackName: "sisyphus" });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // A delegate handle may not carry the document extension, so the stem is used.
    expect(parsed.definition.bundle?.subagents[0].name).toBe("oracle");
  });

  it("reports a missing prompt file by field and never falls back to mode.md", () => {
    const document = bundleDocument({ source: "---\nname: legacy\n---\nLegacy prompt.\n" });
    document.bundle!.prompt = {
      path: "prompts/orchestrator.md",
      text: null,
      problem: "not found in the mode directory",
    };

    const parsed = parseUserModeDocument(document, { source: "user", fallbackName: "sisyphus" });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors).toEqual(["promptFile: not found in the mode directory"]);
  });

  it("reports a missing subagent document by its reference", () => {
    const document = bundleDocument();
    document.bundle!.source = "name: sisyphus\npromptFile: prompts/orchestrator.md\nsubagents: [agents/oracle.agent.md]\n";
    document.bundle!.subagents = [
      { path: "agents/oracle.agent.md", text: null, problem: "is a symbolic link; copy the file into the mode instead" },
    ];

    const parsed = parseUserModeDocument(document, { source: "user", fallbackName: "sisyphus" });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors).toEqual([
      "subagents[0] (agents/oracle.agent.md): is a symbolic link; copy the file into the mode instead",
    ]);
  });

  it("reports a declared subagent document that was never read", () => {
    const document = bundleDocument();
    document.bundle!.subagents = [document.bundle!.subagents[0]];

    const parsed = parseUserModeDocument(document, { source: "user", fallbackName: "sisyphus" });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors).toEqual(["subagents[1] (agents/fixer.agent.md): was not read"]);
  });

  it("rejects two private delegates that share a handle", () => {
    const document = bundleDocument();
    document.bundle!.source =
      "name: sisyphus\npromptFile: prompts/orchestrator.md\nsubagents: [agents/oracle.agent.md, agents/oracle-copy.agent.md]\n";
    document.bundle!.subagents = [
      { path: "agents/oracle.agent.md", text: ORACLE },
      { path: "agents/oracle-copy.agent.md", text: ORACLE },
    ];

    const parsed = parseUserModeDocument(document, { source: "user", fallbackName: "sisyphus" });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors).toEqual([
      'subagents[1] (agents/oracle-copy.agent.md): role "oracle" is declared twice in this mode',
    ]);
  });


  it("reports an unreadable mode.yaml without loading the legacy document", () => {
    const document = bundleDocument({ source: "---\nname: legacy\n---\nLegacy prompt.\n" });
    document.bundle!.source = null;
    document.bundle!.problem = "mode.yaml is a symbolic link";

    const parsed = parseUserModeDocument(document, { source: "user", fallbackName: "sisyphus" });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors).toEqual(["mode.yaml: mode.yaml is a symbolic link"]);
  });

  it("keeps the legacy document path unchanged when there is no bundle", () => {
    const parsed = parseUserModeDocument(
      {
        dirName: "reviewer",
        filePath: "/home/user/.pi/modes/reviewer/mode.md",
        source: "---\nname: reviewer\ndescription: Review\n---\nReview the change.\n",
        templates: {},
      },
      { source: "user", fallbackName: "reviewer" },
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.definition.bundle).toBeUndefined();
    expect(parsed.definition.prompt).toBe("Review the change.");
  });
});

describe("loadModeDefinitions with bundles", () => {
  it("loads a bundle mode and points the catalog at its mode.yaml", () => {
    const result = loadModeDefinitions({ userDocuments: [bundleDocument()] });

    expect(result.diagnostics).toEqual([]);
    const entry = result.catalog.find((candidate) => candidate.id === "sisyphus");
    expect(entry).toMatchObject({
      id: "sisyphus",
      source: "user",
      available: true,
      filePath: "/home/user/.pi/modes/sisyphus/mode.yaml",
    });
    const definition = result.definitions.find((candidate) => candidate.id === "sisyphus");
    expect(definition?.bundle?.subagents).toHaveLength(2);
  });

  it("reports an invalid bundle as unavailable while the other modes still load", () => {
    const broken = bundleDocument({ dirName: "broken", filePath: "/home/user/.pi/modes/broken/mode.md" });
    broken.bundle = {
      filePath: "/home/user/.pi/modes/broken/mode.yaml",
      source: "name: broken\npromptFile: ../outside.md\n",
      subagents: [],
    };
    const result = loadModeDefinitions({
      userDocuments: [
        broken,
        {
          dirName: "reviewer",
          filePath: "/home/user/.pi/modes/reviewer/mode.md",
          source: "---\nname: reviewer\ndescription: Review\n---\nReview the change.\n",
          templates: {},
        },
      ],
    });

    const entry = result.catalog.find((candidate) => candidate.id === "broken");
    expect(entry?.available).toBe(false);
    expect(entry?.filePath).toBe("/home/user/.pi/modes/broken/mode.yaml");
    expect(result.diagnostics.map((diagnostic) => [diagnostic.modeId, diagnostic.filePath])).toEqual([
      ["broken", "/home/user/.pi/modes/broken/mode.yaml"],
    ]);
    expect(result.diagnostics[0].errors.join("\n")).toMatch(/promptFile: must stay inside the mode directory/);
    expect(result.catalog.some((candidate) => candidate.id === "reviewer" && candidate.available)).toBe(true);
  });

  it("lets a builtin folder override with a bundle and reports a broken one", () => {
    const override = bundleDocument({ dirName: "agent", filePath: "/home/user/.pi/modes/agent/mode.md" });
    override.bundle!.source = "name: agent\nlabel: Agent\npermission: agent\npromptFile: prompts/x.md\n";
    override.bundle!.prompt = { path: "prompts/x.md", text: "Custom agent prompt." };
    override.bundle!.subagents = [];

    const loaded = loadModeDefinitions({ userDocuments: [override] });
    const agent = loaded.definitions.find((definition) => definition.id === "agent");
    expect(agent?.prompt).toBe("Custom agent prompt.");
    expect(loaded.catalog.find((entry) => entry.id === "agent")?.customized).toBe(true);

    override.bundle!.source = "name: agent\npermission: agent\npromptFile: missing.md\n";
    override.bundle!.prompt = { path: "missing.md", text: null, problem: "not found in the mode directory" };
    const broken = loadModeDefinitions({ userDocuments: [override] });
    // The shipped definition stays in effect; the diagnostic names the field.
    expect(broken.definitions.find((definition) => definition.id === "agent")?.prompt).not.toBe("Custom agent prompt.");
    expect(broken.diagnostics[0].errors).toEqual(["promptFile: not found in the mode directory"]);
  });
});

describe("renameModeBundle", () => {
  it("retargets the top-level name and leaves everything else alone", () => {
    const renamed = renameModeBundle(BUNDLE_SOURCE, "sisyphus-copy");

    expect(renamed.startsWith("name: sisyphus-copy\n")).toBe(true);
    expect(renamed).toContain("subagents:\n  - agents/oracle.agent.md\n");
    expect(renamed).toContain("disabledSkills:\n  - verify-delivery\n");
    // The renamed map is still a valid bundle for the new id.
    const parsed = readModeBundleReferences(renamed);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.frontmatter.name).toBe("sisyphus-copy");
    expect(parsed.references.subagents).toEqual(["agents/oracle.agent.md", "agents/fixer.agent.md"]);
  });

  it("keeps a quoted name quoted", () => {
    const renamed = renameModeBundle('name: "sisyphus"\npromptFile: prompt.md\n', "copy");

    expect(renamed).toBe('name: "copy"\npromptFile: prompt.md\n');
  });

  it("does not touch a nested name or a name inside a comment", () => {
    const source = "# name: not-this\npromptFile: prompt.md\nstages:\n  work:\n    prompt: name: nested\n";
    const renamed = renameModeBundle(source, "copy");

    // There is no top-level `name:` line, so the document is returned unchanged.
    expect(renamed).toBe(source);
  });

  it("does not rewrite a value that merely mentions name", () => {
    const source = "description: rename: keep this\nname: sisyphus\npromptFile: prompt.md\n";
    const renamed = renameModeBundle(source, "copy");

    expect(renamed).toContain("description: rename: keep this");
    expect(renamed).toContain("\nname: copy\n");
  });
});
