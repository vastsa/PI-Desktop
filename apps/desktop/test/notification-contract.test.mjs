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
const catalogSource = readStoreModuleSync("slices/catalog-slice.ts");
const catalogRuntimeSource = readStoreModuleSync("runtime/catalog-runtime.ts");
const notificationIpcSource = readMainModuleSync("ipc/notification-ipc.ts");
const desktopServicesSource = readMainModuleSync("services/desktop-services.ts");

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

test("native notifications retain live objects through OS activation", () => {
  assert.match(
    notificationIpcSource,
    /const taskNativeNotifications = new Map<string, TaskNativeNotificationEntry>\(\)/,
  );
  assert.match(
    notificationIpcSource,
    /taskNativeNotifications\.set\(id, \{ notification, dismissed: false \}\)/,
  );
  assert.match(notificationIpcSource, /notification\.once\("close", \(\) => releaseNotification\(true\)\)/);
  assert.match(notificationIpcSource, /notification\.once\("failed", \(\) => releaseNotification\(false\)\)/);
  assert.match(notificationIpcSource, /notification\.once\("click",/);
  assert.match(notificationIpcSource, /releaseNotification\((?:true|false)\)/);
  assert.match(desktopServicesSource, /getMainWindow: \(\) => BrowserWindow \| null/);
  assert.match(desktopServicesSource, /notification\.once\("click",/);
  assert.match(desktopServicesSource, /window\.show\(\);/);
  assert.match(desktopServicesSource, /window\.focus\(\);/);
});

test("task native notifications are idempotent by durable notification id", () => {
  // A renderer reload or a repeated host event may deliver the same durable
  // notification more than once. Native delivery must keep one live object per
  // durable id so Windows Action Center cannot accumulate duplicate banners.
  assert.match(
    notificationIpcSource,
    /const taskNativeNotifications = new Map<string, TaskNativeNotificationEntry>\(\)/,
  );
  assert.match(notificationIpcSource, /taskNativeNotifications\.get\(id\)/);
  assert.match(notificationIpcSource, /taskNativeNotifications\.set\(id, \{ notification, dismissed: false \}\)/);
  assert.match(notificationIpcSource, /taskNativeNotifications\.delete\(id\)/);
  assert.match(notificationIpcSource, /existingTaskNotification\.dismissed/);
  assert.ok(
    notificationIpcSource.indexOf("existingTaskNotification") <
      notificationIpcSource.indexOf("new SystemNotification"),
    "duplicate guard must run before constructing a native object",
  );
});

test("read and clear notification actions dismiss outstanding task banners", () => {
  const readStart = notificationIpcSource.indexOf(
    "handle(IPC.invoke.notificationMarkRead",
  );
  const allReadStart = notificationIpcSource.indexOf(
    "handle(IPC.invoke.notificationMarkAllRead",
  );
  const clearStart = notificationIpcSource.indexOf(
    "handle(IPC.invoke.notificationClear",
  );
  const setViewingStart = notificationIpcSource.indexOf(
    "IPC.invoke.notificationSetViewingSession",
  );
  const readHandler = notificationIpcSource.slice(readStart, allReadStart);
  const allReadHandler = notificationIpcSource.slice(allReadStart, clearStart);
  const clearHandler = notificationIpcSource.slice(clearStart, setViewingStart);

  assert.match(readHandler, /dismissTaskNativeNotification\(id\)/);
  assert.match(allReadHandler, /dismissAllTaskNativeNotifications\(\)/);
  assert.match(clearHandler, /dismissAllTaskNativeNotifications\(\)/);
  assert.ok(
    readHandler.indexOf("await host.call") <
      readHandler.indexOf("dismissTaskNativeNotification"),
    "read acknowledgement must succeed before dismissing the native object",
  );
  assert.ok(
    clearHandler.indexOf("await host.call") <
      clearHandler.indexOf("dismissAllTaskNativeNotifications"),
    "clear acknowledgement must succeed before dismissing native objects",
  );
  assert.match(notificationIpcSource, /function dismissTaskNativeNotification/);
  assert.match(notificationIpcSource, /notification\.close\(\)/);
  // Interactive prompts are transient and are not tied to durable inbox ids.
  assert.match(notificationIpcSource, /interactiveNativeNotifications/);
});

test("notification list refreshes cannot resurrect cleared rows", () => {
  assert.match(catalogRuntimeSource, /notificationGeneration/);
  assert.match(catalogRuntimeSource, /invalidateNotificationRefresh/);
  assert.match(catalogRuntimeSource, /notificationClearedAt/);
  assert.match(catalogRuntimeSource, /setNotificationClearedAt/);

  const refreshStart = catalogSource.indexOf("refreshNotifications: async");
  const receiveStart = catalogSource.indexOf("receiveNotification:", refreshStart);
  const clearStart = catalogSource.indexOf("clearNotifications: async");
  const openStart = catalogSource.indexOf("openNotification:", clearStart);
  const refreshBlock = catalogSource.slice(refreshStart, receiveStart);
  const receiveBlock = catalogSource.slice(receiveStart, clearStart);
  const clearBlock = catalogSource.slice(clearStart, openStart);

  assert.match(refreshBlock, /notificationGeneration\(\)/);
  assert.match(refreshBlock, /generation !== catalogRuntime\.notificationGeneration\(\)/);
  assert.match(receiveBlock, /notificationClearedAt\(\)/);
  assert.match(receiveBlock, /createdAt/);
  assert.match(receiveBlock, /return;/);
  assert.match(clearBlock, /invalidateNotificationRefresh\(\)/);
  assert.match(clearBlock, /setNotificationClearedAt/);
  assert.match(clearBlock, /sessionOutcomes:\s*\{\}/);

  // A stale list response must be filtered before replacing the store. Merely
  // guarding the request generation is insufficient when the clear operation
  // itself performs a follow-up refresh against a lagging host read.
  assert.match(
    refreshBlock,
    /result\.notifications[\s\S]{0,800}\.filter\(/,
  );
  assert.match(refreshBlock, /notificationClearedAt\(\)/);
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
