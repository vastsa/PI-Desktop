import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const [chatSurface, en, zh] = await Promise.all([
  read("../src/components/ChatSurface.tsx"),
  read("../../../packages/i18n/src/locales/en/index.ts"),
  read("../../../packages/i18n/src/locales/zh-CN/index.ts"),
]);

test("temporary empty home has a distinct session state without project actions", () => {
  assert.match(chatSurface, /activeSessionId[\s\S]*sessions\.find/);
  assert.match(
    chatSurface,
    /const isTemporarySession = Boolean\([\s\S]*!activeSession\.projectPath\?\.trim\(\)/,
  );
  assert.match(chatSurface, /data-home-session-kind/);
  assert.match(chatSurface, /t\("chat\.emptyTitleTemporary"\)/);
  assert.match(chatSurface, /"chat\.emptySubtitleTemporary"/);
  assert.match(
    chatSurface,
    /heroProject \? \([\s\S]*?\) : isTemporarySession \? \([\s\S]*?emptyTitleTemporary/,
  );
  assert.match(en, /emptyTitleTemporary:/);
  assert.match(en, /emptySubtitleTemporary:/);
  assert.match(zh, /emptyTitleTemporary:/);
  assert.match(zh, /emptySubtitleTemporary:/);
});
