import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const [composer, composerStyles, english, chinese, builtinCommands] =
  await Promise.all([
    read("../src/components/Composer.tsx"),
    read("../src/styles/composer.css"),
    read("../../../packages/i18n/src/locales/en/index.ts"),
    read("../../../packages/i18n/src/locales/zh-CN/index.ts"),
    read("../electron/main/builtin-commands.ts"),
  ]);

test("composer keeps placeholder guidance stable within a page and session", () => {
  assert.doesNotMatch(composer, /PLACEHOLDER_CAROUSEL_INTERVAL_MS/);
  assert.doesNotMatch(composer, /window\.setInterval/);
  assert.doesNotMatch(composer, /placeholderPaused|placeholderFocusPauseReleasedRef/);
  assert.match(composer, /PLACEHOLDER_KEYS =/);
  assert.match(composer, /chat\.placeholderShortcut/);
  assert.match(composer, /placeholderContextRef/);
  assert.match(composer, /activeSessionId \?\? HOME_DRAFT_KEY/);
  assert.match(composer, /setPlaceholderIndex/);
  assert.match(composer, /\}, \[activeSessionId, variant\]\);/);
  assert.match(composer, /placeholder=\{placeholderText\}/);
  assert.match(composer, /className="composer-placeholder"/);
});

test("placeholder changes fade without duplicating the native accessible value", () => {
  assert.match(composerStyles, /\.composer-input-stage\s*\{/);
  assert.match(composerStyles, /\.composer-placeholder\s*\{/);
  assert.match(composerStyles, /animation:\s*composer-placeholder-fade-in/);
  assert.match(composerStyles, /@keyframes composer-placeholder-fade-in/);
  assert.match(composerStyles, /opacity:\s*0\s*!important/);
});

test("both shipped locales provide welcome, command, file, and shortcut guidance", () => {
  assert.match(english, /placeholderHint:\s*"Type \/ for commands · @ for files"/);
  assert.match(english, /placeholderHomeHint:\s*"Type \/ for commands · @ for files"/);
  assert.match(english, /placeholderShortcut:\s*"Shift\+Enter for newline · Use Send to submit"/);
  assert.match(chinese, /placeholderHint:\s*"输入 \/ 使用命令 · @ 引用文件"/);
  assert.match(chinese, /placeholderHomeHint:\s*"输入 \/ 使用命令 · @ 引用文件"/);
  assert.match(chinese, /placeholderShortcut:\s*"Shift\+Enter 换行 · 点击发送提交"/);
});

test("the slash hint keeps the core session command aliases available", () => {
  for (const alias of ["new", "compact", "agent-mode", "plan-mode", "goal-mode"]) {
    assert.match(builtinCommands, new RegExp(`slash: "${alias}"`), alias);
  }
});
