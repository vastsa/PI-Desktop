/**
 * Data-only index of the settings IA, shared by the settings page nav and
 * the global search dialog. Keyword keys are the i18n keys of the rows
 * rendered inside each tab; search matches their translations, so a query
 * like "主题" or "theme" can surface the tab that owns the row.
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
      "settings.font",
      "settings.closeBehaviorTitle",
      "settings.closeBehaviorTray",
      "settings.closeBehaviorQuit",
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
      "settings.mode",
      "settings.commandShell",
      "settings.enterToSend",
      "settings.largePasteThreshold",
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
    ],
  },
  {
    id: "skills",
    labelKey: "settings.nav.skills",
    titleKey: "settings.skills",
    group: "agent",
    keywordKeys: [
      "settings.skillsDescription",
      "settings.skillsGlobalPath",
      "settings.skillsProjectPath",
      "settings.globalScopeDescription",
      "settings.projectScopeDescription",
      "settings.capabilityPriority",
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
      "settings.mcpDescription",
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
      "settings.subagentsDescription",
      "settings.subagentsGlobalPath",
      "settings.subagentsOnlyGlobal",
      "settings.globalScopeDescription",
      "extensions.subagents.add",
      "extensions.subagents.edit",
      "extensions.subagents.remove",
      "extensions.subagents.reveal",
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
      "settings.importSourceClaudeCode",
      "settings.importSourceOpenCode",
      "settings.importSourceCodex",
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
      "settings.developer",
      "settings.developerMode",
      "settings.devTools",
    ],
  },
];

export type SettingsSearchHit = {
  tab: SettingsTabId;
  tabLabelKey: string;
  /** Matched row key; null when the tab label itself matched. */
  rowKey: string | null;
};

export function searchSettings(
  query: string,
  t: (key: string) => string,
  limit = 8,
): SettingsSearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits: SettingsSearchHit[] = [];
  for (const entry of SETTINGS_NAV) {
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
