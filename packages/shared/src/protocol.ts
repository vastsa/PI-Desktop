export const PROTOCOL_VERSION = 11 as const;
export const SCHEMA_VERSION = 16 as const;
export const APP_ID = "net.aiuo.pi-desktop";
export const APP_NAME = "PI-Desktop";
export const APP_VERSION = "0.15.7-beta.1";

export const APP_MENU_COMMANDS = [
  "newTask",
  "openProject",
  "openSettings",
  "openSearch",
  "openCommandPalette",
  "toggleSidebar",
  "openHelp",
  "openLogs",
  "checkForUpdates",
] as const;

export type AppMenuCommand = (typeof APP_MENU_COMMANDS)[number];

export const NATIVE_MENU_ACTIONS = [
  "undo",
  "redo",
  "cut",
  "copy",
  "paste",
  "selectAll",
  "reload",
  "zoomIn",
  "zoomOut",
  "resetZoom",
  "toggleFullScreen",
  "minimize",
  "toggleMaximize",
  "close",
  "restoreMainWindow",
  "toggleMainWindow",
] as const;

export type NativeMenuAction = (typeof NATIVE_MENU_ACTIONS)[number];

export const WINDOW_CONTROL_ACTIONS = [
  "getState",
  "minimize",
  "toggleMaximize",
  "close",
] as const;

export type WindowControlAction = (typeof WINDOW_CONTROL_ACTIONS)[number];

export const IPC = {
  invoke: {
    appGetVersion: "pi-desktop/app/getVersion",
    appOpenFeedback: "pi-desktop/app/openFeedback",
    appHealth: "pi-desktop/app/health",
    appGetOnboarding: "pi-desktop/app/getOnboarding",
    appDismissOnboarding: "pi-desktop/app/dismissOnboarding",
    /**
     * Quit the whole application through the ordered shutdown. Exposed for the
     * surfaces that own the window while the shell has no data yet — a stuck
     * startup must always be able to exit the app (issue #831).
     */
    appQuit: "pi-desktop/app/quit",
    /** Installed system font families, resolved by Electron main. */
    systemFontsList: "pi-desktop/app/systemFonts",
    updatesGetState: "pi-desktop/updates/getState",
    updatesCheck: "pi-desktop/updates/check",
    updatesDownload: "pi-desktop/updates/download",
    updatesInstall: "pi-desktop/updates/install",
    updatesOpenReleases: "pi-desktop/updates/openReleases",
    notificationList: "pi-desktop/notification/list",
    notificationMarkRead: "pi-desktop/notification/markRead",
    notificationMarkAllRead: "pi-desktop/notification/markAllRead",
    notificationClear: "pi-desktop/notification/clear",
    notificationShowNative: "pi-desktop/notification/showNative",
    notificationSetViewingSession: "pi-desktop/notification/setViewingSession",
    agentPrompt: "pi-desktop/agent/prompt",
    agentSteer: "pi-desktop/agent/steer",
    promptEnhance: "pi-desktop/prompt/enhance",
    speechTranscribe: "pi-desktop/speech/transcribe",
    speechSynthesize: "pi-desktop/speech/synthesize",
    speechGetStatus: "pi-desktop/speech/getStatus",
    voiceStart: "pi-desktop/voice/start",
    voiceStop: "pi-desktop/voice/stop",
    voiceCancel: "pi-desktop/voice/cancel",
    voiceGetState: "pi-desktop/voice/getState",
    voiceGetDevices: "pi-desktop/voice/getDevices",
    voiceGetModels: "pi-desktop/voice/getModels",
    voiceDownloadModel: "pi-desktop/voice/downloadModel",
    voiceDeleteModel: "pi-desktop/voice/deleteModel",
    voiceUpdateSettings: "pi-desktop/voice/updateSettings",
    voiceCheckPermission: "pi-desktop/voice/checkPermission",
    voiceRequestPermission: "pi-desktop/voice/requestPermission",
    agentCompact: "pi-desktop/agent/compact",
    agentAbort: "pi-desktop/agent/abort",
    agentStop: "pi-desktop/agent/stop",
    agentQueuePush: "pi-desktop/agent/queue/push",
    agentQueueList: "pi-desktop/agent/queue/list",
    agentQueueRemove: "pi-desktop/agent/queue/remove",
    agentQueuePrioritize: "pi-desktop/agent/queue/prioritize",
    agentQueueReorder: "pi-desktop/agent/queue/reorder",
    agentGetStatus: "pi-desktop/agent/getStatus",
    agentInstructionsGet: "pi-desktop/agent/instructions/get",
    agentInstructionsSave: "pi-desktop/agent/instructions/save",
    sessionList: "pi-desktop/session/list",
    sessionCreate: "pi-desktop/session/create",
    sessionFork: "pi-desktop/session/fork",
    sessionMoveProject: "pi-desktop/session/moveProject",
    sessionSearch: "pi-desktop/session/search",
    sessionSearchContext: "pi-desktop/session/searchContext",
    sessionGet: "pi-desktop/session/get",
    sessionCollaboration: "pi-desktop/session/collaboration",
    /** Validate and select a durable session from a reviewed host operation. */
    sessionOpen: "pi-desktop/session/open",
    sessionDelete: "pi-desktop/session/delete",
    sessionRename: "pi-desktop/session/rename",
    sessionSummarizeTitle: "pi-desktop/session/summarizeTitle",
    sessionConfigure: "pi-desktop/session/configure",
    sessionImportScan: "pi-desktop/session/importScan",
    sessionImportRun: "pi-desktop/session/importRun",
    modelConfigImportScan: "pi-desktop/modelConfig/importScan",
    modelConfigImportRun: "pi-desktop/modelConfig/importRun",
    sessionReplaceMessages: "pi-desktop/session/replaceMessages",
    sessionSaveRevision: "pi-desktop/session/saveRevision",
    sessionListRevisions: "pi-desktop/session/listRevisions",
    sessionActivateRevision: "pi-desktop/session/activateRevision",
    sessionGetScratchPath: "pi-desktop/session/getScratchPath",
    sessionOpenScratchPath: "pi-desktop/session/openScratchPath",
    projectOpenFolder: "pi-desktop/project/openFolder",
    settingsGet: "pi-desktop/settings/get",
    settingsSet: "pi-desktop/settings/set",
    configSyncGetState: "pi-desktop/configSync/getState",
    configSyncConfigure: "pi-desktop/configSync/configure",
    configSyncTest: "pi-desktop/configSync/test",
    configSyncSyncNow: "pi-desktop/configSync/syncNow",
    configSyncPause: "pi-desktop/configSync/pause",
    configSyncUnlock: "pi-desktop/configSync/unlock",
    configSyncApprove: "pi-desktop/configSync/approve",
    configSyncReject: "pi-desktop/configSync/reject",
    configSyncMapProject: "pi-desktop/configSync/mapProject",
    configSyncListHistory: "pi-desktop/configSync/listHistory",
    configSyncRestore: "pi-desktop/configSync/restore",
    configSyncChangePassword: "pi-desktop/configSync/changePassword",
    configSyncDisconnect: "pi-desktop/configSync/disconnect",
    networkProxyTest: "pi-desktop/network/testProxy",
    commandShellList: "pi-desktop/commandShell/list",
    secretsSet: "pi-desktop/secrets/set",
    secretsDelete: "pi-desktop/secrets/delete",
    secretsHas: "pi-desktop/secrets/has",
    projectOpen: "pi-desktop/project/open",
    projectPickFolders: "pi-desktop/project/pickFolders",
    projectMemoryGet: "pi-desktop/project/memory/get",
    projectMemorySave: "pi-desktop/project/memory/save",
    projectGroupList: "pi-desktop/project-group/list",
    projectGroupCreate: "pi-desktop/project-group/create",
    projectGroupRename: "pi-desktop/project-group/rename",
    projectGroupUpdate: "pi-desktop/project-group/update",
    projectGroupMemoryGet: "pi-desktop/project-group/memory/get",
    projectGroupMemorySave: "pi-desktop/project-group/memory/save",
    projectGroupInstructionsGet: "pi-desktop/project-group/instructions/get",
    projectGroupInstructionsSave: "pi-desktop/project-group/instructions/save",
    projectClone: "pi-desktop/project/clone",
    projectCloneCheckout: "pi-desktop/project/cloneCheckout",
    projectGet: "pi-desktop/project/get",
    projectList: "pi-desktop/project/list",
    projectSet: "pi-desktop/project/set",
    projectClear: "pi-desktop/project/clear",
    projectRemove: "pi-desktop/project/remove",
    pullsList: "pi-desktop/pulls/list",
    scheduledList: "pi-desktop/scheduled/list",
    scheduledCreate: "pi-desktop/scheduled/create",
    scheduledUpdate: "pi-desktop/scheduled/update",
    scheduledDelete: "pi-desktop/scheduled/delete",
    scheduledRun: "pi-desktop/scheduled/run",
    scheduledExecute: "pi-desktop/scheduled/execute",
    scheduledListRuns: "pi-desktop/scheduled/listRuns",
    toolResolvePermission: "pi-desktop/tool/resolvePermission",
    askToolResolve: "pi-desktop/agent/askTool/resolve",
    plansPending: "pi-desktop/plans/pending",
    plansResolve: "pi-desktop/plans/resolve",
    /**
     * List every paired remote `pi-host` this desktop knows, redacted so no
     * device token reaches the renderer. See ADR 0286 (R2b pairing UX).
     */
    remoteHostList: "pi-desktop/remoteHost/list",
    /**
     * Pair with a `pi-host` at `url` using a single-use `pairingToken`, mint
     * a device token, persist it encrypted, and open the live connection.
     */
    remoteHostPair: "pi-desktop/remoteHost/pair",
    /** Close the live connection for `hostKey` and drop its persisted record. */
    remoteHostRemove: "pi-desktop/remoteHost/remove",
    /**
     * Install and pair a `pi-host` on a machine the user reaches over SSH:
     * upload the bootstrap script, download and verify the published bundle
     * there, start the host, forward its loopback port, and exchange the
     * pairing token (spec §5.2). Uses the user's own SSH keys; no credential
     * crosses this channel.
     */
    remoteHostBootstrap: "pi-desktop/remoteHost/bootstrap",
    /** Projects a connected host has registered (RACP `project/list`). */
    remoteProjectList: "pi-desktop/remoteProject/list",
    /**
     * Directories under the host's browse root (RACP `project/browse`), so a
     * remote project can be picked without typing an absolute host path.
     */
    remoteProjectBrowse: "pi-desktop/remoteProject/browse",
    /** Register a host directory as a project (RACP `project/register`). */
    remoteProjectRegister: "pi-desktop/remoteProject/register",
    /**
     * Create a session on a connected host in one of its projects. The
     * result is the `remote:` summary the sidebar lists; later calls for it
     * route to the host through the backend router.
     */
    remoteSessionCreate: "pi-desktop/remoteSession/create",
    remoteHostSyncProviders: "pi-desktop/remoteHost/syncProviders",
    providersList: "pi-desktop/providers/list",
    providersReorder: "pi-desktop/providers/reorder",
    providersCreate: "pi-desktop/providers/create",
    providersUpdate: "pi-desktop/providers/update",
    providersDelete: "pi-desktop/providers/delete",
    /**
     * Set or clear one provider's API key. Separate from `providersUpdate`
     * because a plugin-declared row refuses a generic update while still
     * needing the credential its declaration asks for.
     */
    providersSetSecret: "pi-desktop/providers/setSecret",
    providersTest: "pi-desktop/providers/testConnection",
    providersListModels: "pi-desktop/providers/listModels",
    /**
     * Look one model id up in the local models.dev snapshot.
     *
     * `providersListModels` cannot answer this: it describes a saved or
     * reached provider's catalogue, and a hand-typed custom id exists nowhere
     * yet when the settings picker needs its published limits. This is a
     * snapshot read — no provider network access and no host call — so the
     * picker can seed a custom row without probing an endpoint that does not
     * know the id.
     */
    providersLookupModel: "pi-desktop/providers/lookupModel",
    providersRefreshModelCatalog: "pi-desktop/providers/refreshModelCatalog",
    providersModelCatalogStatus: "pi-desktop/providers/modelCatalogStatus",
    providersOauthVendors: "pi-desktop/providers/oauth/vendors",
    providersOauthStart: "pi-desktop/providers/oauth/start",
    providersOauthRespond: "pi-desktop/providers/oauth/respond",
    providersOauthCancel: "pi-desktop/providers/oauth/cancel",
    providersOauthDelete: "pi-desktop/providers/oauth/delete",
    pluginList: "pi-desktop/plugin/list",
    /** Plugin-contributed agent extensions (D387/D388, ADR 0214). */
    piSkillDiscover: "pi-desktop/plugin/discoverPiSkills",
    piSkillImport: "pi-desktop/plugin/importPiSkills",
    pluginImportExtension: "pi-desktop/plugin/importExtension",
    extensionsCommandRun: "pi-desktop/extensions/commands/run",
    extensionsUiRespond: "pi-desktop/extensions/ui/respond",
    pluginLoadDev: "pi-desktop/plugin/loadDev",
    /**
     * The answer to a development plugin's permission review. Loading a folder
     * is a two-step: `pluginLoadDev` returns the declaration, and this commits
     * the permissions the user accepted.
     */
    pluginLoadDevConfirm: "pi-desktop/plugin/loadDevConfirm",
    pluginReload: "pi-desktop/plugin/reload",
    /** Commits a reviewed widening for an already-loaded development plugin. */
    pluginReloadConfirm: "pi-desktop/plugin/reloadConfirm",
    pluginCreateFromTemplate: "pi-desktop/plugin/createFromTemplate",
    pluginInstallFromPath: "pi-desktop/plugin/installFromPath",
    pluginInstallFromPackage: "pi-desktop/plugin/installFromPackage",
    pluginEnable: "pi-desktop/plugin/enable",
    pluginDisable: "pi-desktop/plugin/disable",
    pluginSetScope: "pi-desktop/plugin/setScope",
    pluginUninstall: "pi-desktop/plugin/uninstall",
    pluginSetAutoUpdate: "pi-desktop/plugin/setAutoUpdate",
    pluginSettingsGet: "pi-desktop/plugin/settings/get",
    pluginSettingsSet: "pi-desktop/plugin/settings/set",
    pluginOpenPanel: "pi-desktop/plugin/openPanel",
    pluginLauncherToggle: "pi-desktop/pluginLauncher/toggle",
    pluginLauncherDismiss: "pi-desktop/pluginLauncher/dismiss",
    pluginThemes: "pi-desktop/plugin/themes",
    pluginScenicThemesDestinations: "pi-desktop/plugin/scenicThemes/destinations",
    pluginScenicThemesSetBlur: "pi-desktop/plugin/scenicThemes/setBlur",
    pluginServices: "pi-desktop/plugin/services",
    pluginViews: "pi-desktop/plugin/views",
    pluginViewOpen: "pi-desktop/plugin/view/open",
    pluginViewClose: "pi-desktop/plugin/view/close",
    pluginViewSetBounds: "pi-desktop/plugin/view/setBounds",
    pluginViewSetVisible: "pi-desktop/plugin/view/setVisible",
    mcpList: "pi-desktop/mcp/list",
    mcpUpsert: "pi-desktop/mcp/upsert",
    mcpRemove: "pi-desktop/mcp/remove",
    mcpSetEnabled: "pi-desktop/mcp/setEnabled",
    mcpSetScope: "pi-desktop/mcp/setScope",
    mcpTransfer: "pi-desktop/mcp/transfer",
    mcpTest: "pi-desktop/mcp/test",
    mcpOauthStart: "pi-desktop/mcp/oauth/start",
    mcpOauthCancel: "pi-desktop/mcp/oauth/cancel",
    mcpImport: "pi-desktop/mcp/import",
    mcpImportScan: "pi-desktop/mcp/importScan",
    mcpImportRun: "pi-desktop/mcp/importRun",
    mcpMarketSearch: "pi-desktop/mcp/market/search",
    skillList: "pi-desktop/skill/list",
    skillCreate: "pi-desktop/skill/create",
    skillImport: "pi-desktop/skill/import",
    skillImportScan: "pi-desktop/skill/importScan",
    skillImportRun: "pi-desktop/skill/importRun",
    skillMarketSearch: "pi-desktop/skill/market/search",
    skillMarketFetch: "pi-desktop/skill/market/fetch",
    skillUpdate: "pi-desktop/skill/update",
    skillRemove: "pi-desktop/skill/remove",
    skillSetEnabled: "pi-desktop/skill/setEnabled",
    skillSetScope: "pi-desktop/skill/setScope",
    skillTransfer: "pi-desktop/skill/transfer",
    skillRead: "pi-desktop/skill/read",
    skillReveal: "pi-desktop/skill/reveal",
    subagentList: "pi-desktop/subagent/list",
    subagentCatalog: "pi-desktop/subagent/catalog",
    subagentCreate: "pi-desktop/subagent/create",
    subagentUpdate: "pi-desktop/subagent/update",
    subagentRead: "pi-desktop/subagent/read",
    subagentRemove: "pi-desktop/subagent/remove",
    subagentSetEnabled: "pi-desktop/subagent/setEnabled",
    subagentSetScope: "pi-desktop/subagent/setScope",
    subagentSetBuiltinEnabled: "pi-desktop/subagent/setBuiltinEnabled",
    subagentReveal: "pi-desktop/subagent/reveal",
    marketRefresh: "pi-desktop/market/refresh",
    marketSearch: "pi-desktop/market/search",
    marketGetDetail: "pi-desktop/market/getDetail",
    marketInstall: "pi-desktop/market/install",
    marketCheckUpdates: "pi-desktop/market/checkUpdates",
    marketApplyUpdates: "pi-desktop/market/applyUpdates",
    marketCancelInstall: "pi-desktop/market/cancelInstall",
    commandPaletteSearch: "pi-desktop/commandPalette/search",
    commandPaletteExecute: "pi-desktop/commandPalette/execute",
    logOpenFolder: "pi-desktop/log/openFolder",
    devtoolsToggle: "pi-desktop/devtools/toggle",
    composerPickFiles: "pi-desktop/composer/pickFiles",
    composerPickPhotos: "pi-desktop/composer/pickPhotos",
    composerImportFiles: "pi-desktop/composer/importFiles",
    composerPasteFiles: "pi-desktop/composer/pasteFiles",
    clipboardRecordPaste: "pi-desktop/clipboard/recordPaste",
    composerCommands: "pi-desktop/composer/commands",
    workspaceDiff: "pi-desktop/workspace/diff",
    workspaceReviewRollback: "pi-desktop/workspace/review/rollback",
    browserNavigate: "pi-desktop/browser/navigate",
    browserAction: "pi-desktop/browser/action",
    browserSetBounds: "pi-desktop/browser/setBounds",
    browserSetVisible: "pi-desktop/browser/setVisible",
    browserOpenExternal: "pi-desktop/browser/openExternal",
    browserGetState: "pi-desktop/browser/getState",
    fsList: "pi-desktop/fs/list",
    fsRead: "pi-desktop/fs/read",
    fsReadImageDataUrl: "pi-desktop/fs/readImageDataUrl",
    statsGetTokenUsageHistory: "pi-desktop/stats/getTokenUsageHistory",
    fsReveal: "pi-desktop/fs/reveal",
    fsOpen: "pi-desktop/fs/open",
    fsIndex: "pi-desktop/fs/index",
    fsResolveRef: "pi-desktop/fs/resolveRef",
    windowSetWorkPanelReservation:
      "pi-desktop/window/setWorkPanelReservation",
    windowSetWorkPanelChatWidth: "pi-desktop/window/setWorkPanelChatWidth",
    windowSetBackgroundColor: "pi-desktop/window/setBackgroundColor",
    windowControl: "pi-desktop/window/control",
    closeBehaviorGet: "pi-desktop/window/closeBehavior/get",
    closeBehaviorSet: "pi-desktop/window/closeBehavior/set",
    menuRendererReady: "pi-desktop/menu/rendererReady",
    traySetSessionPreferences: "pi-desktop/tray/setSessionPreferences",
    nativeMenuAction: "pi-desktop/menu/nativeAction",
  },
  event: {
    pluginChanged: "pi-desktop/event/pluginChanged",
    /** Progress of an install or update, while it is still running. */
    pluginInstallProgress: "pi-desktop/plugin/event/installProgress",
    /** Host-originated app settings mutation (e.g. plugin `app.setTheme`). */
    settingsChanged: "pi-desktop/app/event/settingsChanged",
    configSyncChanged: "pi-desktop/configSync/event/changed",
    /** What a running sync is doing, while it is still running. */
    configSyncProgress: "pi-desktop/configSync/event/progress",
    extensionsUiPrompt: "pi-desktop/extensions/event/uiPrompt",
    extensionsStatus: "pi-desktop/extensions/event/status",
    pluginLauncherShown: "pi-desktop/pluginLauncher/event/shown",
    agentMessage: "pi-desktop/agent/event/message",
    agentQueueChanged: "pi-desktop/agent/event/queueChanged",
    hostStatus: "pi-desktop/app/event/hostStatus",
    toast: "pi-desktop/app/event/toast",
    /**
     * The first plaintext hop to an endpoint the user typed, sent once and only
     * until the shell records `networkPolicy.insecureNoticeAcknowledged`. The
     * shell owns the wording, because the address is not a secret and the copy
     * is localized.
     */
    insecureEndpointNotice: "pi-desktop/network/event/insecureEndpointNotice",
    browserState: "pi-desktop/browser/event/state",
    browserPreview: "pi-desktop/browser/event/preview",
    windowMaximized: "pi-desktop/window/event/maximized",
    windowFullScreen: "pi-desktop/window/event/fullscreen",
    windowWorkPanelResize: "pi-desktop/window/event/workPanelResize",
    menuCommand: "pi-desktop/menu/event/command",
    traySessionActivated: "pi-desktop/tray/event/sessionActivated",
    notificationChanged: "pi-desktop/notification/event/changed",
    sessionsChanged: "pi-desktop/session/event/changed",
    notificationActivated: "pi-desktop/notification/event/activated",
    plansChanged: "pi-desktop/plans/event/changed",
    providersOauth: "pi-desktop/providers/oauth/event",
    mcpOauth: "pi-desktop/mcp/oauth/event",
    updatesState: "pi-desktop/updates/event/state",
    voiceStateChanged: "pi-desktop/voice/event/stateChanged",
    voiceModelProgress: "pi-desktop/voice/event/modelProgress",
  },
} as const;

export const IPC_WHITELIST = new Set<string>([
  ...Object.values(IPC.invoke),
  ...Object.values(IPC.event),
]);
