import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadStyles } from "./helpers/styles.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "../src");
const settingsDir = join(srcDir, "components/settings");
const read = (path) => readFileSync(join(here, path), "utf8");
const settingsPage = read("../src/pages/SettingsPage.tsx");
const pluginsPage = read("../src/pages/PluginsPage.tsx");
const layout = read("../src/components/settings/AgentCapabilityLayout.tsx");
const skills = read("../src/components/settings/AgentSkillsPage.tsx");
const mcp = read("../src/components/settings/AgentMcpPage.tsx");
const subagents = read("../src/components/settings/AgentSubagentsPage.tsx");
const mcpEditor = read("../src/components/extensions/McpEditorSheet.tsx");
const electron = read("../electron/main/index.ts");
const skillImport = electron.slice(
  electron.indexOf("handle(IPC.invoke.skillImport"),
  electron.indexOf("handle(IPC.invoke.skillUpdate"),
);
const styles = await loadStyles();

// Keep this suite source-oriented like the neighboring desktop contracts: it
// catches IA regressions without requiring an Electron window or a native picker.
test("agent settings have three independent destinations and extensions have two tabs", () => {
  assert.match(settingsPage, /tab === "skills" && <AgentSkillsPage \/>/);
  assert.match(settingsPage, /tab === "mcp" && <AgentMcpPage \/>/);
  assert.match(settingsPage, /tab === "subagents" && <AgentSubagentsPage \/>/);
  assert.match(pluginsPage, /type TabId = "installed" \| "market"/);
  assert.doesNotMatch(pluginsPage, /plugins-(?:tab|panel)-(?:mcp|skills|subagents)/);
});

test("skills and MCP filter one list by level instead of stacking two sections", () => {
  for (const source of [skills, mcp]) {
    assert.match(source, /useAgentProjects\(\)/);
    assert.match(source, /AgentProjectPicker/);
    assert.match(source, /level: "global"/);
    assert.match(source, /level: "project"/);
    // One toolbar, one panel, group headers inside it — not a section per level.
    assert.match(source, /<CapabilityToolbar/);
    assert.match(source, /<CapabilityPanel/);
    assert.match(source, /CapabilityGroupHeader/);
    assert.match(source, /useState<CapabilityFilter>\("all"\)/);
    assert.match(source, /const showGlobal = filter !== "project"/);
    assert.match(source, /const showProject = filter !== "global"/);
  }
  assert.doesNotMatch(layout, /AgentCapabilitySection|AgentCapabilityColumn/);
  assert.match(layout, /agent-capability-list/);
  assert.match(layout, /role="radiogroup"/);
  assert.match(layout, /settings\.capabilityFilterAll/);
  // Subagents are global-only, so they get no level filter and no project.
  assert.doesNotMatch(subagents, /AgentProjectPicker|projectPath|CapabilityFilter/);
  assert.match(subagents, /settings\.globalOnly/);
  assert.match(subagents, /t\("settings\.subagentsEmpty"\)/);
  assert.doesNotMatch(subagents, /settings\.subagents\.empty|t\("subagents\.empty"\)/);
});

test("one search field covers the page and every row carries its level", () => {
  for (const source of [skills, mcp, subagents]) {
    assert.match(source, /matchesCapabilitySearch\(/);
    assert.match(source, /settings\.capabilityNoMatches/);
  }
  assert.match(layout, /agent-capability-search-clear/);
  assert.match(layout, /settings\.clearSearch/);
  for (const source of [skills, mcp]) {
    assert.match(source, /agent-capability-badge is-level/);
  }
  assert.match(styles, /\.agent-capability-badge\.is-level\s*\{/);
});

test("capability lists flow at natural height with skeleton loading", () => {
  assert.doesNotMatch(styles, /\.agent-capability-list\s*\{[^}]*?height:\s*\d+px/);
  assert.match(styles, /\.agent-capability-list\s*\{[\s\S]*?flex-direction:\s*column/);
  assert.match(
    styles,
    /\.agent-capability-row\.is-off \.agent-capability-copy\s*\{[\s\S]*?opacity:/,
  );
  assert.match(layout, /CapabilitySkeleton/);
  assert.match(styles, /\.agent-capability-skeleton-row\s*\{/);
  assert.match(layout, /aria-busy=\{loading \|\| undefined\}/);
  assert.match(layout, /agent-capability-empty/);
});

test("capability surfaces use the shared settings hierarchy", () => {
  assert.match(layout, /AgentCapabilityPage/);
  assert.match(layout, /settings-panel/);
  assert.match(styles, /\.agent-capability-intro-description\s*\{/);
  assert.match(styles, /\.agent-capability-intro-note\s*\{/);
  assert.match(styles, /\.agent-capability-group-label\s*\{[\s\S]*?font-weight:\s*var\(--font-weight-strong\)/);
  assert.match(styles, /\.agent-capability-group-path\s*\{[\s\S]*?font-family:\s*var\(--font-mono\)/);
  assert.doesNotMatch(styles, /\.agent-capability-empty\s*\{[\s\S]*?dashed/);
  assert.match(styles, /\.settings-icon-button\s*\{/);
});

test("the capability toolbar stacks when narrow", () => {
  assert.match(styles, /\.agent-capability-group-label\s*\{[\s\S]*?white-space:\s*nowrap/);
  assert.match(
    styles,
    /@media \(max-width:\s*720px\)[\s\S]*?\.agent-capability-toolbar[\s\S]*?flex-direction:\s*column/,
  );
});

test("a busy row does not lock the page and a refresh does not flash skeletons", () => {
  assert.match(layout, /settings\.capabilityCount/);
  assert.match(layout, /aria-busy=\{busy \|\| undefined\}/);
  assert.match(styles, /\.settings-toggle:focus-visible/);
  for (const source of [skills, mcp, subagents]) {
    // Busy is scoped to the row that is working, never to the whole list.
    assert.match(source, /busy=\{busy/);
    assert.doesNotMatch(source, /disabled=\{loading \|\| busy/);
    // Skeletons are first paint only; later loads dim the rows they already have.
    assert.match(source, /hydrated = useRef\(false\)/);
    assert.match(source, /if \(hydrated\.current\) setRefreshing\(true\)/);
    assert.match(source, /refreshing=\{refreshing\}/);
  }
  assert.match(styles, /\.agent-capability-panel\.is-refreshing \.agent-capability-list\s*\{/);
  assert.match(layout, /settings\.capabilityRefreshing/);
});

test("toggling a capability flips locally and reverts only if the host refuses", () => {
  const cases = [
    [skills, "setUserSkillEnabled"],
    [mcp, "setMcpServerEnabled"],
    [subagents, "setUserSubagentEnabled"],
  ];
  for (const [source, method] of cases) {
    const toggle = source.slice(
      source.indexOf("const toggle = async"),
      source.indexOf("const toggle = async") + 1400,
    );
    assert.notEqual(toggle, "", `${method} toggle should be present`);
    assert.match(toggle, /enabled: next/);
    assert.match(toggle, new RegExp(`api\\.${method}`));
    // Success needs no reload: the local patch already matches what the host did.
    assert.doesNotMatch(toggle.slice(0, toggle.indexOf("catch")), /await load\(\)/);
    assert.match(toggle, /catch[\s\S]*?enabled: (?:skill|server|subagent)\.enabled/);
  }
});

test("each capability page can create, edit, and delete without leaving settings", () => {
  assert.match(skills, /api\.createUserSkill/);
  assert.match(skills, /api\.updateUserSkill/);
  assert.match(skills, /api\.removeUserSkill/);
  assert.match(skills, /api\.revealUserSkill/);
  assert.match(skills, /<SkillEditorSheet/);
  assert.match(subagents, /api\.createUserSubagent/);
  assert.match(subagents, /api\.updateUserSubagent/);
  assert.match(subagents, /api\.removeUserSubagent/);
  assert.match(subagents, /api\.revealSubagent/);
  assert.match(subagents, /<SubagentEditorSheet/);
  assert.match(mcp, /api\.upsertMcpServer/);
  assert.match(mcp, /api\.removeMcpServer/);
  // Destructive row actions arm first and say so before they fire.
  for (const source of [skills, mcp, subagents]) {
    assert.match(source, /useArmedDelete\(\)/);
    assert.match(source, /settings\.capabilityRemoveConfirm/);
    assert.match(source, /danger: true/);
  }
  assert.match(layout, /DELETE_CONFIRM_MS/);
  assert.match(styles, /\.agent-capability-menu button\.danger\s*\{/);
});

test("row actions stay quiet until the row is engaged, but not on touch", () => {
  assert.match(
    styles,
    /\.agent-capability-row-actions > \.settings-icon-button[\s\S]{0,200}?opacity:\s*0;/,
  );
  assert.match(styles, /\.agent-capability-row:hover \.agent-capability-row-actions/);
  assert.match(styles, /\.agent-capability-row:focus-within \.agent-capability-row-actions/);
  assert.match(styles, /\.agent-capability-row\.menu-open \.agent-capability-row-actions/);
  assert.match(styles, /@media \(hover: none\)[\s\S]*?opacity:\s*1/);
});

test("revealing a skill carries the level so project skills resolve", () => {
  const api = read("../src/lib/api.ts");
  assert.match(api, /revealUserSkill:\s*\(id: string, query\?: Partial<AgentCapabilityQuery>\)/);
  assert.match(api, /IPC\.invoke\.skillReveal, \{ id, \.\.\.query \}/);
  const handler = electron.slice(
    electron.indexOf("handle(\n    IPC.invoke.skillReveal"),
    electron.indexOf("handle(IPC.invoke.skillRemove"),
  );
  assert.match(handler, /typeof payload === "string" \? \{ id: payload \} : payload/);
  assert.match(handler, /host\.call<\{ skill: UserSkillRecord \| null \}>\("skills\.read", request\)/);
  assert.match(skills, /api\.revealUserSkill\(skill\.id, levelQuery\(level\)\)/);
});

test("skill import is one native file and is copied through the host", () => {
  assert.notEqual(skillImport, "", "skill import handler should be present");
  assert.match(skillImport, /properties:\s*\["openFile"\]/);
  assert.doesNotMatch(skillImport, /properties:\s*\[[^\]]*(?:multiSelections|openDirectory)/);
  assert.match(skillImport, /host\.call\("skills\.import"/);
  assert.match(read("../../../crates/host-core/src/user_skills.rs"), /fs::copy\(&source_path, &target\)/);
});

test("MCP management reuses the validated modal and blocks same-level duplicates", () => {
  assert.match(mcp, /<McpEditorSheet/);
  assert.match(mcp, /settings\.mcpDuplicate/);
  assert.match(mcpEditor, /role="dialog"/);
  assert.match(mcpEditor, /disabled=\{!!editing\}/);
  assert.match(mcpEditor, /\^\[a-zA-Z\]\[a-zA-Z0-9_-\]\{0,63\}\$/);
  assert.match(mcp, /api\.testMcpServer/);
});

test("capability state stays outside capability files and active merge shadows disabled project rows", () => {
  const capabilities = read("../../../crates/host-core/src/agent_capabilities.rs");
  const mcpRegistry = read("../../../crates/host-core/src/mcp_servers.rs");
  const skillRegistry = read("../../../crates/host-core/src/user_skills.rs");
  assert.match(capabilities, /agent-capabilities/);
  assert.match(mcpRegistry, /\.agents\/servers/);
  assert.match(skillRegistry, /\.agents\/skills/);
  assert.match(mcpRegistry, /existing\.id != record\.id/);
  assert.match(mcpRegistry, /if record\.enabled \{/);
  assert.match(skillRegistry, /existing\.id != record\.id/);
  assert.match(skillRegistry, /if record\.enabled \{/);
});

test("all capability paths are agents roots, not legacy capability directories", () => {
  for (const source of [layout, skills, mcp, subagents, mcpEditor, electron]) {
    assert.doesNotMatch(source, /\.pi\/(?:agents|skills|mcp)/);
  }
});
