import {
  readAppSource,
  readMainModuleSync,
  readStoreModuleSync,
  readStoreSource,
  readMainSource,
} from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const [
  protocolSource,
  mainSource,
  apiSource,
  storeSource,
  appSource,
  sidebarSource,
  pluginRuntimeSource,
] =
  await Promise.all([
    read("../../../packages/shared/src/protocol.ts"),
    readMainSource(),
    read("../src/lib/api.ts"),
  readStoreSource(),
    readAppSource(),
    read("../src/components/Sidebar.tsx"),
    read("../electron/main/plugin-runtime.ts"),
  ]);

const eventsSource = readStoreModuleSync("slices/events-slice.ts");
const notificationIpcSource = readMainModuleSync("ipc/notification-ipc.ts");

test("notification IPC stays behind the shared preload allowlist", () => {
  assert.match(protocolSource, /PROTOCOL_VERSION = 11/);
  for (const channel of [
    "notificationList",
    "notificationMarkRead",
    "notificationMarkAllRead",
    "notificationClear",
    "notificationShowNative",
    "notificationSetViewingSession",
    "notificationChanged",
    "notificationActivated",
  ]) {
    assert.match(protocolSource, new RegExp(`${channel}:`), channel);
  }
  assert.match(apiSource, /listNotifications:/);
  assert.match(apiSource, /setNotificationViewingSession:/);
  assert.match(apiSource, /onNotificationChanged:/);
  assert.match(apiSource, /onNotificationActivated:/);
});

test("terminal notifications flow from host completion to the renderer", () => {
  assert.match(mainSource, /session\.endTurn/);
  assert.match(mainSource, /result\.notification/);
  assert.match(mainSource, /IPC\.event\.notificationChanged/);
  assert.match(storeSource, /receiveNotification:/);
  assert.match(storeSource, /unreadNotificationCount/);
  assert.match(appSource, /api\.onNotificationChanged/);
  assert.match(sidebarSource, /<NotificationCenter onBeforeOpen=\{\(\) => closeMenus\(false\)\} \/>/);
  assert.doesNotMatch(appSource, /<NotificationCenter \/>/);
  const changedHandler = appSource.match(
    /api\.onNotificationChanged[\s\S]*?\n\s*\}\);/,
  )?.[0] ?? "";
  assert.match(changedHandler, /receiveNotification/);
  assert.doesNotMatch(changedHandler, /selectSession|openNotification/);
});

test("the visible chat session suppresses durable task notifications", () => {
  assert.match(mainSource, /shouldCreateTaskNotificationPolicy/);
  assert.match(mainSource, /viewingSessionId: getViewingSessionId\(\)/);
  assert.match(mainSource, /window\?\.isVisible\(\)/);
  assert.match(mainSource, /window\?\.isFocused\(\)/);
  assert.match(mainSource, /createNotification,/);
  assert.match(mainSource, /"did-start-loading"[\s\S]*windowState\.notificationViewingSessionId = null/);
  assert.match(mainSource, /"render-process-gone"[\s\S]*windowState\.notificationViewingSessionId = null/);
  assert.match(appSource, /page === "chat" \? activeSessionId \?\? null : null/);
  assert.match(appSource, /setNotificationViewingSession\(viewingSessionId\)/);
});

test("sidebar terminal outcomes are notification-backed, not lifecycle-backed", () => {
  const terminalStart = eventsSource.indexOf('} else if (event.type === "agent_end" || event.type === "error")');
  const terminalEnd = eventsSource.indexOf('      if (event.type === "planning_state")', terminalStart);
  const terminalBlock = eventsSource.slice(terminalStart, terminalEnd);
  assert.match(terminalBlock, /latestTurnResults/);
  assert.doesNotMatch(terminalBlock, /sessionOutcomes:/);
  assert.match(storeSource, /receiveNotification:[\s\S]*sessionOutcomes:/);
  assert.match(storeSource, /viewingSessionId: viewingSessionIdForPrompt\(get\(\), sessionId\)/);
  assert.match(mainSource, /req\.viewingSessionId/);
});

test("task and interactive native notifications keep separate visibility rules", () => {
  assert.match(mainSource, /app\.setAppUserModelId\(APP_ID\)/);
  assert.match(mainSource, /mainWindow\.isFocused\(\)/);
  assert.match(mainSource, /SystemNotification\.isSupported\(\)/);
  assert.match(mainSource, /new SystemNotification/);
  assert.match(mainSource, /IPC\.event\.notificationActivated/);
  assert.match(notificationIpcSource, /window\.restore\(\)/);
  assert.match(appSource, /showNativeNotification/);
  assert.match(appSource, /kind: "task"/);
  assert.match(storeSource, /kind: "interactive"/);
  assert.match(mainSource, /input\.kind === "interactive"/);
  assert.match(appSource, /openNotification\(id\)/);
  assert.match(
    storeSource,
    /await get\(\)\.selectSession\(notification\.sessionId,\s*\{\s*navigationIntent: intent/,
  );
});

test("plugins can request and send native notifications behind notify permission", () => {
  assert.match(pluginRuntimeSource, /"ui\.getNotificationPermission"/);
  assert.match(pluginRuntimeSource, /"ui\.requestNotificationPermission"/);
  assert.match(pluginRuntimeSource, /"ui\.showNativeNotification"/);
  assert.match(pluginRuntimeSource, /this\.assertPermission\(loaded, "notify"\)/);
  assert.match(mainSource, /getPluginNotificationPermission/);
  assert.match(mainSource, /requestPluginNotificationPermission/);
  assert.match(mainSource, /showPluginNativeNotification/);
  assert.match(mainSource, /PLUGIN_NOTIFICATION_TIMEOUT_MS/);
  assert.match(mainSource, /pluginNotificationPermission/);
});
