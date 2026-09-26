/**
 * Data-only index of the settings IA, shared by the settings page nav and
 * the global search dialog. Keyword keys are the i18n keys of the rows
 * rendered inside each tab; search matches their translations, so a query
 * like "主题" or "theme" can surface the tab that owns the row.
 */

/**
 * Settings destinations.
 */
export type SettingsTabId =
  | "general"
  | "ai"
  | "shortcuts"
  | "instructions"
  | "agent"
  | "skills"
  | "mcp"
  | "subagents"
  | "import"
  | "projects"
  | "index"
  | "sync"
  | "remoteHosts"
  | "voice"
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

export type SettingsNavEntry = {
  id: SettingsTabId;
  /** Short label used by the rail and settings search results. */
  labelKey: string;
  /** Descriptive title used at the top of the selected settings page. */
  titleKey: string;
  /** Visual-only rail grouping; search remains a flat destination index. */
  group: SettingsNavGroupId;
  /** i18n keys of the rows inside the tab; search matches their translations. */
  keywordKeys: string[];
  /**
   * Destination only exists while `AppSettings.developerMode` is on; the
   * rail, the page, and settings search drop it together.
   */
  developerOnly?: true;
  /** Localized Experimental badge shown beside the rail row and page title. */
  experimentalBadgeKey?: string;
};

export const SETTINGS_NAV: SettingsNavEntry[] = [
  {
    id: "general",
    labelKey: "settings.nav.general",
    titleKey: "settings.general",
    group: "preferences",
    keywordKeys: [
      "settings.appearance",
      "settings.theme",
      "settings.language",
      "settings.languageAuto",
      "settings.font",
      "settings.fontSize",
      "settings.closeBehaviorTitle",
      "settings.closeBehaviorTray",
      "settings.closeBehaviorQuit",
      "settings.power",
      "settings.keepAwakeWhileRunning",
      "settings.keepAwakeWhileRunningDesc",
      "settings.network",
      "settings.proxy",
      "settings.proxySystem",
      "settings.proxyDirect",
      "settings.proxyCustom",
      "settings.proxyUrl",
      "settings.networkRelaxedMode",
      "settings.networkRelaxedModeDesc",
      "settings.networkRelaxedModeStrictDesc",
      "settings.preventScreenSleep",
      "settings.preventScreenSleepDesc",
    ],
  },
  {
    id: "ai",
    labelKey: "settings.nav.ai",
    titleKey: "settings.ai",
    group: "preferences",
    keywordKeys: [
      "settings.permissions",
      "settings.permissionMode",
      "settings.permissionModeAsk",
      "settings.permissionModeAcceptEdits",
      "settings.permissionModeAuto",
      "settings.defaultsTitle",
      "settings.imageModel",
      "settings.mode",
      "settings.commandShell",
      "settings.linkOpenTarget",
      "settings.enterToSend",
      "settings.infiniteProviderRetry",
      "settings.infiniteProviderRetryDesc",
      "settings.smoothStreaming",
      "settings.smoothStreamingDesc",
      "settings.thinkingDisplayMode",
      "settings.thinkingDisplayDetailed",
      "settings.thinkingDisplayCompact",
      "settings.contextUsageDisplay",
      "settings.contextUsageDisplayRemaining",
      "settings.contextUsageDisplayUsed",
      "settings.promptEnhancementTitle",
      "settings.promptEnhancementDesc",
      "settings.promptEnhancementCustomTemplate",
      "settings.promptEnhancementEdit",
      "settings.promptEnhancementUserTemplate",
      "settings.promptEnhancementModelTitle",
      "settings.promptEnhancementModel",
      "settings.promptEnhancementModelFollow",
      "settings.promptEnhancementThinking",
      "settings.largePasteThreshold",
    ],
  },
  {
    id: "voice",
    labelKey: "settings.nav.voice",
    titleKey: "settings.voice",
    group: "preferences",
    developerOnly: true,
    experimentalBadgeKey: "settings.voiceExperimental",
    keywordKeys: [
      "settings.voiceEnable",
      "settings.voiceMicrophone",
      "settings.voiceLanguages",
      "settings.voiceChineseVariant",
      "settings.voiceModel",
      "settings.voiceLocalModels",
    ],
  },
  {
    id: "shortcuts",
    labelKey: "settings.nav.shortcuts",
    titleKey: "settings.shortcuts",
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
    id: "agent",
    labelKey: "settings.nav.models",
    titleKey: "settings.configuration",
    group: "agent",
    keywordKeys: [
      "settings.providers",
      "settings.models",
      "settings.defaultModel",
      "settings.apiKey",
      "settings.baseUrl",
      "settings.apiStyle",
      // Subscription accounts share the service list (D625).
      "settings.vendorAccounts",
      "settings.vendorSubscription",
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
    id: "import",
    labelKey: "settings.nav.import",
    titleKey: "settings.import",
    group: "workspace",
    keywordKeys: [
      "settings.importTitle",
      "settings.importModelsTitle",
      "settings.importSourceClaudeCode",
      "settings.importSourceOpenCode",
      "settings.importSourceCodex",
      "settings.importSourcePi",
      "settings.importSourceCcSwitch",
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
    id: "index",
    labelKey: "settings.nav.index",
    titleKey: "settings.index",
    // Host/workspace lifecycle — the switch, its status and the rebuild/clear
    // actions — so it joins the Workspace group instead of a group of its own.
    group: "workspace",
    keywordKeys: [
      "index.card.health",
      "index.card.files",
      "index.card.size",
      "index.action.rebuild",
      "index.action.clear",
    ],
  },
  {
    id: "sync",
    labelKey: "settings.nav.sync",
    titleKey: "settings.configSync.title",
    group: "system",
    developerOnly: true,
    experimentalBadgeKey: "settings.configSync.experimental",
    keywordKeys: [
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
    developerOnly: true,
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
 * Destinations the current mode offers, in rail order. `developerMode` comes
 * from `AppSettings.developerMode`; when it is off the developer-only rows are
 * absent rather than disabled.
 */
export function visibleSettingsNav(developerMode: boolean): SettingsNavEntry[] {
  return SETTINGS_NAV.filter((entry) => entry.developerOnly !== true || developerMode);
}

/**
 * True when `tab` is a destination the current mode hides, so a caller holding
 * a stale selection can fall back instead of rendering a page the rail no
 * longer offers.
 */
export function isSettingsDestinationHidden(
  tab: SettingsTabId,
  developerMode: boolean,
): boolean {
  const entry = SETTINGS_NAV.find((candidate) => candidate.id === tab);
  return entry?.developerOnly === true && !developerMode;
}

export type SettingsSearchHit = {
  tab: SettingsTabId;
  tabLabelKey: string;
  /** Matched row key; null when the tab label itself matched. */
  rowKey: string | null;
};

export type SettingsSearchOptions = {
  limit?: number;
  /** Search mirrors the rail, so developer-only tabs stay out of the results. */
  developerMode?: boolean;
};

export function searchSettings(
  query: string,
  t: (key: string) => string,
  { limit = 8, developerMode = false }: SettingsSearchOptions = {},
): SettingsSearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits: SettingsSearchHit[] = [];
  for (const entry of visibleSettingsNav(developerMode)) {
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
