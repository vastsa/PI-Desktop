import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadStylesSync } from "./helpers/styles.mjs";

const here = new URL(".", import.meta.url);
const read = (path) => readFileSync(fileURLToPath(new URL(path, here)), "utf8");
const settingsPage = read("../src/features/settings/SettingsPage.tsx");
const settingsSearch = read("../src/lib/settings-search.ts");
const modelPage = read("../src/components/settings/ModelConfigPage.tsx");
const skillsPage = read("../src/components/settings/AgentSkillsPage.tsx");
const mcpPage = read("../src/components/settings/AgentMcpPage.tsx");
const modelImport = read("../src/features/settings/imports/ModelConfigImportPanel.tsx");
const skillImport = read("../src/features/settings/imports/AgentSkillImportPanel.tsx");
const mcpImport = read("../src/features/settings/imports/AgentMcpImportPanel.tsx");
const workbench = read("../src/features/settings/import-workbench.tsx");
const styles = loadStylesSync();

function cssRule(selector) {
  const from = styles.indexOf(`\n${selector} {`);
  assert.ok(from >= 0, `${selector} rule missing`);
  return styles.slice(from, styles.indexOf("}", from));
}

test("settings no longer exposes a standalone import or session-import destination", () => {
  assert.doesNotMatch(settingsSearch, /id: "import"/);
  assert.doesNotMatch(settingsPage, /ImportSection|tab === "import"/);
  assert.doesNotMatch(read("../src/features/settings/import-page.tsx"), /SessionImportPanel/);
});

test("model, skills, and MCP imports are available from their own settings pages", () => {
  assert.match(modelPage, /ImportToggleButton/);
  assert.match(modelPage, /<ModelConfigImportPanel \/>/);
  assert.match(modelImport, /api\.scanImportModelConfigs\(\)/);
  assert.match(modelImport, /description=\{t\("settings\.importModelsScanDesc"\)\}/);

  assert.match(skillsPage, /ImportToggleButton/);
  assert.match(skillsPage, /<AgentSkillImportPanel/);
  assert.match(skillsPage, /level=\{targetLevel\}/);
  assert.match(skillImport, /api\.scanExternalSkills\(/);
  assert.match(skillImport, /level,\s*\.\.\./);
  assert.match(skillImport, /description=\{t\("settings\.importAgentSkillsDesc"\)\}/);

  assert.match(mcpPage, /ImportToggleButton/);
  assert.match(mcpPage, /<AgentMcpImportPanel/);
  assert.match(mcpPage, /level=\{targetLevel\}/);
  assert.match(mcpImport, /api\.scanExternalMcp\(/);
  assert.match(mcpImport, /level,\s*\.\.\./);
  assert.match(mcpImport, /description=\{t\("settings\.importAgentMcpDesc"\)\}/);
  assert.match(workbench, /className="import-idle-description"/);
  assert.match(workbench, /<HelpIcon label=\{hint\} \/>/);

  for (const [source, panelId] of [
    [modelPage, "model-config-import-panel"],
    [skillsPage, "agent-skills-import-panel"],
    [mcpPage, "agent-mcp-import-panel"],
  ]) {
    assert.match(source, /onClick=\{\(\) => setImportOpen\(\(current\) => !current\)\}/);
    assert.match(source, new RegExp(`id="${panelId}"`));
    assert.match(source, /hidden=\{!importOpen\}/);
  }
});

test("capability imports follow the selected project and reset when scope changes", () => {
  for (const source of [skillsPage, mcpPage]) {
    assert.match(source, /key=\{`\$\{targetLevel\}:/);
    assert.match(source, /projectPath=\{targetLevel === "project" \? selectedProjectPath/);
    assert.match(source, /disabled=\{targetLevel === "project" && !selectedProjectPath\}/);
  }
  assert.match(skillImport, /level === "project" && projectPath/);
  assert.match(mcpImport, /level === "project" && projectPath/);
});

test("shared inline workbench retains accessible selection and importer controls", () => {
  assert.match(workbench, /<Checkbox/);
  assert.match(workbench, /aria-expanded=\{open\}/);
  assert.match(workbench, /settings\.importSelected/);
  assert.doesNotMatch(workbench, /<input\s+type="checkbox"/);

  assert.match(cssRule(".import-row"), /background:\s*var\(--ds-tile\)/);
  assert.match(cssRule(".import-row:hover"), /var\(--ds-tile-hover\)/);
  assert.match(cssRule(".import-row-title"), /font-size:\s*var\(--text-md\)/);
  assert.match(cssRule(".import-row-meta"), /font-size:\s*var\(--text-2xs\)/);
  assert.match(cssRule(".import-toolbar-actions"), /margin-left:\s*auto/);
});
