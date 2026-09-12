import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type {
  AppSettings,
  GlobalPermissionMode,
  ShortcutPlatform,
} from "@pi-desktop/shared";
import { useAppStore } from "../../stores/app-store";
import { api } from "../../lib/api";
import {
  SETTINGS_NAV,
  SETTINGS_NAV_GROUP_LABELS,
  type SettingsNavGroupId,
} from "../../lib/settings-search";
import {
  IconArchive,
  IconBookOpen,
  IconBot,
  IconChevronLeft,
  IconDownload,
  IconFileText,
  IconInfo,
  IconKeyboard,
  IconSearch,
  IconServer,
  IconSliders,
  IconSparkles,
} from "../../components/icons";
import { Button, cx } from "../../components/ui";
import { ModelConfigPage } from "../../components/settings/ModelConfigPage";
import { KeyboardShortcutsSection } from "../../components/settings/KeyboardShortcutsSection";
import { FontFamilyRow } from "../../components/settings/FontFamilyRow";
import { FontSizeRow } from "../../components/settings/FontSizeRow";
import { LanguageRow } from "../../components/settings/LanguageRow";
import { ThemeRow } from "../../components/settings/ThemeRow";
import { NetworkProxySection } from "../../components/settings/NetworkProxySection";
import { ProjectsPage } from "../../pages/ProjectsPage";
import { AgentSkillsPage } from "../../components/settings/AgentSkillsPage";
import { AgentMcpPage } from "../../components/settings/AgentMcpPage";
import { AgentSubagentsPage } from "../../components/settings/AgentSubagentsPage";
import {
  CommandShellRow,
  ContextUsageDisplayRow,
  LargePasteThresholdRow,
  LinkOpenTargetRow,
  SettingsCard,
  SettingsRow,
} from "./primitives";
import {
  AgentInstructionsSection,
  ImportSection,
  UpdatesRow,
} from "./agent-sections";
import { CloseBehaviorSection, DeveloperSection } from "./developer-sections";

type SettingsTab = ReturnType<typeof useAppStore.getState>["settingsTab"];

type NavItem = {
  id: SettingsTab;
  labelKey: string;
  titleKey: string;
  icon: ReactNode;
  group: SettingsNavGroupId;
  /** i18n keys of the rows inside the tab; search matches their translations. */
  keywordKeys: string[];
};

export function SettingsPage() {
  const { t } = useTranslation();
  const tab = useAppStore((s) => s.settingsTab);
  const setSettingsTab = useAppStore((s) => s.setSettingsTab);
  const settingsAnchor = useAppStore((s) => s.settingsAnchor);
  const setSettingsAnchor = useAppStore((s) => s.setSettingsAnchor);
  const setPage = useAppStore((s) => s.setPage);
  const settings = useAppStore((s) => s.settings);
  const version = useAppStore((s) => s.version);
  const refreshProviders = useAppStore((s) => s.refreshProviders);
  const platform = (window.piDesktop?.platform ?? "darwin") as ShortcutPlatform;

  const [query, setQuery] = useState("");
  const [recoveringSettings, setRecoveringSettings] = useState(!settings);
  const [settingsRecoveryFailed, setSettingsRecoveryFailed] = useState(false);

  const recoverSettings = useCallback(async () => {
    setRecoveringSettings(true);
    setSettingsRecoveryFailed(false);
    try {
      const recovered = await api.getSettings();
      useAppStore.setState({ settings: recovered });
    } catch {
      setSettingsRecoveryFailed(true);
    } finally {
      setRecoveringSettings(false);
    }
  }, []);

  useEffect(() => {
    if (settings) return;
    void recoverSettings();
  }, [settings, recoverSettings]);

  // Arriving from the global search dialog: scroll to and flash the row
  // whose title matches the pending anchor key. Rows are located by their
  // translated title so async tab content (providers, import) needs no
  // per-row wiring; a short retry window covers late mounts.
  useEffect(() => {
    if (!settingsAnchor) return;
    const target = t(settingsAnchor).trim();
    let cancelled = false;
    let timer: number | undefined;
    const tryFind = (attempt: number) => {
      if (cancelled) return;
      const titles = document.querySelectorAll<HTMLElement>(
        ".settings-content .settings-row-title, .settings-content .settings-card-heading",
      );
      const match = [...titles].find(
        (node) => node.textContent?.trim() === target,
      );
      if (match) {
        const row =
          match.closest<HTMLElement>(".settings-row") ??
          match.closest<HTMLElement>(".settings-card-block") ??
          match;
        row.scrollIntoView({ block: "center" });
        row.classList.add("settings-anchor-flash");
        window.setTimeout(
          () => row.classList.remove("settings-anchor-flash"),
          1800,
        );
        setSettingsAnchor(null);
        return;
      }
      if (attempt < 8) timer = window.setTimeout(() => tryFind(attempt + 1), 120);
      else setSettingsAnchor(null);
    };
    tryFind(0);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [settingsAnchor, tab, t, setSettingsAnchor]);

  const saveSettings = async (patch: Partial<AppSettings>) => {
    if (!settings) return;
    const nextSettings = { ...settings, ...patch };
    await api.setSettings(nextSettings);
    useAppStore.setState({ settings: nextSettings });
    await refreshProviders();
  };

  // Nav structure comes from the shared settings index (lib/settings-search)
  // so the global search dialog and this page stay in sync; only the icons
  // are view-level.
  const navItems: NavItem[] = useMemo(() => {
    const iconFor: Record<SettingsTab, ReactNode> = {
      // Semantic Lucide glyphs for the settings destinations.
      general: <IconSliders size={14} />,
      ai: <IconSparkles size={14} />,
      shortcuts: <IconKeyboard size={14} />,
      instructions: <IconFileText size={14} />,
      agent: <IconBot size={14} />,
      skills: <IconBookOpen size={14} />,
      mcp: <IconServer size={14} />,
      subagents: <IconBot size={14} />,
      import: <IconDownload size={14} />,
      projects: <IconArchive size={14} />,
      about: <IconInfo size={14} />,
    };
    return SETTINGS_NAV.map((entry) => ({
      id: entry.id,
      labelKey: entry.labelKey,
      titleKey: entry.titleKey,
      icon: iconFor[entry.id],
      group: entry.group,
      keywordKeys: entry.keywordKeys,
    }));
  }, []);

  // Search matches the tab label and the titles of the rows inside it, so
  // typing e.g. "theme" or "主题" surfaces Basics even though the tab is
  // named differently.
  const filteredItems = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return navItems;
    return navItems.filter((item) =>
      [t(item.labelKey), ...item.keywordKeys.map((key) => t(key))].some((text) =>
        text.toLowerCase().includes(q),
      ),
    );
  }, [navItems, query, t]);

  // Keep the destination index flat for search, while giving the rail titled
  // visual clusters so the eight rows do not read as one dense block.
  const filteredGroups = useMemo(() => {
    const groups = new Map<SettingsNavGroupId, NavItem[]>();
    for (const item of filteredItems) {
      const items = groups.get(item.group) ?? [];
      items.push(item);
      groups.set(item.group, items);
    }
    return [...groups.entries()].map(([id, items]) => ({ id, items }));
  }, [filteredItems]);

  const activeTitleKey =
    navItems.find((item) => item.id === tab)?.titleKey ?? "settings.title";
  const tabNeedsSettings = ["general", "ai", "shortcuts", "agent"].includes(tab);

  return (
    <div className="settings-shell settings-shell-full">
      <div className="settings-titlebar" aria-hidden="true" />
      <aside className="settings-nav" aria-label={t("settings.title")}>
        <div className="settings-nav-top drag">
          <button
            type="button"
            className="settings-back no-drag"
            onClick={() => setPage("chat")}
          >
            <IconChevronLeft size={15} />
            <span>{t("settings.backToApp")}</span>
          </button>
          <div className="settings-search-wrap no-drag">
            <IconSearch size={14} />
            <input
              className="settings-search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("settings.searchPlaceholder")}
              aria-label={t("settings.search")}
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
            />
          </div>
        </div>

        <div className="settings-nav-scroll no-drag">
          {filteredGroups.length === 0 ? (
            <div className="settings-nav-empty">{t("settings.noResults")}</div>
          ) : (
            filteredGroups.map(({ id, items }) => (
              <div key={id} className="settings-nav-group">
                <div className="settings-nav-group-label">
                  {t(SETTINGS_NAV_GROUP_LABELS[id])}
                </div>
                {items.map((item) => (
                  <button
                    key={item.id}
                    className={cx("settings-nav-item", tab === item.id && "active")}
                    onClick={() => setSettingsTab(item.id)}
                  >
                    <span className="settings-nav-icon">{item.icon}</span>
                    <span className="settings-nav-label">{t(item.labelKey)}</span>
                  </button>
                ))}
              </div>
            ))
          )}
        </div>
      </aside>

      <div className="settings-content">
        <div className="settings-content-inner">
          <h1 className="settings-section-title">{t(activeTitleKey)}</h1>

          {tabNeedsSettings && !settings ? (
            <div className="settings-recovery" role="status" aria-live="polite">
              {recoveringSettings ? (
                <>
                  <span className="route-pending-indicator" aria-hidden />
                  <span>{t("common.loading")}</span>
                </>
              ) : settingsRecoveryFailed ? (
                <>
                  <span>{t("errors.HOST_UNAVAILABLE")}</span>
                  <Button variant="secondary" onClick={() => void recoverSettings()}>
                    {t("errors.action.retry")}
                  </Button>
                </>
              ) : null}
            </div>
          ) : null}

          {tab === "general" && settings && (
            <div className="settings-stack">
              <SettingsCard title={t("settings.appearance")}>
                <ThemeRow settings={settings} saveSettings={saveSettings} />
                <LanguageRow settings={settings} saveSettings={saveSettings} />
                <FontFamilyRow settings={settings} saveSettings={saveSettings} />
                <FontSizeRow settings={settings} saveSettings={saveSettings} />
              </SettingsCard>

              <NetworkProxySection settings={settings} saveSettings={saveSettings} />

              {platform !== "darwin" && <CloseBehaviorSection />}
            </div>
          )}

          {tab === "ai" && settings && (
            <div className="settings-stack">
              <SettingsCard title={t("settings.permissions")}>
                <SettingsRow
                  title={t("settings.permissionMode")}
                  description={t("settings.permissionModeDesc")}
                >
                  <select
                    className="field-select"
                    aria-label={t("settings.permissionMode")}
                    value={settings.defaultPermissionMode ?? "ask"}
                    onChange={(e) =>
                      void saveSettings({
                        defaultPermissionMode: e.target.value as GlobalPermissionMode,
                      })
                    }
                  >
                    <option value="ask">{t("settings.permissionModeAsk")}</option>
                    <option value="accept-edits">
                      {t("settings.permissionModeAcceptEdits")}
                    </option>
                    <option value="auto">{t("settings.permissionModeAuto")}</option>
                  </select>
                </SettingsRow>
              </SettingsCard>

              <SettingsCard title={t("settings.defaultsTitle")}>
                <SettingsRow title={t("settings.mode")} description={t("settings.modeDesc")}>
                  <div
                    className="settings-segment"
                    role="group"
                    aria-label={t("settings.mode")}
                  >
                    {([
                      ["agent", "settings.modeAgent"],
                      ["plan", "settings.modePlan"],
                      ["goal", "settings.modeGoal"],
                    ] as const).map(([value, labelKey]) => (
                      <button
                        key={value}
                        type="button"
                        className={cx(
                          "settings-segment-item",
                          settings.defaultMode === value && "active",
                        )}
                        aria-pressed={settings.defaultMode === value}
                        onClick={() => void saveSettings({ defaultMode: value })}
                      >
                        {t(labelKey)}
                      </button>
                    ))}
                  </div>
                </SettingsRow>
                <CommandShellRow settings={settings} saveSettings={saveSettings} />
                <LinkOpenTargetRow settings={settings} saveSettings={saveSettings} />
                <ContextUsageDisplayRow
                  settings={settings}
                  saveSettings={saveSettings}
                />
                <SettingsRow
                  title={t("settings.enterToSend")}
                  description={t("settings.enterToSendDesc")}
                >
                  <button
                    type="button"
                    className={cx("settings-toggle", settings.enterToSend && "on")}
                    role="switch"
                    aria-checked={settings.enterToSend}
                    aria-label={t("settings.enterToSend")}
                    onClick={() =>
                      void saveSettings({ enterToSend: !settings.enterToSend })
                    }
                  >
                    <span className="settings-toggle-thumb" />
                  </button>
                </SettingsRow>
                <LargePasteThresholdRow
                  settings={settings}
                  saveSettings={saveSettings}
                />
              </SettingsCard>
            </div>
          )}

          {tab === "shortcuts" && settings && (
            <div className="settings-stack">
              <KeyboardShortcutsSection
                settings={settings}
                platform={platform}
                saveSettings={saveSettings}
              />
            </div>
          )}

          {tab === "agent" && <ModelConfigPage />}

          {tab === "skills" && <AgentSkillsPage />}

          {tab === "mcp" && <AgentMcpPage />}

          {tab === "subagents" && <AgentSubagentsPage />}

          {tab === "instructions" && <AgentInstructionsSection />}

          {tab === "import" && <ImportSection />}

          {tab === "projects" && <ProjectsPage />}

          {tab === "about" && (
            <div className="settings-stack">
              <SettingsCard>
                <SettingsRow title={t("settings.application")} description={t("settings.applicationDesc")}>
                  <div className="settings-about-meta">
                    <div className="font-medium">
                      {version?.name || "PI-Desktop"} {version?.version}
                    </div>
                    <div className="font-mono text-xs-plus text-text-muted">
                      protocol {version?.protocolVersion} · host {version?.hostVersion}
                    </div>
                  </div>
                </SettingsRow>
                <SettingsRow title={t("settings.logs")} description={t("settings.logsDesc")}>
                  <Button variant="secondary" onClick={() => void api.openLogs()}>
                    {t("settings.openLogs")}
                  </Button>
                </SettingsRow>
                <SettingsRow
                  title={t("settings.feedback")}
                  description={t("settings.feedbackDesc")}
                >
                  <Button
                    variant="secondary"
                    onClick={() => void api.openFeedback().catch(() => undefined)}
                  >
                    {t("settings.openFeedback")}
                  </Button>
                </SettingsRow>
                <UpdatesRow currentVersion={version?.version} />
              </SettingsCard>

              {settings && (
                <DeveloperSection settings={settings} saveSettings={saveSettings} />
              )}
            </div>
          )}

        </div>
      </div>
    </div>
  );
}
