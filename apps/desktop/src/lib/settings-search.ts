/**
 * Data-only index of the settings IA, shared by the settings page nav and
 * the global search dialog. Keyword keys are the i18n keys of the rows
 * rendered inside each tab; search matches their translations, so a query
 * like "主题" or "theme" can surface the tab that owns the row.
 *
 * One destination owns one subject (D684). A destination that mixed subjects —
 * the old General, which carried appearance next to proxies and disk
 * maintenance, and the old AI, whose Defaults card collected transcript
 * display, composer input and run behavior — is split rather than reordered,
 * because no card order makes two subjects one page.
 */

export type SettingsTabId =
  | "appearance"
  | "chat"
  | "shortcuts"
  | "voice"
  | "behavior"
  | "agent"
  | "instructions"
  | "skills"
  | "mcp"
  | "subagents"
  | "projects"
  | "system"
  | "sync"
  | "remoteHosts"
  | "about";

export type SettingsNavGroupId =
  | "preferences"
  | "agent"
  | "workspace"
  | "system";

export const SETTINGS_NAV_GROUP_LABELS: Record<SettingsNavGroupId, string> = {
  preferences: "settings.groupPreferences",
  agent: "settings.groupAgent",
  workspace: "settings.groupWorkspace",
  system: "settings.groupSystem",
};

/** Destination Settings opens on when nothing else is requested. */
export const DEFAULT_SETTINGS_TAB: SettingsTabId = "appearance";

/** Where a destination id retired by the D684 split lands now. */
const RETIRED_SETTINGS_TABS: Record<string, SettingsTabId> = {
  general: "appearance",
  ai: "behavior",
};

export type SettingsNavEntry = {
  id: SettingsTabId;
  /** Short label used by the rail and settings search results. */
  labelKey: string;
  /** Descriptive title used at the top of the selected settings page. */
  titleKey: string;
  /**
   * One line under the page title saying what the destination decides. It is
   * set only for destinations whose own content does not already open with a
   * description — the capability, model and project workbenches do.
   */
  subtitleKey?: string;
  /** Visual-only rail grouping; search remains a flat destination index. */
  group: SettingsNavGroupId;
  /** i18n keys of the rows inside the tab; search matches their translations. */
  keywordKeys: string[];
  /**
   * Destination only exists while `AppSettings.developerMode` is on; the
   * rail, the page, and settings search drop it together.
   */
  developerOnly?: true;
  /** Surface is omitted from packaged builds; development builds retain it. */
  developmentOnly?: true;
  /** Localized Experimental badge shown beside the rail row and page title. */
  experimentalBadgeKey?: string;
};

export const SETTINGS_NAV: SettingsNavEntry[] = [
  {
    id: "appearance",
    labelKey: "settings.nav.appearance",
    titleKey: "settings.appearance",
    subtitleKey: "settings.appearanceSubtitle",
    group: "preferences",
    keywordKeys: [
      "settings.appearance",
      "settings.theme",
      "settings.language",
      "settings.languageAuto",
      "settings.font",
      "settings.fontSize",
      "settings.windowTranslucency",
      "settings.windowTranslucencyDesc",
      "settings.sidebar",
      "settings.sidebarRunningIndicators",
      "settings.sidebarRunningIndicatorsDesc",
      "settings.sidebarRunningBadge",
      "settings.sidebarRunningRail",
      "settings.sidebarSessionTime",
      "settings.sidebarScheduledTasks",
      "settings.radialMenu",
      "settings.radialMenuDesc",
      "settings.radialMenuEnable",
      "settings.radialMenuEnableDesc",
      "settings.radialMenuUp",
      "settings.radialMenuRight",
      "settings.radialMenuDown",
      "settings.radialMenuLeft",
      "settings.radialMenuActionNone",
      "settings.startupAnimation",
      "settings.startupAnimationDesc",
      "settings.startupAnimationSkipWhenReady",
      "settings.startupAnimationSkipWhenReadyDesc",
    ],
  },
  {
    id: "chat",
    labelKey: "settings.nav.chat",
    titleKey: "settings.conversation",
    subtitleKey: "settings.conversationSubtitle",
    group: "preferences",
    // Indexed in the order the rows render, so a search result and the page it
    // opens read the same way.
    keywordKeys: [
      "settings.chatDisplay",
      "settings.showThinking",
      "settings.showThinkingDesc",
      "settings.autoCollapseThinking",
      "settings.autoCollapseThinkingDesc",
      "settings.transcriptDisplayMode",
      "settings.transcriptDisplayModeDesc",
      "settings.autoCollapseSettledGroups",
      "settings.autoCollapseSettledGroupsDesc",
      "settings.contextUsageDisplay",
      "settings.contextUsageDisplayRemaining",
      "settings.contextUsageDisplayUsed",
      "settings.smoothStreaming",
      "settings.smoothStreamingDesc",
      "settings.inlineVisualizations",
      "settings.inlineVisualizationsDesc",
      "settings.chatInput",
      "settings.enterToSend",
      "settings.enterToSendDesc",
      "settings.largePasteThreshold",
      "settings.linkOpenTarget",
    ],
  },
  {
    id: "shortcuts",
    labelKey: "settings.nav.shortcuts",
    titleKey: "settings.shortcuts",
    subtitleKey: "settings.shortcutsSubtitle",
    group: "preferences",
    keywordKeys: [
      "settings.keyboard",
      "settings.shortcutAction.openSearch",
      "settings.shortcutAction.openCommandPalette",
      "settings.shortcutAction.toggleSidebar",
      "settings.shortcutAction.openWorkPanel",
    ],
  },
  {
    id: "voice",
    labelKey: "liveVoice.title",
    titleKey: "liveVoice.title",
    group: "preferences",
    keywordKeys: [
      "liveVoice.title",
      "liveVoice.description",
      "liveVoice.enable",
      "liveVoice.provider",
      "liveVoice.model",
      "liveVoice.voice",
      "liveVoice.adapters.codex-live.title",
      "liveVoice.adapters.gemini-live.title",
      "liveVoice.adapters.openai-realtime.title",
    ],
  },
  {
    id: "behavior",
    labelKey: "settings.nav.behavior",
    titleKey: "settings.agentBehavior",
    subtitleKey: "settings.agentBehaviorSubtitle",
    group: "agent",
    keywordKeys: [
      "settings.sessionDefaults",
      "settings.execution",
      "settings.mode",
      "settings.modeDesc",
      "settings.permissions",
      "settings.permissionMode",
      "settings.permissionModeDesc",
      "settings.permissionModeAsk",
      "settings.permissionModeAcceptEdits",
      "settings.permissionModeAuto",
      "settings.commandShell",
      "settings.infiniteProviderRetry",
      "settings.infiniteProviderRetryDesc",
      "settings.scheduledTasks",
      "settings.scheduledTasksDesc",
      "computerUse.title",
    ],
  },
  {
    id: "agent",
    labelKey: "settings.nav.models",
    titleKey: "settings.configuration",
    group: "agent",
    keywordKeys: [
      "settings.providers",
      "settings.models",
      "settings.apiKey",
      "settings.baseUrl",
      "settings.apiStyle",
      "settings.imageModel",
      // Subscription accounts share the service list (D625).
      "settings.vendorAccounts",
      "settings.vendorSubscription",
      "settings.importTitle",
      "settings.importModelsScanDesc",
      "settings.importModelsTitle",
      "settings.importSourceClaudeCode",
      "settings.importSourceOpenCode",
      "settings.importSourceCodex",
      "settings.importSourcePi",
      "settings.importSourceCcSwitch",
    ],
  },
  {
    id: "instructions",
    labelKey: "settings.nav.instructions",
    titleKey: "settings.instructions",
    group: "agent",
    keywordKeys: [
      "settings.instructionsGlobal",
      "settings.instructionsPath",
    ],
  },
  {
    id: "skills",
    labelKey: "settings.nav.skills",
    titleKey: "settings.skills",
    group: "agent",
    keywordKeys: [
      "settings.skillsGlobalPath",
      "settings.skillsProjectPath",
      "settings.globalScopeDescription",
      "settings.projectScopeDescription",
      "settings.importSkill",
      "settings.importSkillFromTools",
      "settings.importAgentSkillsTitle",
      "settings.importAgentSkillsDesc",
      "settings.capabilityFilterGlobal",
      "settings.capabilityFilterProject",
      "extensions.skills.add",
      "extensions.skills.edit",
      "extensions.skills.remove",
      "extensions.skills.reveal",
    ],
  },
  {
    id: "mcp",
    labelKey: "settings.nav.mcp",
    titleKey: "settings.mcp",
    group: "agent",
    keywordKeys: [
      "settings.mcpGlobalPath",
      "settings.mcpProjectPath",
      "settings.globalScopeDescription",
      "settings.projectScopeDescription",
      "settings.addMcp",
      "settings.importMcpFromTools",
      "settings.importAgentMcpTitle",
      "settings.importAgentMcpDesc",
      "settings.editMcp",
      "settings.transport",
      "settings.capabilityFilterGlobal",
      "settings.capabilityFilterProject",
      "extensions.mcp.test",
      "extensions.mcp.remove",
    ],
  },
  {
    id: "subagents",
    labelKey: "settings.nav.subagents",
    titleKey: "settings.subagents",
    group: "agent",
    keywordKeys: [
      "settings.subagentsGlobalPath",
      "settings.subagentsOnlyGlobal",
      "settings.globalScopeDescription",
      "extensions.subagents.add",
      "extensions.subagents.edit",
      "extensions.subagents.remove",
      "extensions.subagents.reveal",
      "extensions.subagents.copy",
      "extensions.subagents.sourceBuiltin",
      "extensions.subagents.presetExplorerName",
      "extensions.subagents.presetReviewerName",
      "extensions.subagents.presetTestRunnerName",
      "extensions.subagents.presetFixerName",
      "extensions.subagents.presetUiDesignerName",
      "extensions.subagents.tools",
    ],
  },
  {
    id: "projects",
    labelKey: "settings.nav.projects",
    titleKey: "settings.projectArchive",
    group: "workspace",
    keywordKeys: [
      "project.title",
      "project.searchPlaceholder",
      "project.archive",
      "project.restore",
      "project.delete",
    ],
  },
  {
    id: "system",
    labelKey: "settings.nav.system",
    titleKey: "settings.system",
    subtitleKey: "settings.systemSubtitle",
    group: "system",
    keywordKeys: [
      "settings.network",
      "settings.proxy",
      "settings.proxySystem",
      "settings.proxyDirect",
      "settings.proxyCustom",
      "settings.proxyUrl",
      "settings.networkRelaxedModeDesc",
      "settings.networkRelaxedModeStrictDesc",
      "settings.storage.title",
      "settings.storage.dataPath",
      "settings.storage.cache",
      "settings.storage.clearCache",
      "settings.storage.backup",
      "settings.power",
      "settings.keepAwakeWhileRunning",
      "settings.keepAwakeWhileRunningDesc",
      "settings.preventScreenSleep",
      "settings.preventScreenSleepDesc",
      "settings.closeBehaviorTitle",
      "settings.closeBehaviorTray",
      "settings.closeBehaviorQuit",
    ],
  },
  {
    id: "sync",
    labelKey: "settings.nav.sync",
    titleKey: "settings.configSync.title",
    group: "system",
    experimentalBadgeKey: "settings.configSync.experimental",
    keywordKeys: [
      "settings.configSync.experimental",
      "settings.configSync.connectionTitle",
      "settings.configSync.endpoint",
      "settings.configSync.statusTitle",
      "settings.configSync.categoriesTitle",
      "settings.configSync.approvalsTitle",
      "settings.configSync.syncNow",
    ],
  },
  {
    id: "remoteHosts",
    labelKey: "settings.nav.remoteHosts",
    titleKey: "settings.remoteHosts.title",
    group: "system",
    experimentalBadgeKey: "settings.remoteHosts.experimental",
    keywordKeys: [
      "settings.remoteHosts.title",
      "settings.remoteHosts.addTitle",
      "settings.remoteHosts.addSsh",
      "settings.remoteHosts.addPair",
      "settings.remoteHosts.pair",
      "settings.remoteHosts.fieldUrl",
      "settings.remoteHosts.fieldPairingToken",
      "settings.remoteHosts.sshHost",
      "settings.remoteHosts.sshAuthMode",
      "settings.remoteHosts.sshPassword",
      "settings.remoteHosts.statusOnline",
      "settings.remoteHosts.statusOffline",
      "settings.remoteHosts.experimental",
    ],
  },
  {
    id: "about",
    labelKey: "settings.nav.info",
    titleKey: "settings.about",
    subtitleKey: "settings.aboutSubtitle",
    group: "system",
    keywordKeys: [
      "settings.application",
      "settings.logs",
      "settings.feedback",
      "updates.title",
      "updates.preferenceTitle",
      "settings.developer",
      "settings.developerMode",
      "settings.devTools",
    ],
  },
];

/**
 * Resolve a destination id that may predate the D684 split: an id the index
 * still owns is returned unchanged, a retired id maps to its successor, and
 * anything else falls back to the default destination.
 */
export function resolveSettingsTab(tab: string): SettingsTabId {
  if (SETTINGS_NAV.some((entry) => entry.id === tab)) return tab as SettingsTabId;
  return RETIRED_SETTINGS_TABS[tab] ?? DEFAULT_SETTINGS_TAB;
}

/**
 * Destinations the current mode offers. Unavailable destinations are omitted
 * from navigation and search rather than disabled.
 */
export function visibleSettingsNav(
  developerMode: boolean,
  includeDevelopmentOnly = true,
): SettingsNavEntry[] {
  return SETTINGS_NAV.filter(
    (entry) =>
      (entry.developerOnly !== true || developerMode) &&
      (entry.developmentOnly !== true || includeDevelopmentOnly),
  );
}

/** True when a stale selection points to a destination the current mode hides. */
export function isSettingsDestinationHidden(
  tab: SettingsTabId,
  developerMode: boolean,
  includeDevelopmentOnly = true,
): boolean {
  return !visibleSettingsNav(developerMode, includeDevelopmentOnly).some(
    (entry) => entry.id === tab,
  );
}

export type SettingsSearchHit = {
  tab: SettingsTabId;
  tabLabelKey: string;
  /** Matched row key; null when the tab label itself matched. */
  rowKey: string | null;
};

export type SettingsSearchOptions = {
  limit?: number;
  /** Search mirrors the rail, so developer-only tabs stay out of results. */
  developerMode?: boolean;
  /** Packaged builds omit experimental surfaces, even with developer mode on. */
  includeDevelopmentOnly?: boolean;
};

export function searchSettings(
  query: string,
  t: (key: string) => string,
  {
    limit = 8,
    developerMode = false,
    includeDevelopmentOnly = true,
  }: SettingsSearchOptions = {},
): SettingsSearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits: SettingsSearchHit[] = [];
  for (const entry of visibleSettingsNav(developerMode, includeDevelopmentOnly)) {
    if (t(entry.labelKey).toLowerCase().includes(q)) {
      hits.push({ tab: entry.id, tabLabelKey: entry.labelKey, rowKey: null });
    }
    for (const key of entry.keywordKeys) {
      if (t(key).toLowerCase().includes(q)) {
        hits.push({ tab: entry.id, tabLabelKey: entry.labelKey, rowKey: key });
      }
    }
  }
  return hits.slice(0, limit);
}
