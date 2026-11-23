import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type {
  AppSettings,
  PluginScenicThemesDestinationMeta,
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
  IconWorkflow,
} from "../../components/icons";
import { Badge, cx } from "../../components/ui";
import { PluginScenicThemesDestination } from "../../components/settings/PluginScenicThemesDestination";
import { SettingsDestinationContent, type SettingsTab } from "./SettingsDestinationContent";
import { useSettingsPersistence } from "./useSettingsPersistence";

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

/**
 * Settings rail + destination content. Hosted by the Settings dialog; each
 * destination body comes from `SettingsDestinationContent` so other surfaces
 * can embed one destination without the rail.
 */
export function SettingsPage() {
  const { t } = useTranslation();
  const tab = useAppStore((s) => s.settingsTab);
  const setSettingsTab = useAppStore((s) => s.setSettingsTab);
  const settingsAnchor = useAppStore((s) => s.settingsAnchor);
  const settingsTabNonce = useAppStore((s) => s.settingsTabNonce);
  const setSettingsAnchor = useAppStore((s) => s.setSettingsAnchor);
  const { settings, saveSettings } = useSettingsPersistence();

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
      modes: <IconWorkflow size={14} />,
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

  return (
    <div className="settings-shell settings-shell-full">
      <aside className="settings-nav sidebar-surface" aria-label={t("settings.title")}>
        <div className="settings-nav-top">
          <div className="settings-search-wrap">
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

        <div className="settings-nav-scroll">
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

          <SettingsDestinationContent tab={tab} tabHidden={tabHidden} />
          </>}

          </div>
        </div>
      </div>
    </div>
  );
}
