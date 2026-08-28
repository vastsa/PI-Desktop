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

test("composer cycles view-specific welcome and slash-command placeholders", () => {
  assert.match(composer, /PLACEHOLDER_CAROUSEL_INTERVAL_MS = 4_000/);
  assert.match(
    composer,
    /variant === "home"[\s\S]*?"chat\.placeholderHome"[\s\S]*?"chat\.placeholderHomeHint"[\s\S]*?"chat\.placeholder"[\s\S]*?"chat\.placeholderHint"/,
  );
  assert.match(composer, /window\.setInterval\([\s\S]*PLACEHOLDER_CAROUSEL_INTERVAL_MS/);
  assert.match(composer, /window\.clearInterval\(timer\)/);
  assert.match(composer, /placeholder=\{placeholderText\}/);
  assert.match(composer, /className="composer-placeholder"/);
  assert.match(composer, /value\.length > 0/);
  assert.match(composer, /activeChipFileReferences\.length > 0/);
  assert.match(composer, /activeInlineFileReferences\.length > 0/);
  assert.match(composer, /composing/);
  assert.match(composer, /inputFocused/);
  assert.match(composer, /placeholderFocusPauseReleasedRef/);
});

test("placeholder changes fade without duplicating the native accessible value", () => {
  assert.match(composerStyles, /\.composer-input-stage\s*\{/);
  assert.match(composerStyles, /\.composer-placeholder\s*\{/);
  // Home and docked composers use the same input/placeholder alignment; only
  // the localized copy changes between the two variants.
  assert.doesNotMatch(composer, /composer-input-home/);
  assert.doesNotMatch(composerStyles, /composer-input-home/);
  assert.match(composerStyles, /animation:\s*composer-placeholder-fade-in/);
  assert.match(composerStyles, /@keyframes composer-placeholder-fade-in/);
  assert.match(composerStyles, /opacity:\s*0\s*!important/);
});

test("both shipped locales provide the welcome and slash-command pairs", () => {
  assert.match(english, /placeholderHint:\s*"Type \/ to invoke a command"/);
  assert.match(english, /placeholderHomeHint:\s*"Type \/ to invoke a command"/);
  assert.match(chinese, /placeholderHint:\s*"输入 \/ 调用命令"/);
  assert.match(chinese, /placeholderHomeHint:\s*"输入 \/ 调用命令"/);
});

test("the slash hint keeps the core session command aliases available", () => {
  for (const alias of ["new", "compact", "agent-mode", "plan-mode", "goal-mode"]) {
    assert.match(builtinCommands, new RegExp(`slash: "${alias}"`), alias);
  }
});
