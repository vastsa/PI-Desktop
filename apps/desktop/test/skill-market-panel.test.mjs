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
  assert.match(panel, /assembleSkillInstall\(/);
  assert.match(panel, /level: "global"/);
  assert.match(panel, /scope: GLOBAL_SCOPE/);
  assert.doesNotMatch(panel, /skillImport|writeFile|host\.call\(/);
});

test("install sheet previews the assembled document and blocks oversized bodies", () => {
  assert.match(panel, /settings\.sklm\.willInstall/);
  assert.match(panel, /settings\.sklm\.preview/);
  assert.match(panel, /settings\.sklm\.documentTooLarge/);
  assert.match(panel, /setDocumentBody\(assembled\.body\)/);
  assert.match(panel, /documentTooLarge/);
});

test("installed state comes from matching skill ids", () => {
  assert.match(panel, /installedIds\.includes\(entry\.id\)/);
  assert.match(page, /installedIds=\{\[\.\.\.globalSkills, \.\.\.projectSkills\]/);
});

test("source badges use the catalog sourceId, including default GitHub sources", () => {
  assert.match(panel, /DEFAULT_SKILL_SOURCES, \.\.\.sources/);
  assert.match(panel, /entry\.sourceId \?/);
  assert.doesNotMatch(panel, /remoteIds\.has\(entry\.id\)/);
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
    assert.match(locale, /documentTooLarge: "/);
  }
});

test("builtin catalog keeps the offline promise in English", () => {
  assert.ok(BUILTIN_SKILL_CATALOG.skills.length >= 8);
  const ids = BUILTIN_SKILL_CATALOG.skills.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate catalog ids");
  for (const skill of BUILTIN_SKILL_CATALOG.skills) {
    assert.equal(/[^\u0000-\u007f]/.test(skill.name), false, skill.name);
  }
});

test("preview race gate tokens guard in-flight responses and close invalidates them", () => {
  // Review round 2 (#290): a slow preview A must never land after a faster B,
  // and closing the sheet must invalidate whatever is still in flight.
  assert.match(panel, /previewGate = useRef\(new LatestWinsGate\(\)\)/);
  assert.match(panel, /const token = previewGate\.current\.begin\(\)/);
  assert.match(panel, /previewGate\.current\.isCurrent\(token\)/);
  assert.match(panel, /if \(!installFor\) previewGate\.current\.invalidate\(\)/);
  // A fresh open resets the previous document before the fetch resolves.
  assert.match(panel, /setDocumentBody\(null\)/);
  assert.match(panel, /setDocumentTooLarge\(false\)/);
});
