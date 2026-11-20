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
  ptBR,
} from "../src/index.ts";

function placeholders(value) {
  return [...value.matchAll(/{{\s*([^},\s]+)[^}]*}}|{([A-Za-z_][A-Za-z0-9_]*)}/g)]
    .map((match) => match[1] ?? match[2])
    .sort();
}

const english = flattenCatalog(en);

test("offline storage maintenance has localized progress and recovery copy before renderer startup", () => {
  const fields = ["progressTitle", "progressHint", "failedTitle", "failedHint", "continueOriginal", "unavailableHint"];
  const stages = ["scanning", "copying", "verifying", "relocating", "cleaning", "complete", "failed"];
  for (const [locale, catalog] of Object.entries(catalogs)) {
    const copy = catalog.settings.storage;
    for (const field of fields) {
      assert.equal(typeof copy[field], "string", `${locale}: ${field}`);
      assert.ok(copy[field].trim(), `${locale}: ${field} must not be blank`);
    }
    assert.deepEqual(Object.keys(copy.stages).sort(), [...stages].sort(), locale);
    for (const stage of stages) assert.ok(copy.stages[stage].trim(), `${locale}: ${stage}`);
    if (locale !== "en") {
      assert.notEqual(copy.progressTitle, en.settings.storage.progressTitle, locale);
      assert.notEqual(copy.failedHint, en.settings.storage.failedHint, locale);
      assert.notEqual(copy.unavailableHint, en.settings.storage.unavailableHint, locale);
    }
  }
});

test("every shipped catalog matches English keys and interpolation variables", () => {
  const PLURAL_SUFFIX = /_(one|other|few|many|zero)$/;
  const pluralBase = (key) => key.replace(PLURAL_SUFFIX, "");
  const englishKeys = new Set(Object.keys(english));

  for (const [id, catalog] of Object.entries(catalogs)) {
    const flat = flattenCatalog(catalog);
    const localeKeys = new Set(Object.keys(flat));

    // Every English key must exist in the locale.
    for (const key of englishKeys) {
      assert.ok(localeKeys.has(key), `${id} is missing ${key}`);
    }

    // Extra keys are allowed only as plural variants of an English family:
    // Russian CLDR needs `_few`/`_many`, which English does not ship.
    for (const key of localeKeys) {
      if (englishKeys.has(key)) continue;
      const match = key.match(/^(.*)_(few|many|zero)$/);
      assert.ok(match, `${id} has unexpected key ${key}`);
      const base = match[1];
      assert.ok(
        englishKeys.has(`${base}_one`) ||
          englishKeys.has(`${base}_other`) ||
          englishKeys.has(base),
        `${id} ${key} extends ${base}, which English does not pluralize`,
      );
    }

    for (const key of englishKeys) {
      const expected = placeholders(english[key]);
      const actual = placeholders(flat[key]);
      if (PLURAL_SUFFIX.test(key)) {
        // A plural form may add {{count}} — ru `_one` fires for 21, 31, …
        // where English hardcodes the numeral — but must keep every English
        // variable and may add nothing else.
        for (const name of expected) {
          assert.ok(actual.includes(name), `${id} ${key} dropped {{${name}}}`);
        }
        for (const name of actual) {
          assert.ok(
            name === "count" || expected.includes(name),
            `${id} ${key} added {{${name}}}`,
          );
        }
      } else {
        assert.deepEqual(actual, expected, `${id} ${key}`);
      }
    }

    // Extra plural forms interpolate exactly like the English `_other` form.
    for (const key of localeKeys) {
      if (englishKeys.has(key)) continue;
      const base = pluralBase(key);
      const reference =
        english[`${base}_other`] ?? english[`${base}_one`] ?? english[base];
      assert.deepEqual(placeholders(flat[key]), placeholders(reference), `${id} ${key}`);
    }
  }
});

test("every locale resolves each English plural family without falling back to English", () => {
  // For every English plural family and every count a shipped locale's CLDR
  // rules route to a category, the locale must define that form (or the bare
  // key that i18next tries next) — otherwise i18next leaks the English text.
  const families = new Set();
  for (const key of Object.keys(english)) {
    const match = key.match(/^(.*)_(one|other)$/);
    if (match) families.add(match[1]);
    else if (english[`${key}_other`] !== undefined) families.add(key);
  }
  const sampleCounts = [0, 1, 2, 5, 21, 101, 1.5];

  for (const [id] of Object.entries(catalogs)) {
    const flat = flattenCatalog(catalogs[id]);
    const rules = new Intl.PluralRules(id);
    for (const family of families) {
      for (const count of sampleCounts) {
        const category = rules.select(count);
        const resolved =
          flat[`${family}_${category}`] !== undefined
            ? `${family}_${category}`
            : flat[family] !== undefined
              ? family
              : null;
        assert.ok(
          resolved,
          `${id}: ${family} cannot resolve count ${count} (${category}) inside the locale`,
        );
      }
    }
  }
});

test("Live Voice preparation and call recovery copy is localized in every shipped catalog", () => {
  const keys = [
    "prepareCall", "details", "workOptions", "allowWork", "noWorkSession",
    "playbackBlocked", "playbackFailed", "mediaReleaseUnconfirmed",
    "callActionFailed", "workNotConnected", "transcript", "transcriptEmpty",
    "userSpeaking", "assistantSpeaking", "muted", "resumePlayback",
    "selectWorkSession", "shareContext", "contextShared",
    "contextNotShared", "createWorkSession", "viewWorkSession", "enableDetail",
    "microphoneDenied", "microphoneUnavailable", "microphoneBusy",
    "phase.connecting", "phase.closing",
  ].map((key) => `liveVoice.${key}`);

  for (const [id, catalog] of Object.entries(catalogs)) {
    const flat = flattenCatalog(catalog);
    for (const key of keys) {
      assert.equal(typeof flat[key], "string", `${id} ${key}`);
      assert.notEqual(flat[key].trim(), "", `${id} ${key}`);
      if (id !== "en") assert.notEqual(flat[key], english[key], `${id} ${key} must not fall back to English`);
    }
  }

  assert.match(english["liveVoice.enableDetail"], /current Composer session as the default work target/);
  assert.match(english["liveVoice.enableDetail"], /switch sessions by voice/);
});

test("MCP OAuth no-DCR recovery guidance is localized in every shipped catalog", () => {
  const key = "extensions.mcp.authDcrUnavailable";
  for (const [id, catalog] of Object.entries(catalogs)) {
    const value = flattenCatalog(catalog)[key];
    assert.equal(typeof value, "string", `${id} ${key}`);
    assert.notEqual(value.trim(), "", `${id} ${key}`);
    if (id !== "en") assert.notEqual(value, english[key], `${id} ${key} must not fall back to English`);
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

test("creation-phase delegation copy is catalog-backed", () => {
  assert.equal(english["chat.subagentCreating"], "Starting subagent…");
  assert.equal(
    flattenCatalog(zhCN)["chat.subagentCreating"],
    "正在创建子智能体…",
  );
  for (const [id, catalog] of Object.entries(catalogs)) {
    assert.equal(
      typeof flattenCatalog(catalog)["chat.subagentCreating"],
      "string",
      id,
    );
  }
});

test("settings rail labels stay concise and parallel across locales", () => {
  const chinese = flattenCatalog(zhCN);
  const keys = [
    "appearance",
    "chat",
    "shortcuts",
    "voice",
    "behavior",
    "models",
    "instructions",
    "skills",
    "mcp",
    "subagents",
    "projects",
    "system",
    "sync",
    "remoteHosts",
    "info",
  ].map((key) => `settings.nav.${key}`);

  assert.deepEqual(
    keys.map((key) => english[key]),
    [
      "Appearance",
      "Conversation",
      "Shortcuts",
      "Voice",
      "Behavior",
      "Models",
      "Instructions",
      "Skills",
      "MCP",
      "Subagents",
      "Projects",
      "System",
      "Cloud sync",
      "Remote hosts",
      "Info",
    ],
  );
  assert.deepEqual(
    keys.map((key) => chinese[key]),
    [
      "外观",
      "对话",
      "快捷键",
      "语音",
      "行为",
      "模型",
      "指令",
      "技能",
      "MCP",
      "子智能体",
      "项目",
      "系统",
      "云同步",
      "远程主机",
      "信息",
    ],
  );
  for (const [id, catalog] of Object.entries(catalogs)) {
    const flat = flattenCatalog(catalog);
    for (const key of keys) {
      assert.equal(typeof flat[key], "string", `${id} ${key}`);
      assert.ok(flat[key].trim(), `${id} ${key} must not be blank`);
    }
    for (const retired of ["general", "ai", "import"]) {
      assert.equal(flat[`settings.nav.${retired}`], undefined, `${id} ${retired}`);
    }
  }
  assert.equal(english["settings.import"], undefined);
  assert.equal(chinese["settings.import"], undefined);
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
    "project.selectProject",
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
  assert.equal(resolveLocale("pt"), "pt-BR");
  assert.equal(resolveLocale("pt-BR"), "pt-BR");
  assert.equal(resolveLocale("pt_BR"), "pt-BR");
  assert.equal(resolveLocale("pt-PT"), "pt-BR");
  assert.equal(resolveLocale(), "en");
});

test("the locale registry lists English first, then other locales by English name", () => {
  assert.deepEqual(
    supportedLocales.map((locale) => locale.id),
    ["en", "zh-CN", "zh-TW", "de", "es", "tr", "fr", "ko", "pt-BR", "ru"],
  );
  assert.deepEqual(
    listedLocales().map((locale) => locale.id),
    ["en", "zh-CN", "zh-TW", "fr", "de", "ko", "pt-BR", "ru", "es", "tr"],
  );
  assert.equal(localeInfoNative("de"), "Deutsch");
  assert.equal(localeInfoNative("es"), "Español");
  assert.equal(localeInfoNative("fr"), "Français");
  assert.equal(localeInfoNative("tr"), "Türkçe");
  assert.equal(localeInfoNative("ko"), "한국어");
  assert.equal(localeInfoNative("pt-BR"), "Português (Brasil)");
  assert.equal(localeInfoNative("ru"), "Русский");
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
  const brazilian = flattenCatalog(catalogs["pt-BR"]);
  assert.equal(brazilian["settings.language"], "Idioma");
  assert.equal(brazilian["settings.languageAuto"], "Usar idioma do sistema");
  assert.equal(brazilian["nav.projects"], "Projetos");
  assert.equal(brazilian["nav.temporarySessions"], "Conversas temporárias");
  assert.notEqual(brazilian["app.tagline"], english["app.tagline"]);
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
