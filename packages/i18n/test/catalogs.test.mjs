import assert from "node:assert/strict";
import { test } from "vitest";
import {
  en,
  flattenCatalog,
  resolveLocale,
  zhCN,
} from "../src/index.ts";

function placeholders(value) {
  return [...value.matchAll(/{{\s*([^},\s]+)[^}]*}}/g)]
    .map((match) => match[1])
    .sort();
}

test("shipped catalogs have identical keys and interpolation variables", () => {
  const english = flattenCatalog(en);
  const chinese = flattenCatalog(zhCN);

  assert.deepEqual(Object.keys(chinese).sort(), Object.keys(english).sort());
  for (const key of Object.keys(english)) {
    assert.deepEqual(placeholders(chinese[key]), placeholders(english[key]), key);
  }
});

test("settings subagent empty-state copy uses a non-conflicting key", () => {
  const english = flattenCatalog(en);
  const chinese = flattenCatalog(zhCN);

  assert.equal(english["settings.subagentsEmpty"], "No subagents of your own yet");
  assert.equal(chinese["settings.subagentsEmpty"], "还没有你自己的子智能体");
  assert.equal(typeof english["settings.subagents"], "string");
  assert.equal(typeof english["extensions.subagents.empty"], "string");
});

test("settings rail labels stay concise and parallel across locales", () => {
  const english = flattenCatalog(en);
  const chinese = flattenCatalog(zhCN);
  const keys = [
    "general",
    "ai",
    "shortcuts",
    "instructions",
    "models",
    "skills",
    "mcp",
    "subagents",
    "import",
    "projects",
    "info",
  ].map((key) => `settings.nav.${key}`);

  assert.deepEqual(
    keys.map((key) => english[key]),
    [
      "General",
      "AI",
      "Shortcuts",
      "Instructions",
      "Models",
      "Skills",
      "MCP",
      "Subagents",
      "Import",
      "Projects",
      "Info",
    ],
  );
  assert.deepEqual(
    keys.map((key) => chinese[key]),
    [
      "常规",
      "AI",
      "快捷键",
      "指令",
      "模型",
      "技能",
      "MCP",
      "子智能体",
      "导入",
      "项目",
      "信息",
    ],
  );
  assert.equal(english["settings.groupPreferences"], "Preferences");
  assert.equal(chinese["settings.groupPreferences"], "偏好");
  assert.equal(english["settings.groupSystem"], "System");
  assert.equal(chinese["settings.groupSystem"], "系统");
});

test("import, project, and temporary-session copy is catalog-backed", () => {
  const english = flattenCatalog(en);
  for (const key of [
    "nav.temporarySessions",
    "nav.newTemporarySession",
    "settings.importGroupByPath",
    "settings.importNoProject",
    "settings.importSourceClaudeCode",
    "project.expandDetails",
    "project.openActions",
    "project.sessions",
  ]) {
    assert.equal(typeof english[key], "string", key);
    assert.notEqual(english[key], "");
  }
});

test("locale resolution maps Chinese variants and falls back to English", () => {
  assert.equal(resolveLocale("zh-CN"), "zh-CN");
  assert.equal(resolveLocale("zh-TW"), "zh-CN");
  assert.equal(resolveLocale("en-US"), "en");
  assert.equal(resolveLocale(), "en");
});

test("inline review cards expose localized accessible labels", () => {
  const english = flattenCatalog(en);
  const chinese = flattenCatalog(zhCN);

  assert.equal(
    english["chat.reviewChangeShow"],
    "Show {{status}} changes for {{path}} ({{additions}} additions, {{deletions}} deletions)",
  );
  assert.equal(
    english["chat.reviewChangeHide"],
    "Hide {{status}} changes for {{path}} ({{additions}} additions, {{deletions}} deletions)",
  );
  assert.equal(
    chinese["chat.reviewChangeShow"],
    "显示 {{path}} 的{{status}}改动（新增 {{additions}} 行，删除 {{deletions}} 行）",
  );
  assert.equal(
    chinese["chat.reviewChangeHide"],
    "隐藏 {{path}} 的{{status}}改动（新增 {{additions}} 行，删除 {{deletions}} 行）",
  );
  assert.equal(
    english["chat.reviewChangeCounts"],
    "{{additions}} additions, {{deletions}} deletions",
  );
  assert.equal(
    chinese["chat.reviewChangeCounts"],
    "新增 {{additions}} 行，删除 {{deletions}} 行",
  );
  assert.equal(english["panel.review.filesChanged_one"], "1 file changed");
  assert.equal(
    english["panel.review.filesChanged_other"],
    "{{count}} files changed",
  );
  assert.equal(english["panel.review.changes_one"], "1 recorded change");
  assert.equal(
    chinese["panel.review.rollbackConflict"],
    "该文件在此消息之后又发生了变化，已跳过回退。",
  );
});
