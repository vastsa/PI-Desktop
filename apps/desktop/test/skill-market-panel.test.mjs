import { readFile } from "node:fs/promises";
import test from "node:test";
import assert from "node:assert/strict";
import { BUILTIN_SKILL_CATALOG } from "../../../packages/shared/dist/index.js";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const [panel, page, en, zh] = await Promise.all([
  read("../src/components/settings/SkillMarketPanel.tsx"),
  read("../src/components/settings/AgentSkillsPage.tsx"),
  read("../../../packages/i18n/src/locales/en/index.ts"),
  read("../../../packages/i18n/src/locales/zh-CN/index.ts"),
]);

test("skill market installs through the existing create path only", () => {
  assert.match(panel, /api\.fetchSkillMarketDocument\(/);
  assert.match(panel, /api\.createUserSkill\(/);
  assert.match(panel, /level: "global"/);
  assert.match(panel, /scope: GLOBAL_SCOPE/);
  // No other write path may appear.
  assert.doesNotMatch(panel, /skillImport|writeFile|host\.call\(/);
});

test("install sheet previews the full document before saving", () => {
  assert.match(panel, /settings\.sklm\.willInstall/);
  assert.match(panel, /settings\.sklm\.preview/);
  assert.match(panel, /fetchSkillMarketDocument/);
});

test("installed state comes from matching skill ids", () => {
  assert.match(panel, /installedIds\.includes\(entry\.id\)/);
  assert.match(page, /installedIds=\{\[\.\.\.globalSkills, \.\.\.projectSkills\]/);
});

test("skills page wires the market view with reload on exit", () => {
  assert.match(page, /view === "market"/);
  assert.match(page, /setView\("skills"\);\s*\n\s*void load\(\)/);
  assert.match(page, /<SkillMarketPanel/);
});

test("skill market strings exist in en and zh-CN", () => {
  for (const locale of [en, zh]) {
    assert.match(locale, /sklm: \{/);
    assert.match(locale, /browse: "/);
    assert.match(locale, /installSuccess: "/);
  }
});

test("builtin catalog keeps the offline promise", () => {
  assert.ok(BUILTIN_SKILL_CATALOG.skills.length >= 15);
  const ids = BUILTIN_SKILL_CATALOG.skills.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate catalog ids");
});
