import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type {
  AppSettings,
  PluginScenicThemesDestinationMeta,
  ShortcutPlatform,
} from "@pi-desktop/shared";
import { useAppStore } from "../../stores/app-store";
import { api } from "../../lib/api";
import {
  DEFAULT_SETTINGS_TAB,
  isSettingsDestinationHidden,
  SETTINGS_NAV_GROUP_LABELS,
  visibleSettingsNav,
  type SettingsNavGroupId,
} from "../../lib/settings-search";
import { pluginViewIcon } from "../../lib/plugin-view-icons";
import {
  IconArchive,
  IconBookOpen,
  IconBot,
  IconChat,
  IconChevronLeft,
  IconFileText,
  IconGlobe,
  IconInfo,
  IconKeyboard,
  IconMonitor,
  IconPalette,
  IconSearch,
  IconServer,
  IconSliders,
  IconSparkles,
  IconCloudDown,
  IconMic,
} from "../../components/icons";
import { Badge, Button, cx } from "../../components/ui";
import { ModelConfigPage } from "../../components/settings/ModelConfigPage";
import { KeyboardShortcutsSection } from "../../components/settings/KeyboardShortcutsSection";
import { ProjectsPage } from "../../pages/ProjectsPage";
import { AgentSkillsPage } from "../../components/settings/AgentSkillsPage";
import { AgentMcpPage } from "../../components/settings/AgentMcpPage";
import { AgentSubagentsPage } from "../../components/settings/AgentSubagentsPage";
import { RemoteHostsPage } from "../../components/settings/RemoteHostsPage";
import { VoiceSettingsSection } from "./voice/VoiceSettingsSection";
import { AgentInstructionsSection } from "./agent-sections";
import { PluginScenicThemesDestination } from "../../components/settings/PluginScenicThemesDestination";
import { ConfigSyncPage } from "../../components/settings/ConfigSyncPage";
import { AboutSettings } from "./pages/AboutSettings";
import { AgentBehaviorSettings } from "./pages/AgentBehaviorSettings";
import { AppearanceSettings } from "./pages/AppearanceSettings";
import { ConversationSettings } from "./pages/ConversationSettings";
import { SystemSettings } from "./pages/SystemSettings";

type SettingsTab = ReturnType<typeof useAppStore.getState>["settingsTab"];

type NavItem = {
  id: SettingsTab;
  labelKey: string;
  titleKey: string;
  subtitleKey?: string;
  icon: ReactNode;
  group: SettingsNavGroupId;
  experimentalBadgeKey?: string;
  /** i18n keys of the rows inside the tab; search matches their translations. */
  keywordKeys: string[];
};

export function SettingsPage() {
  const { t } = useTranslation();
  const tab = useAppStore((s) => s.settingsTab);
  const setSettingsTab = useAppStore((s) => s.setSettingsTab);
  const settingsAnchor = useAppStore((s) => s.settingsAnchor);
  const settingsTabNonce = useAppStore((s) => s.settingsTabNonce);
  const setSettingsAnchor = useAppStore((s) => s.setSettingsAnchor);
  const setPage = useAppStore((s) => s.setPage);
  const settings = useAppStore((s) => s.settings);
  const refreshProviders = useAppStore((s) => s.refreshProviders);
  const platform = (window.piDesktop?.platform ?? "darwin") as ShortcutPlatform;

  // Experimental feature surfaces remain available in development builds only.
  const includeDevelopmentOnly = import.meta.env.DEV;
  const developerMode = settings?.developerMode === true;
  const navEntries = useMemo(
    () => visibleSettingsNav(developerMode, includeDevelopmentOnly),
    [developerMode, includeDevelopmentOnly],
  );
  const tabHidden = isSettingsDestinationHidden(
    tab,
    developerMode,
    includeDevelopmentOnly,
  );

  const [query, setQuery] = useState("");
  const [recoveringSettings, setRecoveringSettings] = useState(!settings);
  const [settingsRecoveryFailed, setSettingsRecoveryFailed] = useState(false);
  const [extensions, setExtensions] = useState<PluginScenicThemesDestinationMeta[]>([]);
  const [activeExtension, setActiveExtension] = useState<PluginScenicThemesDestinationMeta | null>(null);
  const seenSettingsTabNonce = useRef(settingsTabNonce);
  // setSettingsTab means "show this built-in category", even when the tab id
  // does not change. Dismiss a plugin page before paint; an anchor-only deep
  // link has to do the same or the row lookup hits the plugin instead.
  if (
    seenSettingsTabNonce.current !== settingsTabNonce ||
    (activeExtension && settingsAnchor)
  ) {
    seenSettingsTabNonce.current = settingsTabNonce;
    if (activeExtension) setActiveExtension(null);
  }
  const contentRef = useRef<HTMLDivElement>(null);
  const settingsSearchRef = useRef<HTMLInputElement>(null);
  const destination = activeExtension ? `extension:${activeExtension.ref}` : `builtin:${tab}`;

  useLayoutEffect(() => {
    settingsSearchRef.current?.focus({ preventScroll: true });
  }, []);

  useLayoutEffect(() => {
    // Reset before paint and before the search-anchor effect positions its row.
    if (contentRef.current) contentRef.current.scrollTop = 0;
  }, [destination]);

  useEffect(() => {
    const refresh = () => void api.listPluginScenicThemesDestinations().then(setExtensions, () => setExtensions([]));
    refresh();
    return api.onPluginChanged(refresh);
  }, []);

  useEffect(() => {
    if (activeExtension && !extensions.some((entry) => entry.ref === activeExtension.ref)) {
      setActiveExtension(null);
      setSettingsTab(DEFAULT_SETTINGS_TAB);
    }
  }, [activeExtension, extensions, setSettingsTab]);

  // A hidden destination must not keep rendering: leave the page the rail no
  // longer offers (for example Cloud sync or Remote Hosts after developer mode
  // is switched off) and fall back to the default destination.
  useEffect(() => {
    if (!settings || !tabHidden) return;
    setSettingsTab(DEFAULT_SETTINGS_TAB);
  }, [settings, tabHidden, setSettingsTab]);

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
  // whose title matches the pending anchor key. This runs after the
  // destination reset and before paint, so a category change does not flash
  // the top. Rows are located by their translated title so async tab content
  // (providers, import) needs no per-row wiring; a short retry window covers
  // late mounts.
  useLayoutEffect(() => {
    if (!settingsAnchor) return;
    const target = t(settingsAnchor).trim();
    let cancelled = false;
    let timer: number | undefined;
    const tryFind = (attempt: number) => {
      if (cancelled) return;
      const titles = document.querySelectorAll<HTMLElement>(
        ".settings-content .settings-row-title, .settings-content .settings-card-heading, .settings-content .about-update-title",
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

  const selectPluginTheme = async (theme: string) => {
    await saveSettings({ theme: theme as AppSettings["theme"] });
  };

  // Nav structure comes from the shared settings index (lib/settings-search)
  // so the global search dialog and this page stay in sync; only the icons
  // are view-level.
  const navItems: NavItem[] = useMemo(() => {
    const iconFor: Record<SettingsTab, ReactNode> = {
      // Semantic Lucide glyphs for the settings destinations.
      appearance: <IconPalette size={14} />,
      chat: <IconChat size={14} />,
      shortcuts: <IconKeyboard size={14} />,
      voice: <IconMic size={14} />,
      behavior: <IconSliders size={14} />,
      agent: <IconBot size={14} />,
      instructions: <IconFileText size={14} />,
      skills: <IconBookOpen size={14} />,
      mcp: <IconServer size={14} />,
      subagents: <IconSparkles size={14} />,
      projects: <IconArchive size={14} />,
      system: <IconMonitor size={14} />,
      sync: <IconCloudDown size={14} />,
      remoteHosts: <IconGlobe size={14} />,
      about: <IconInfo size={14} />,
    };
    return navEntries.map((entry) => ({
      id: entry.id,
      labelKey: entry.labelKey,
      titleKey: entry.titleKey,
      subtitleKey: entry.subtitleKey,
      icon: iconFor[entry.id],
      group: entry.group,
      experimentalBadgeKey: entry.experimentalBadgeKey,
      keywordKeys: entry.keywordKeys,
    }));
  }, [navEntries]);

  // Search matches the tab label and the titles of the rows inside it, so
  // typing e.g. "theme" or "主题" surfaces Appearance even though the tab is
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
  // visual clusters so the rows do not read as one dense block.
  const filteredGroups = useMemo(() => {
    const groups = new Map<SettingsNavGroupId, NavItem[]>();
    for (const item of filteredItems) {
      const items = groups.get(item.group) ?? [];
      items.push(item);
      groups.set(item.group, items);
    }
    return [...groups.entries()].map(([id, items]) => ({ id, items }));
  }, [filteredItems]);

  const activeNavItem = navItems.find((item) => item.id === tab);
  const activeTitleKey = activeNavItem?.titleKey ?? "settings.title";
  const tabNeedsSettings = ["appearance", "chat", "behavior", "system", "shortcuts", "agent"].includes(tab);

  return (
    <div className="settings-shell settings-shell-full">
      <div className="settings-titlebar" aria-hidden="true" />
      <aside className="settings-nav sidebar-surface" aria-label={t("settings.title")}>
        <div className="settings-nav-top drag">
          <div className="settings-search-wrap no-drag">
            <IconSearch size={14} />
            <input
              ref={settingsSearchRef}
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
                    onClick={() => {
                      setActiveExtension(null);
                      setSettingsTab(item.id);
                    }}
                  >
                    <span className="settings-nav-icon">{item.icon}</span>
                    <span className="settings-nav-label">{t(item.labelKey)}</span>
                    {item.experimentalBadgeKey ? (
                      <Badge tone="warning" className="settings-nav-experimental">
                        {t(item.experimentalBadgeKey)}
                      </Badge>
                    ) : null}
                  </button>
                ))}
              </div>
            ))
          )}
          {extensions.length > 0 && (
            <div className="settings-nav-group">
              <div className="settings-nav-group-label">{t("settings.groupExtensions")}</div>
              {extensions.filter((entry) => {
                const q = query.trim().toLowerCase();
                return !q || [entry.label, ...entry.keywords].some((value) => value.toLowerCase().includes(q));
              }).map((entry) => {
                const ExtensionIcon = pluginViewIcon(entry.icon) ?? IconPalette;
                return (
                  <button
                    key={entry.ref}
                    className={cx("settings-nav-item", activeExtension?.ref === entry.ref && "active")}
                    onClick={() => setActiveExtension(entry)}
                  >
                    <span className="settings-nav-icon"><ExtensionIcon size={14} /></span>
                    <span className="settings-nav-label">{entry.label}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Pinned to the rail's bottom so it lands on the same line as the
            main shell's sidebar footer icon row. Both the band and the control
            stay explicitly non-draggable, like the rail's other controls. */}
        <div className="settings-nav-footer no-drag">
          <button
            type="button"
            className="settings-back no-drag"
            data-nav="back-to-app"
            onClick={() => setPage("chat")}
          >
            <IconChevronLeft size={15} />
            <span>{t("settings.backToApp")}</span>
          </button>
        </div>
      </aside>

      <div className="settings-content" ref={contentRef}>
        <div className="settings-content-inner">
          <div className="settings-content-enter">
          {/*
            The page opens by saying where you are and what the destination
            decides (D684): the rail's glyph again at page scale, the title,
            and one line of orientation for destinations whose own content does
            not already start with a description.
          */}
          <header className="settings-page-header">
            <span className="settings-page-icon" aria-hidden="true">
              {activeExtension
                ? (() => {
                    const ExtensionIcon = pluginViewIcon(activeExtension.icon) ?? IconPalette;
                    return <ExtensionIcon size={18} />;
                  })()
                : activeNavItem?.icon}
            </span>
            <div className="settings-page-heading">
              <h1 className="settings-section-title">
                <span>{activeExtension?.label ?? t(activeTitleKey)}</span>
                {!activeExtension && activeNavItem?.experimentalBadgeKey ? (
                  <Badge tone="warning">{t(activeNavItem.experimentalBadgeKey)}</Badge>
                ) : null}
              </h1>
              {!activeExtension && activeNavItem?.subtitleKey ? (
                <p className="settings-page-subtitle">{t(activeNavItem.subtitleKey)}</p>
              ) : null}
            </div>
          </header>

          {activeExtension ? (
            <PluginScenicThemesDestination destination={activeExtension} selectTheme={selectPluginTheme} />
          ) : <>

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

          {tab === "appearance" && settings && (
            <AppearanceSettings
              settings={settings}
              saveSettings={saveSettings}
              platform={platform}
            />
          )}

          {tab === "chat" && settings && (
            <ConversationSettings settings={settings} saveSettings={saveSettings} />
          )}

          {tab === "behavior" && settings && (
            <AgentBehaviorSettings settings={settings} saveSettings={saveSettings} />
          )}

          {tab === "system" && settings && (
            <SystemSettings
              settings={settings}
              saveSettings={saveSettings}
              platform={platform}
            />
          )}

          {tab === "voice" && !tabHidden && settings && (
            <VoiceSettingsSection
              t={t}
              settings={settings}
              saveSettings={saveSettings}
            />
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


          {tab === "projects" && <ProjectsPage />}

          {tab === "sync" && !tabHidden && <ConfigSyncPage />}

          {tab === "remoteHosts" && !tabHidden && <RemoteHostsPage />}

          {tab === "about" && (
            <AboutSettings settings={settings ?? null} saveSettings={saveSettings} />
          )}
          </>}

          </div>
        </div>
      </div>
    </div>
  );
}
