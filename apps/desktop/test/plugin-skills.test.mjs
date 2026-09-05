import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(here, "..");
const repoRoot = join(desktopRoot, "../..");

const runtimeSrc = readFileSync(join(desktopRoot, "electron/main/plugin-runtime.ts"), "utf8");
const builtinSrc = readFileSync(join(desktopRoot, "electron/main/builtin-skills.ts"), "utf8");
const devToolsSrc = readFileSync(join(desktopRoot, "electron/main/plugin-dev-tools.ts"), "utf8");
const mainSrc = readFileSync(join(desktopRoot, "electron/main/index.ts"), "utf8");
const packageJson = JSON.parse(readFileSync(join(desktopRoot, "package.json"), "utf8"));
const skillDoc = readFileSync(
  join(desktopRoot, "resources/skills/plugin-development.md"),
  "utf8",
);
const a2aSkillDoc = readFileSync(
  join(desktopRoot, "resources/skills/a2a-cross-conversation.md"),
  "utf8",
);
const agentRuntimeSrc = readFileSync(
  join(repoRoot, "packages/agent-runtime/src/runtime.ts"),
  "utf8",
);
const sidecarSrc = readFileSync(join(repoRoot, "packages/agent-runtime/src/sidecar.ts"), "utf8");

test("the plugin runtime indexes contributed skills under caps", () => {
  assert.match(runtimeSrc, /registerSkills/);
  assert.match(runtimeSrc, /getSkills\(\)/);
  assert.match(runtimeSrc, /MAX_SKILLS_PER_PLUGIN = 32/);
  assert.match(runtimeSrc, /MAX_SKILL_BYTES = 128 \* 1024/);
  assert.match(runtimeSrc, /MAX_SKILL_DESCRIPTION_CHARS/);
  // Contributed paths must stay inside the plugin directory.
  assert.match(runtimeSrc, /resolveInsidePlugin/);
});

test("skills only reach the agent with agent.prompt.inject", () => {
  const gate = /permissions\.has\("agent\.prompt\.inject"\)/;
  assert.match(runtimeSrc, gate);
  const registerSkills = runtimeSrc.slice(runtimeSrc.indexOf("private registerSkills"));
  assert.match(registerSkills, gate);
  assert.match(registerSkills, /plugin\.skills\.skipped/);
});

test("unloading a plugin withdraws its skills", () => {
  const clear = runtimeSrc.slice(
    runtimeSrc.indexOf("private clearContributions"),
    runtimeSrc.indexOf("private registerSkills"),
  );
  assert.match(clear, /this\.skills/);
});

test("loading a skill body strips front matter and re-checks the cap", () => {
  const load = runtimeSrc.slice(
    runtimeSrc.indexOf("loadSkillBody("),
    runtimeSrc.indexOf("registerSkills"),
  );
  assert.match(load, /parseSkillFrontmatter/);
  assert.match(load, /MAX_SKILL_BYTES/);
  assert.match(load, /NOT_FOUND/);
  assert.match(load, /plugin\.skill\.load/);
});

test("a reloaded plugin re-indexes its skills, so an edit needs no restart", () => {
  // Hot reload runs unload/load; the catalog must be rebuilt from disk there,
  // and the body is read on every Skill call regardless.
  assert.match(runtimeSrc, /this\.registerSkills\(loaded\)/);
  assert.match(runtimeSrc.slice(runtimeSrc.indexOf("loadSkillBody(")), /readFileSync\(skill\.path/);
});

test("main forwards the skill catalog and serves the Skill tool locally", () => {
  assert.match(mainSrc, /const pluginSkills = \[/);
  assert.match(mainSrc, /\.\.\.plugins\s*\n?\s*\.getSkills\(\)/);
  assert.match(mainSrc, /\n\s+pluginSkills,\n/);
  assert.match(mainSrc, /setLocalTool\("Skill"/);
  assert.match(mainSrc, /loadSkillBody\(id\)/);
});

test("the agent runtime advertises skills and rebuilds when the catalog changes", () => {
  assert.match(agentRuntimeSrc, /pluginSkillsPrompt/);
  assert.match(agentRuntimeSrc, /SKILL_TOOL_NAME/);
  assert.match(agentRuntimeSrc, /pluginSkillsDigest/);
  assert.match(sidecarSrc, /pluginSkills/);
});

test("the built-in plugin skill only activates for plugin workspaces", () => {
  assert.match(builtinSrc, /isPluginWorkspace/);
  assert.match(builtinSrc, /schemaVersion.*number/s);
  assert.match(builtinSrc, /pluginPaths\.some/);
  assert.match(builtinSrc, /if \(isPluginWorkspace\(input.workspacePath, input.pluginPaths\)\)/);
  assert.doesNotMatch(
    builtinSrc,
    /if \(!isPluginWorkspace\(input.workspacePath, input.pluginPaths\)\) return \[\]/,
  );
  assert.match(mainSrc, /builtinSkills\(\{/);
});

test("the built-in A2A skill is always catalogued", () => {
  assert.match(builtinSrc, /A2A_CROSS_CONVERSATION_SKILL_ID = "pi-desktop\/a2a-cross-conversation"/);
  assert.match(builtinSrc, /a2a-cross-conversation.md/);
  assert.match(a2aSkillDoc, /^---\n/);
  assert.match(a2aSkillDoc, /description: /);
  for (const token of [
    "A2A(action=\"discover\")",
    "parent-2",
    "contextId",
    "session UUID",
  ]) {
    assert.ok(a2aSkillDoc.includes(token), `A2A skill must mention ${token}`);
  }
});

test("the built-in skill body loads through the same Skill tool", () => {
  // Host-owned skills are not in any registry, so main tries them first, then
  // the user's own skills, then a plugin's — bare ids cannot collide with the
  // `<pluginId>/<skillId>` form.
  assert.match(builtinSrc, /export function loadBuiltinSkillBody/);
  assert.match(
    mainSrc,
    /loadBuiltinSkillBody\(id\) \?\?\s*\(await loadUserSkillBody\(id, projectPath\)\) \?\?\s*plugins\.loadSkillBody\(id\)/,
  );
  assert.match(mainSrc, /const userIds = \(await activeUserSkills/);
});

test("the built-in skill ships as a packaged resource with a dev fallback", () => {
  const resources = packageJson.build.extraResources.map((entry) => entry.to);
  assert.ok(resources.includes("skills"), "resources/skills must be packaged");
  assert.match(builtinSrc, /process\.resourcesPath/);
  assert.match(builtinSrc, /resources\/skills/);
});

test("the built-in skill documents the constraints a plugin author will hit", () => {
  assert.match(skillDoc, /^---\n/);
  assert.match(skillDoc, /description: /);
  for (const token of [
    "PluginScaffold",
    "PluginCheck",
    "PluginPack",
    "agent.prompt.inject",
    "store-only",
    "schemaVersion",
    "pi.commands.register",
    "window.pluginBridge",
  ]) {
    assert.ok(skillDoc.includes(token), `built-in skill must mention ${token}`);
  }
  assert.doesNotMatch(skillDoc, /onLoad\(pi\)|pi\.registerCommand/);
});

test("plugin dev tools resolve paths inside the workspace and report failures", () => {
  assert.match(devToolsSrc, /resolveWithinRoot\(root, value\)/);
  assert.match(devToolsSrc, /no workspace is open/);
  assert.match(devToolsSrc, /isError: true/);
  // Scaffolding loads the plugin so the first edit is already a hot reload.
  assert.match(devToolsSrc, /registerDevPlugin\(target\.path\)/);
  assert.match(devToolsSrc, /loadPlugin\(target\.path, permissions\)/);
});

test("only PluginCheck is available outside agent mode", () => {
  const builderEnd = agentRuntimeSrc.indexOf(
    "const builtins = tools.map(exec)",
  );
  const builderStart = agentRuntimeSrc.lastIndexOf("const tools =", builderEnd);
  assert.ok(builderStart >= 0 && builderEnd > builderStart);
  const builder = agentRuntimeSrc.slice(builderStart, builderEnd);
  const agentBranchStart = builder.indexOf('if (this.mode === "agent")');
  assert.ok(agentBranchStart >= 0);
  const nonAgentBranch = builder.slice(0, agentBranchStart);
  assert.match(nonAgentBranch, /"PluginCheck"/);
  assert.doesNotMatch(nonAgentBranch, /PluginScaffold|PluginPack/);
  assert.match(
    builder.slice(agentBranchStart),
    /tools\.push\("PluginScaffold", "PluginPack"\)/,
  );
});

test("main registers the three plugin dev tools as local tools", () => {
  assert.match(mainSrc, /registerPluginDevTools\(s, \{/);
  for (const name of ["PluginScaffold", "PluginCheck", "PluginPack"]) {
    assert.ok(
      devToolsSrc.includes(`setLocalTool("${name}"`),
      `${name} must be served by main, not host-core`,
    );
  }
});
