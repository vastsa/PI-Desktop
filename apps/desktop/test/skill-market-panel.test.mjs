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

test("a failed preview is reported instead of silently disabling install", () => {
  // Issue #419: the catch used to reset the body and say nothing, so the
  // install button sat disabled behind the word "Loading…" with no reason and
  // no way to try again. The preview-before-save gate itself is intentional and
  // stays — what changes is that a failure is now legible and recoverable.
  assert.match(panel, /setPreviewFailure\(\{/);
  assert.match(panel, /kind: classifySkillMarketFailure\(error\)/);
  assert.match(panel, /detail: skillMarketFailureDetail\(error\)/);
  assert.match(panel, /settings\.sklm\.previewError/);
  assert.match(panel, /settings\.sklm\.previewPolicyError/);
  assert.match(panel, /settings\.sklm\.proxyHint/);
  assert.match(panel, /settings\.sklm\.failureDetail/);
  assert.match(panel, /settings\.sklm\.retryPreview/);
  assert.match(panel, /role="alert"/);
  assert.match(panel, /disabled=\{installing \|\| documentBody === null \|\| documentTooLarge\}/);
  assert.match(panel, /const retryPreview = \(\) => \{/);
  assert.match(panel, /if \(installFor\) loadDocument\(installFor\)/);
});

test("the market list explains a policy refusal instead of a bare unreachable", () => {
  assert.match(panel, /hasPolicyFailure\(remote\.failureKinds\)/);
  assert.match(panel, /settings\.sklm\.remoteErrorPolicy/);
  assert.match(panel, /settings\.sklm\.remoteErrorQuery/);
  // A partial outage (some sources up, some refused) used to say nothing at all.
  assert.match(panel, /remote\.status === "ready" && remote\.failed\.length/);
  assert.match(panel, /settings\.sklm\.remotePartial/);
  assert.match(panel, /failureKinds: result\.failureKinds \?\? \{\}/);
  // The whole-query rejection used to be discarded with no trace at all.
  assert.match(panel, /queryError: skillMarketFailureDetail\(error\)/);
});

test("every shipped locale carries the new skill market strings", async () => {
  const { readFile } = await import("node:fs/promises");
  const ids = ["en", "zh-CN", "zh-TW", "de", "es", "fr", "ko", "tr"];
  const keys = [
    "previewError",
    "previewPolicyError",
    "proxyHint",
    "failureDetail",
    "retryPreview",
    "remoteErrorPolicy",
    "remoteErrorQuery",
    "remotePartial",
  ];
  for (const id of ids) {
    const locale = await readFile(
      new URL(`../../../packages/i18n/src/locales/${id}/index.ts`, import.meta.url),
      "utf8",
    );
    for (const key of keys) {
      assert.match(locale, new RegExp(`${key}: "`), `${id} ${key}`);
    }
  }
});
