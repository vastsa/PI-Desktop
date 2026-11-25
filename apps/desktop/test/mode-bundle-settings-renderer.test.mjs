/**
 * Renderer rules for the grouped mode settings page (issue #2544).
 *
 * The page shows one mode at a time. What it offers and what a save writes
 * is decided by pure helpers, so this test exercises those directly: which tabs
 * a document gets, how the map's keys read, how a role row is described, how a
 * role document round-trips, and how an out-of-order read is dropped.
 *
 * The Electron user-path test drives the whole page against a fake bridge; this
 * is the fast layer that fails first when the shape of a tab changes.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

const model = await import("../src/features/modes/mode-bundle-model.ts");
const roleDocument = await import("../src/features/modes/mode-role-document.ts");
const settingsModel = await import("../src/features/modes/modes-settings-model.ts");

const BUNDLE = [
  "name: sisyphus",
  "label: Sisyphus",
  "permission: agent",
  "promptFile: prompts/orchestrator.md",
  "subagents:",
  "  - agents/oracle.agent.md",
  "  - agents/fixer.agent.md",
  "includeGlobalSubagents: true",
  "disabledSkills:",
  "  - verify-delivery",
  "",
].join("\n");

const ORACLE = [
  "---",
  "name: oracle",
  "description: Technical judgment, read-only.",
  "tools: [Read, Grep]",
  "model: anthropic/claude-opus-4",
  "thinkingLevel: high",
  "fallbackModels: [openai/gpt-5, google/gemini-3]",
  "fallbackThinkingLevels: [medium, inherit]",
  "---",
  "",
  "Review only. Do not edit files.",
  "",
].join("\n");

test("a bundle has four navigation sections and a legacy document only its own", () => {
  assert.deepEqual(model.modeSettingsTabs("bundle"), ["mode", "prompt", "subagents", "skills"]);
  assert.deepEqual(model.modeSettingsTabs("legacy"), ["mode"]);
  assert.deepEqual(model.MODE_SETTINGS_TABS, ["mode", "prompt", "subagents", "skills"]);
});

test("the entry point decides the format, and a mode with no file starts as YAML", () => {
  assert.equal(
    model.modeDocumentFormat({ filePath: "/home/u/.pi/modes/x/mode.yaml", builtin: false, source: "" }),
    "bundle",
  );
  assert.equal(
    model.modeDocumentFormat({ filePath: "/home/u/.pi/modes/x/mode.md", builtin: false, source: "" }),
    "legacy",
  );
  // A builtin with no override: the shipped source decides what a save means.
  assert.equal(model.modeDocumentFormat({ builtin: true, source: BUNDLE }), "bundle");
  assert.equal(model.modeDocumentFormat({ builtin: true, source: "---\nname: goal\n---\nWork." }), "legacy");
  assert.equal(model.modeDocumentFormat({ builtin: true, source: "Just a prompt." }), "legacy");
});

test("the map's keys read as the loader reads them", () => {
  assert.equal(model.bundleScalar(BUNDLE, "promptFile"), "prompts/orchestrator.md");
  assert.equal(model.includeGlobalSubagents(BUNDLE), true);
  // Absent means off: a bundle's own roles are the whole catalog by default.
  assert.equal(model.includeGlobalSubagents("name: solo\npromptFile: p.md\n"), false);
  assert.deepEqual(model.bundleList(BUNDLE, "subagents"), [
    "agents/oracle.agent.md",
    "agents/fixer.agent.md",
  ]);
  assert.deepEqual(model.disabledSkillIds(BUNDLE), ["verify-delivery"]);
  // An inline list is the compact spelling of the same value.
  assert.deepEqual(model.bundleList("disabledSkills: [a, b]", "disabledSkills"), ["a", "b"]);
  assert.deepEqual(model.bundleList("name: x", "subagents"), []);
});

test("role rows follow the declared order and never invent a document", () => {
  const rows = model.modeRoleRows(BUNDLE, { "agents/oracle.agent.md": ORACLE });
  assert.deepEqual(rows.map((row) => row.name), ["oracle", "fixer"]);
  assert.deepEqual(rows.map((row) => row.reference), ["agents/oracle.agent.md", "agents/fixer.agent.md"]);
  const oracle = rows[0];
  assert.equal(oracle.description, "Technical judgment, read-only.");
  assert.equal(oracle.inheritsModel, false);
  assert.equal(oracle.thinkingLevel, "high");
  assert.equal(oracle.fallbackCount, 2);
  // The second declaration was not read, so it is reported as an empty row
  // rather than a delegate that silently disappeared.
  assert.equal(rows[1].source, "");
  assert.equal(rows[1].inheritsModel, true);
});

test("a role row's handle falls back to its file name without the qualifier", () => {
  assert.equal(model.roleHandleFromReference("agents/oracle.agent.md"), "oracle");
  assert.equal(model.roleHandleFromReference("oracle.agent.md"), "oracle");
  assert.equal(model.roleHandleFromReference("agents/plain.md"), "plain");
  assert.equal(model.roleHandleFromReference("agents/noext"), "noext");
});

test("map edits keep the keys this page does not own", () => {
  const source = [
    "name: sisyphus",
    "stages:",
    "  work:",
    "    name: inner",
    "    exit:",
    "      - ask",
    "promptFile: prompts/orchestrator.md",
    "",
  ].join("\n");
  const switched = model.setBundleScalar(source, "includeGlobalSubagents", "true");
  // Everything but the edited key is byte-identical, including the nested map.
  assert.equal(switched, `${source.replace(/\n$/, "")}\nincludeGlobalSubagents: true\n`);
  assert.match(switched, /    name: inner\n    exit:\n      - ask\n/);

  const listed = model.setBundleList(switched, "disabledSkills", ["a", "b"]);
  assert.match(listed, /\ndisabledSkills:\n {2}- a\n {2}- b\n$/);

  // Emptying the list removes the key instead of leaving `disabledSkills: []`.
  const cleared = model.setBundleList(listed, "disabledSkills", []);
  assert.doesNotMatch(cleared, /disabledSkills/);
  assert.match(cleared, /includeGlobalSubagents: true/);
});

test("a description that could break the map is quoted", () => {
  const written = model.setBundleScalar("name: x\n", "description", 'Two: parts, "quoted"');
  assert.equal(written, 'name: x\ndescription: "Two: parts, \\"quoted\\""\n');
});

test("adding, replacing and removing a role keeps the declared order", () => {
  const draft = model.bundleDraftFrom({ source: BUNDLE, prompt: "P", agents: {} });
  const added = model.putRole(draft, "agents/new.agent.md", "---\nname: new\n---\nBody\n");
  assert.deepEqual(model.bundleList(added.source, "subagents"), [
    "agents/oracle.agent.md",
    "agents/fixer.agent.md",
    "agents/new.agent.md",
  ]);
  // Replacing an existing reference does not move it.
  const replaced = model.putRole(added, "agents/oracle.agent.md", "---\nname: oracle\n---\nNew\n");
  assert.deepEqual(model.bundleList(replaced.source, "subagents"), model.bundleList(added.source, "subagents"));
  assert.equal(replaced.agents["agents/oracle.agent.md"], "---\nname: oracle\n---\nNew\n");

  const removed = model.removeRole(replaced, "agents/fixer.agent.md");
  assert.deepEqual(model.bundleList(removed.source, "subagents"), [
    "agents/oracle.agent.md",
    "agents/new.agent.md",
  ]);
  assert.equal(removed.agents["agents/fixer.agent.md"], undefined);
});

test("a new mode starts from a valid mode.yaml with its prompt already named", () => {
  const draft = model.newBundleDraft({ id: "fresh", label: "Fresh mode", description: "d", prompt: "Work." });
  assert.equal(draft.prompt, "Work.");
  assert.deepEqual(draft.agents, {});
  assert.equal(model.bundleScalar(draft.source, "name"), "fresh");
  assert.equal(model.bundleScalar(draft.source, "promptFile"), "prompts/mode.md");
  assert.equal(model.isBundleText(draft.source), true);
});

test("copying a bundle changes only its name", () => {
  const copy = model.copyBundleForId({ source: BUNDLE, prompt: "P", agents: { "agents/oracle.agent.md": ORACLE } }, "copy");
  assert.equal(model.bundleScalar(copy.source, "name"), "copy");
  assert.equal(model.bundleScalar(copy.source, "promptFile"), "prompts/orchestrator.md");
  assert.deepEqual(model.bundleList(copy.source, "subagents"), model.bundleList(BUNDLE, "subagents"));
  assert.equal(copy.prompt, "P");
  assert.equal(copy.agents["agents/oracle.agent.md"], ORACLE);
});

test("unsaved state is per document, not per open mode", () => {
  const saved = model.bundleDraftFrom({ source: BUNDLE, prompt: "P", agents: { a: "one" } });
  assert.equal(model.bundleDraftDirty(null, saved), false);
  assert.equal(model.bundleDraftDirty({ ...saved }, saved), false);
  assert.equal(model.bundleDraftDirty({ ...saved, prompt: "P2" }, saved), true);
  assert.equal(model.bundleDraftDirty({ ...saved, source: "name: y\n" }, saved), true);
  assert.equal(model.bundleDraftDirty({ ...saved, agents: { a: "two" } }, saved), true);
  assert.equal(model.bundleDraftDirty({ ...saved, agents: { ...saved.agents, b: "new" } }, saved), true);
});

test("the selector lists builtins then user documents and drops reserved ones", () => {
  const catalog = {
    directory: "/m",
    diagnostics: [],
    modes: [
      { id: "plan", label: "Plan", description: "", source: "builtin", staged: false, available: true },
      { id: "goal", label: "Goal", description: "", source: "builtin", staged: true, available: true },
      { id: "zed", label: "Zed", description: "", source: "user", staged: false, available: true },
      { id: "alpha", label: "Alpha", description: "", source: "user", staged: false, available: false },
      { id: "plan", label: "Shadow", description: "", source: "user", staged: false, available: false, reserved: true },
    ],
  };
  assert.deepEqual(model.modeSelectorEntries(catalog).map((entry) => `${entry.source}:${entry.id}`), [
    "builtin:plan",
    "builtin:goal",
    "user:alpha",
    "user:zed",
  ]);
  assert.deepEqual(model.modeSelectorEntries(null), []);
});

test("a stale read never applies to the mode the user switched to", () => {
  const first = model.openModeKey("sisyphus", 1);
  const second = model.openModeKey("sisyphus", 2);
  assert.notEqual(first, second);
  const answer = {
    key: first,
    format: "bundle",
    document: { id: "sisyphus", source: BUNDLE, builtin: false },
  };
  assert.equal(model.openedModeIsCurrent(answer, first), true);
  assert.equal(model.openedModeIsCurrent(answer, second), false);
  assert.equal(model.openedModeIsCurrent(null, first), false);
});

test("one role document round-trips through the fields the tab edits", () => {
  const role = roleDocument.parseRoleDocument(ORACLE);
  assert.equal(role.name, "oracle");
  assert.equal(role.description, "Technical judgment, read-only.");
  assert.deepEqual(role.tools, ["Read", "Grep"]);
  assert.equal(role.inheritTools, false);
  assert.equal(role.model, "anthropic/claude-opus-4");
  assert.equal(role.thinkingLevel, "high");
  assert.deepEqual(role.fallbacks, [
    { model: "openai/gpt-5", thinkingLevel: "medium" },
    // `inherit` is the role's own default, not a level.
    { model: "google/gemini-3", thinkingLevel: "" },
  ]);
  assert.equal(role.body, "Review only. Do not edit files.");
});

test("a role document keeps the frontmatter this tab does not model", () => {
  const withExtra = "---\nname: oracle\ndescription: d\nowner: platform\n---\nBody\n";
  const parsed = roleDocument.parseRoleDocument(withExtra);
  assert.deepEqual(parsed.passthrough, ["owner: platform"]);
  const written = roleDocument.serializeRoleDocument({ ...parsed, description: "changed" });
  assert.match(written, /^---\n/);
  assert.match(written, /\nowner: platform\n/);
  assert.match(written, /description: changed/);
  assert.match(written, /\nBody\n$/);
});

test("a role with no declared model inherits the session and writes no pin", () => {
  const written = roleDocument.serializeRoleDocument({
    ...roleDocument.parseRoleDocument("---\nname: helper\n---\nBody\n"),
    description: "Helps.",
  });
  assert.doesNotMatch(written, /^model:/m);
  assert.doesNotMatch(written, /thinkingLevel/);
  assert.match(written, /tools: \[Read, /);
});

test("role tools keep the canonical order however they were clicked", () => {
  assert.deepEqual(roleDocument.toggleRoleTool(["Read"], "Write", true), ["Read", "Write"]);
  assert.deepEqual(roleDocument.toggleRoleTool(["Read", "Write"], "Read", false), ["Write"]);
});

test("the existing settings model still refuses a taken or reserved id", () => {
  const catalog = {
    directory: "/m",
    diagnostics: [],
    modes: [
      { id: "goal", label: "Goal", description: "", source: "builtin", staged: true, available: true },
      { id: "taken", label: "Taken", description: "", source: "user", staged: false, available: true },
    ],
  };
  assert.equal(settingsModel.newModeIdProblem("goal", catalog), "reserved");
  assert.equal(settingsModel.newModeIdProblem("taken", catalog), "taken");
  assert.equal(settingsModel.newModeIdProblem("fresh", catalog), null);
  assert.equal(settingsModel.newModeIdProblem("Bad Id", catalog), "invalid");
});

test("a saved mode may edit its documents but not change which ones it names", () => {
  const saved = model.bundleDraftFrom({
    source: BUNDLE,
    prompt: "P",
    agents: { "agents/oracle.agent.md": ORACLE },
  });
  // Editing a document's text is free.
  assert.equal(model.bundleReferencesChanged({ ...saved, prompt: "P2" }, saved), false);
  assert.equal(
    model.bundleReferencesChanged(
      { ...saved, agents: { ...saved.agents, "agents/oracle.agent.md": "changed" } },
      saved,
    ),
    false,
  );
  // Repointing the prompt, or adding/removing a role, is refused: the write
  // would leave the old documents behind and take over the new path.
  const repointed = { ...saved, source: model.setBundleScalar(saved.source, "promptFile", "other.md") };
  assert.equal(model.bundleReferencesChanged(repointed, saved), true);
  assert.deepEqual(model.bundleReferenceChange(repointed, saved), { promptFile: true, subagents: false });
  const added = model.putRole(saved, "agents/new.agent.md", "---\nname: new\n---\nB\n");
  assert.equal(model.bundleReferencesChanged(added, saved), true);
  const removed = model.removeRole(saved, "agents/oracle.agent.md");
  assert.equal(model.bundleReferencesChanged(removed, saved), true);
  // A mode that has never been saved has no previous set to keep.
  assert.equal(model.bundleReferencesChanged(added, null), false);
});

test("a new mode cannot be saved without a prompt document to write", () => {
  const draft = model.newBundleDraft({ id: "fresh", prompt: "Work." });
  assert.equal(model.newBundleProblem(draft), null);
  assert.equal(model.newBundleProblem({ ...draft, prompt: "  " }), "noPrompt");
  const noPrompt = { ...draft, source: draft.source.replace(/^promptFile:.*$/m, "") };
  assert.equal(model.newBundleProblem(noPrompt), "noPromptFile");
});
