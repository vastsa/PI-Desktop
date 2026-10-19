import { readMainSource } from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (relativePath) =>
  readFile(new URL(relativePath, import.meta.url), "utf8");

const [protocolSource, apiSource, mainSource, sidebarSource, english, chinese] =
  await Promise.all([
    read("../../../packages/shared/src/protocol.ts"),
    read("../src/lib/api.ts"),
    readMainSource(),
    read("../src/components/Sidebar.tsx"),
    read("../../../packages/i18n/src/locales/en/index.ts"),
    read("../../../packages/i18n/src/locales/zh-CN/index.ts"),
  ]);

test("open session path is a session-id IPC action, not an arbitrary folder", () => {
  assert.match(
    protocolSource,
    /sessionOpenScratchPath:\s*"pi-desktop\/session\/openScratchPath"/,
  );
  assert.match(
    apiSource,
    /openSessionScratchPath:\s*\(sessionId: string\)[\s\S]*?IPC\.invoke\.sessionOpenScratchPath,[\s\S]*?sessionId/,
  );
  assert.doesNotMatch(protocolSource, /sessionOpenFolder/);
  assert.doesNotMatch(apiSource, /openSessionFolder/);
});

test("main opens only a resolved session scratch directory", () => {
  const start = mainSource.indexOf("handle(IPC.invoke.sessionOpenScratchPath");
  const end = mainSource.indexOf("handle(", start + 1);
  const handler = mainSource.slice(start, end);

  assert.ok(start >= 0 && end > start, "session open-scratch handler should exist");
  assert.match(handler, /host\.call<\{ path: string \}>\("session\.getScratchPath"/);
  assert.match(handler, /relative\(scratchRoot, scratchPath\)/);
  assert.match(handler, /ErrorCodes\.INVALID_ARGUMENT/);
  assert.match(handler, /mkdirSync\(scratchPath, \{ recursive: true \}\)/);
  assert.match(handler, /shell\.openPath\(stripWinLongPrefix\(scratchPath\)\)/);
  assert.match(handler, /return \{ ok: true, path: scratchPath \}/);
  assert.doesNotMatch(handler, /input\.path/);
});

test("session Copy menu exposes id, scratch path, and link", () => {
  assert.match(sidebarSource, /sidebarMenuSubmenu\(\{[\s\S]*?id: "session-copy"/);
  assert.match(sidebarSource, /id: "copy-conversation-id"/);
  assert.match(sidebarSource, /id: "copy-session-path"/);
  assert.match(sidebarSource, /api\.getSessionScratchPath\(session\.id\)/);
  assert.match(sidebarSource, /if \(isRemoteSession\(session\)\) return/);
  assert.match(sidebarSource, /id: "copy-session-link"/);
  assert.match(sidebarSource, /formatSessionLink\(session\.id\)/);
  assert.match(sidebarSource, /navigator\.clipboard\.writeText\(value\)/);

  const developerActions = sidebarSource.slice(
    sidebarSource.indexOf("settings?.developerMode === true"),
    sidebarSource.indexOf('id: "session-danger"'),
  );
  assert.match(developerActions, /id: "open-session-path"/);
  assert.doesNotMatch(developerActions, /copy-conversation-id|copy-session-path/);
});

test("session and project copy labels are localized", () => {
  assert.match(english, /copyConversationId:\s*"Copy conversation ID"/);
  assert.match(english, /copySessionPath:\s*"Copy session path"/);
  assert.match(english, /copySessionLink:\s*"Copy conversation link"/);
  assert.match(english, /copyName:\s*"Copy project name"/);
  assert.match(english, /copyPath:\s*"Copy project path"/);
  assert.match(chinese, /copyConversationId:\s*"复制对话 ID"/);
  assert.match(chinese, /copySessionPath:\s*"复制会话路径"/);
  assert.match(chinese, /copyName:\s*"复制项目名称"/);
  assert.match(chinese, /copyPath:\s*"复制项目路径"/);
});

test("developer-only open path label remains localized", () => {
  assert.match(english, /openSessionPath:\s*"Open session path"/);
  assert.match(chinese, /openSessionPath:\s*"打开会话路径"/);
});
