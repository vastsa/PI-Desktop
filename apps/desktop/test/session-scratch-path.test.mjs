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

test("developer-mode conversation overflow copies the id then opens scratch", () => {
  assert.match(sidebarSource, /data-action="copy-conversation-id"/);
  assert.match(sidebarSource, /navigator\.clipboard\.writeText\(session\.id\)/);
  assert.match(sidebarSource, /data-action="open-session-path"/);
  assert.match(sidebarSource, /api\.openSessionScratchPath\(session\.id\)/);
  assert.doesNotMatch(sidebarSource, /data-action="copy-session-path"/);
  assert.doesNotMatch(sidebarSource, /data-action="open-session-folder"/);
  assert.doesNotMatch(sidebarSource, /copySessionPath/);

  const copyIndex = sidebarSource.indexOf('data-action="copy-conversation-id"');
  const openIndex = sidebarSource.indexOf('data-action="open-session-path"');
  const deleteIndex = sidebarSource.indexOf('data-action="delete-session"');
  assert.ok(copyIndex > 0 && openIndex > copyIndex && deleteIndex > openIndex);

  const developerBlock = sidebarSource.slice(
    sidebarSource.indexOf("settings?.developerMode === true"),
    deleteIndex,
  );
  assert.match(developerBlock, /copy-conversation-id/);
  assert.match(developerBlock, /open-session-path/);
});

test("conversation overflow labels are localized", () => {
  assert.match(english, /copyConversationId:\s*"Copy conversation ID"/);
  assert.match(english, /openSessionPath:\s*"Open session path"/);
  assert.doesNotMatch(english, /copySessionPath:/);
  assert.match(chinese, /copyConversationId:\s*"复制对话 ID"/);
  assert.match(chinese, /openSessionPath:\s*"打开会话路径"/);
});
