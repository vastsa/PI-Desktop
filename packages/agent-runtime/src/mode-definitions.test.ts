import { describe, expect, it } from "vitest";
import {
  builtinModeDefinition,
  builtinModeSource,
  loadModeDefinitions,
  MAX_USER_MODES,
  parseStrictModeYaml,
  type UserModeDocument,
} from "./mode-definitions.js";
import { AGENT_MODE_SYSTEM_PROMPT, GOAL_WORK_STAGE_PROMPT, PLAN_MODE_SYSTEM_PROMPT } from "./mode-prompts.js";

function userDocument(dirName: string, source: string, templates: Record<string, string> = {}): UserModeDocument {
  return { dirName, filePath: `/home/user/.pi/modes/${dirName}/mode.md`, source, templates };
}

const REVIEWER = `---
name: reviewer
label: Reviewer
description: Review without changing anything
permission: contract
---

Review the change and report findings.
`;

const RELEASE = `---
label: Release
artifacts:
  notes:
    path: ".pi/release/{{run.id}}.md"
    template: templates/notes.md
    requiredHeadings: [Summary]
stages:
  draft:
    permission: contract
    prompt: Draft the notes at {{artifacts.notes.path}}.
    on:
      enter:
        - inject: artifact:notes
    exit:
      - require: artifact:notes
    next: check
  check:
    exit:
      - run:
          command: npm test
          timeoutMinutes: 5
---

Prepare a release.
`;

describe("loadModeDefinitions", () => {
  it("loads the builtins first with their historical prompts", () => {
    const result = loadModeDefinitions({ userDocuments: [] });

    expect(result.diagnostics).toEqual([]);
    expect(result.catalog.map((entry) => [entry.id, entry.source, entry.staged, entry.available])).toEqual([
      ["agent", "builtin", false, true],
      ["plan", "builtin", false, true],
      ["goal", "builtin", true, true],
    ]);
    const [agent, plan, goal] = result.definitions;
    expect(agent).toMatchObject({ id: "agent", permission: "agent", prompt: AGENT_MODE_SYSTEM_PROMPT, stages: [] });
    expect(plan).toMatchObject({ id: "plan", permission: "contract", prompt: PLAN_MODE_SYSTEM_PROMPT, stages: [] });
    expect(goal).toMatchObject({
      id: "goal",
      label: "Goal",
      budget: { maxTurns: 20, maxTokens: null },
      returnTo: "agent",
      artifacts: [{ id: "goal", path: ".pi/goals/{{run.id}}.md", requiredHeadings: ["Objective", "Acceptance criteria", "Evidence"] }],
    });
    expect(goal.stages).toEqual([{
      id: "work",
      prompt: GOAL_WORK_STAGE_PROMPT,
      permission: "agent",
      loop: true,
      onEnter: [],
      onCompaction: [{ kind: "artifact", artifact: "goal" }],
      exit: [{ kind: "require", artifact: "goal", onFail: { retries: 2 } }],
    }]);
  });

  it("loads valid user modes after the builtins, resolving templates", () => {
    const result = loadModeDefinitions({
      userDocuments: [
        userDocument("reviewer", REVIEWER),
        userDocument("release", RELEASE, { "templates/notes.md": "# Summary\n" }),
      ],
    });

    expect(result.catalog.map((entry) => entry.id)).toEqual(["agent", "plan", "goal", "reviewer", "release"]);
    expect(result.catalog[3]).toEqual({
      id: "reviewer",
      label: "Reviewer",
      description: "Review without changing anything",
      source: "user",
      staged: false,
      available: true,
      filePath: "/home/user/.pi/modes/reviewer/mode.md",
    });
    const release = result.definitions.find((definition) => definition.id === "release");
    expect(release).toMatchObject({
      source: "user",
      permission: "agent",
      prompt: "Prepare a release.",
      artifacts: [{ id: "notes", template: "# Summary\n" }],
    });
    expect(release?.stages.map((stage) => [stage.id, stage.permission, stage.next])).toEqual([
      ["draft", "contract", "check"],
      ["check", "agent", undefined],
    ]);
    expect(release?.stages[1].exit).toEqual([
      { kind: "run", command: "npm test", timeoutMinutes: 5, onFail: { retries: 2 } },
    ]);
    expect(result.diagnostics).toEqual([]);
  });

  it("reports an invalid mode as unavailable with diagnostics keyed by the mode id", () => {
    const result = loadModeDefinitions({
      userDocuments: [
        userDocument("broken", "---\npermission: root\n---\nBody\n"),
        userDocument("missing-template", RELEASE),
        userDocument("reviewer", REVIEWER),
      ],
    });

    expect(result.definitions.map((definition) => definition.id)).toEqual(["agent", "plan", "goal", "reviewer"]);
    expect(result.catalog.find((entry) => entry.id === "broken")).toMatchObject({ available: false, source: "user" });
    expect(result.catalog.find((entry) => entry.id === "missing-template")).toMatchObject({ available: false });
    const broken = result.diagnostics.find((diagnostic) => diagnostic.modeId === "broken");
    expect(broken?.errors.join("\n")).toContain("permission");
    expect(broken?.filePath).toBe("/home/user/.pi/modes/broken/mode.md");
    const missing = result.diagnostics.find((diagnostic) => diagnostic.modeId === "missing-template");
    expect(missing?.errors.join("\n")).toContain("templates/notes.md");
  });

  it("reports an unreadable or oversized document", () => {
    const result = loadModeDefinitions({ userDocuments: [userDocument("huge", "")] });

    expect(result.catalog.at(-1)).toMatchObject({ id: "huge", available: false });
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ modeId: "huge", errors: [expect.stringContaining("unreadable or larger than")] }),
    ]);
  });

  it("never lets a user document replace a builtin", () => {
    const result = loadModeDefinitions({
      userDocuments: [
        userDocument("agent", "---\nlabel: Mine\npermission: contract\n---\nMine\n"),
        userDocument("other", "---\nname: plan\npermission: agent\n---\nMine\n"),
      ],
    });

    expect(result.definitions.map((definition) => [definition.id, definition.source])).toEqual([
      ["agent", "builtin"],
      ["plan", "builtin"],
      ["goal", "builtin"],
    ]);
    expect(result.definitions[0].permission).toBe("agent");
    expect(result.definitions[1].permission).toBe("contract");
    const reserved = result.catalog.filter((entry) => entry.reserved);
    expect(reserved).toEqual([
      expect.objectContaining({ id: "agent", reserved: true, available: false, source: "user" }),
      expect.objectContaining({ id: "plan", reserved: true, available: false, source: "user" }),
    ]);
    expect(result.diagnostics.map((diagnostic) => diagnostic.modeId)).toEqual(["agent", "plan"]);
  });

  it("refuses a duplicate id and caps the number of user modes", () => {
    const duplicate = loadModeDefinitions({
      userDocuments: [
        userDocument("reviewer", REVIEWER),
        userDocument("reviewer-copy", REVIEWER),
      ],
    });
    expect(duplicate.definitions.filter((definition) => definition.id === "reviewer")).toHaveLength(1);
    expect(duplicate.diagnostics).toContainEqual(expect.objectContaining({
      modeId: "reviewer",
      errors: [expect.stringContaining("already uses the id")],
    }));

    const many = Array.from({ length: MAX_USER_MODES + 1 }, (_, index) => userDocument(`mode-${index}`, "Body\n"));
    const capped = loadModeDefinitions({ userDocuments: many });
    expect(capped.definitions).toHaveLength(3 + MAX_USER_MODES);
    expect(capped.catalog.at(-1)).toMatchObject({ id: `mode-${MAX_USER_MODES}`, available: false });
  });

  it("uses the directory name when the frontmatter has no name", () => {
    const result = loadModeDefinitions({ userDocuments: [userDocument("notes", "Just a prompt.\n")] });
    expect(result.definitions.at(-1)).toMatchObject({ id: "notes", label: "notes", permission: "agent", prompt: "Just a prompt." });
  });
});

describe("strict mode YAML", () => {
  it.each([
    ["duplicate keys", "label: a\nlabel: b", "keys must be unique"],
    ["anchors", "label: &x a\ndescription: b", "anchors"],
    ["aliases", "label: &x a\ndescription: *x", "aliases"],
    ["explicit tags", "label: !!str a", "tags"],
    ["merge keys", "<<: { label: a }\ndescription: b", "merge keys"],
    ["syntax errors", "label: [unclosed", "frontmatter"],
  ])("rejects %s", (_name, yaml, fragment) => {
    const parsed = parseStrictModeYaml(yaml);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.errors.join("\n")).toContain(fragment);
  });

  it("parses plain core-schema values", () => {
    expect(parseStrictModeYaml("label: a\nbudget: { maxTurns: 3 }\nlist: [x, 2]")).toEqual({
      ok: true,
      value: { label: "a", budget: { maxTurns: 3 }, list: ["x", 2] },
      warnings: [],
    });
  });

  it("surfaces a strict YAML rejection as a mode diagnostic", () => {
    const result = loadModeDefinitions({
      userDocuments: [userDocument("aliased", "---\nlabel: &l Aliased\ndescription: *l\n---\nBody\n")],
    });
    expect(result.catalog.at(-1)).toMatchObject({ id: "aliased", available: false });
    expect(result.diagnostics[0].errors.join("\n")).toMatch(/anchors|aliases/);
  });

  it("rejects an unterminated frontmatter block", () => {
    const result = loadModeDefinitions({ userDocuments: [userDocument("open", "---\nlabel: Open\nBody\n")] });
    expect(result.diagnostics[0].errors).toEqual(["frontmatter: missing the closing --- line"]);
  });
});

describe("builtin sources", () => {
  it("returns Markdown for builtins only", () => {
    expect(builtinModeSource("goal")).toContain("name: goal");
    expect(builtinModeSource("agent")).toContain(AGENT_MODE_SYSTEM_PROMPT);
    expect(builtinModeSource("reviewer")).toBeUndefined();
    expect(builtinModeDefinition("plan")?.permission).toBe("contract");
    expect(builtinModeDefinition("reviewer")).toBeUndefined();
  });
});
