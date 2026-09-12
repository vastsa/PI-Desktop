import assert from "node:assert/strict";
import { test } from "vitest";
import {
  catalogs,
  en,
  flattenCatalog,
  listedLocales,
  resolveLocale,
  supportedLocales,
  zhCN,
  zhTW,
  ko,
} from "../src/index.ts";

function placeholders(value) {
  return [...value.matchAll(/{{\s*([^},\s]+)[^}]*}}|{([A-Za-z_][A-Za-z0-9_]*)}/g)]
    .map((match) => match[1] ?? match[2])
    .sort();
}

const english = flattenCatalog(en);

test("every shipped catalog matches English keys and interpolation variables", () => {
  for (const [id, catalog] of Object.entries(catalogs)) {
    const flat = flattenCatalog(catalog);
    assert.deepEqual(Object.keys(flat).sort(), Object.keys(english).sort(), id);
    for (const key of Object.keys(english)) {
      assert.deepEqual(placeholders(flat[key]), placeholders(english[key]), `${id} ${key}`);
    }
  }
});

test("canonical thinking levels are not translated catalog entries", () => {
  const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  const effortKeys = [
    "chat.effortOff",
    "chat.effortMinimal",
    "chat.effortLow",
    "chat.effortMid",
    "chat.effortHigh",
    "chat.effortXhigh",
    "chat.effortMax",
  ];

  for (const [id, catalog] of Object.entries(catalogs)) {
    const flat = flattenCatalog(catalog);
    for (const level of levels) {
      assert.equal(flat[`thinkingLevel.${level}`], undefined, `${id} ${level}`);
    }
    for (const key of effortKeys) {
      assert.equal(flat[key], undefined, `${id} ${key}`);
    }
  }
});

test("settings subagent empty-state copy uses a non-conflicting key", () => {
  const chinese = flattenCatalog(zhCN);

  assert.equal(english["settings.subagentsEmpty"], "No subagents of your own yet");
  assert.equal(chinese["settings.subagentsEmpty"], "还没有你自己的子智能体");
  assert.equal(typeof english["settings.subagents"], "string");
  assert.equal(typeof english["extensions.subagents.empty"], "string");
});

test("settings rail labels stay concise and parallel across locales", () => {
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

test("locale resolution maps variants onto shipped catalogs and falls back to English", () => {
  assert.equal(resolveLocale("zh-CN"), "zh-CN");
  assert.equal(resolveLocale("zh-TW"), "zh-TW");
  assert.equal(resolveLocale("zh-Hant"), "zh-TW");
  assert.equal(resolveLocale("zh_Hant_TW"), "zh-TW");
  assert.equal(resolveLocale("zh-HK"), "zh-TW");
  assert.equal(resolveLocale("zh"), "zh-CN");
  assert.equal(resolveLocale("en-US"), "en");
  assert.equal(resolveLocale("tr"), "tr");
  assert.equal(resolveLocale("tr-TR"), "tr");
  assert.equal(resolveLocale("tr_TR"), "tr");
  assert.equal(resolveLocale("es-MX"), "es");
  assert.equal(resolveLocale("fr-CA"), "fr");
  assert.equal(resolveLocale("de-DE"), "de");
  assert.equal(resolveLocale("ko"), "ko");
  assert.equal(resolveLocale("ko-KR"), "ko");
  assert.equal(resolveLocale("ko_KR"), "ko");
  assert.equal(resolveLocale(), "en");
});

test("the locale registry lists English first, then other locales by English name", () => {
  assert.deepEqual(
    supportedLocales.map((locale) => locale.id),
    ["en", "zh-CN", "zh-TW", "de", "es", "tr", "fr", "ko"],
  );
  assert.deepEqual(
    listedLocales().map((locale) => locale.id),
    ["en", "zh-CN", "zh-TW", "fr", "de", "ko", "es", "tr"],
  );
  assert.equal(localeInfoNative("de"), "Deutsch");
  assert.equal(localeInfoNative("es"), "Español");
  assert.equal(localeInfoNative("fr"), "Français");
  assert.equal(localeInfoNative("tr"), "Türkçe");
  assert.equal(localeInfoNative("ko"), "한국어");
  assert.equal(english["settings.languageSearchPlaceholder"], "Search languages…");
  assert.equal(english["settings.themeSearchPlaceholder"], "Search themes…");
  assert.equal(english["settings.languageAutoDesc"], "Currently {{state}}");
  const turkish = flattenCatalog(catalogs.tr);
  const traditional = flattenCatalog(zhTW);
  assert.equal(turkish["settings.language"], "Dil");
  assert.equal(turkish["settings.languageAuto"], "Sistem dilini kullan");
  assert.equal(turkish["settings.languageSearchPlaceholder"], "Dil ara…");
  assert.notEqual(turkish["app.tagline"], english["app.tagline"]);
  assert.equal(traditional["settings.language"], "語言");
  assert.equal(traditional["settings.languageAuto"], "跟隨系統");
  assert.equal(traditional["nav.projects"], "專案");
  assert.equal(traditional["nav.temporarySessions"], "臨時對話");
  assert.match(traditional["app.tagline"], /程式設計/);
  assert.equal(flattenCatalog(catalogs.es)["settings.language"], "Idioma");
  assert.equal(flattenCatalog(catalogs.fr)["settings.language"], "Langue");
  assert.equal(flattenCatalog(catalogs.de)["settings.language"], "Sprache");
  assert.equal(flattenCatalog(ko)["settings.language"], "언어");
  assert.equal(flattenCatalog(ko)["settings.languageAuto"], "시스템 언어 사용");
  assert.equal(flattenCatalog(ko)["nav.projects"], "프로젝트");
  assert.equal(flattenCatalog(ko)["nav.temporarySessions"], "임시 대화");
  assert.notEqual(flattenCatalog(ko)["app.tagline"], english["app.tagline"]);
});

function localeInfoNative(id) {
  return supportedLocales.find((locale) => locale.id === id)?.nativeName;
}

test("inline review cards expose localized accessible labels", () => {
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
