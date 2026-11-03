import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  isThemeColorScheme,
  type LauncherCatalog,
} from "@pi-desktop/shared";
import { api } from "../lib/api";
import {
  LAUNCHER_COLUMNS,
  buildLauncherPinnedSection,
  buildLauncherRecentSection,
  indexLauncherCatalog,
  searchLauncherItems,
  type LauncherSection,
  type LauncherTile,
} from "../lib/launcher-search";
import {
  readLauncherState,
  pruneLauncherState,
  rememberLauncherUse,
  setLauncherAliases,
  setLauncherPinned,
  type LauncherStoreSnapshot,
} from "../lib/launcher-store";
import { LauncherTileButton } from "./launcher/LauncherTileButton";
import { LauncherItemMenu } from "./launcher/LauncherItemMenu";
import { IconPlug, IconSearch } from "./icons";

/** Above this many matches the panel asks the user to keep typing. */
const UNLIMITED = Number.MAX_SAFE_INTEGER;
/** A background application scan is retried this many times before it is final. */
const SCAN_RETRY_LIMIT = 3;
const SCAN_RETRY_DELAY_MS = 1200;

function optionId(itemId: string): string {
  return `plugin-launcher-option-${itemId.replace(/[^a-zA-Z0-9_-]+/g, "-")}`;
}

/**
 * One titled grid of tiles.
 *
 * The header carries the section's affordance — expand when the grid had to drop
 * entries, collapse when it shows everything — and the grid itself is always
 * eight columns wide, so widening the window widens tiles instead of reflowing
 * them onto other rows.
 */
function LauncherSectionGrid({
  title,
  section,
  startIndex,
  activeIndex,
  disabled,
  onOpen,
  onMenu,
  action,
}: {
  title: string;
  section: LauncherSection;
  startIndex: number;
  activeIndex: number;
  disabled: boolean;
  onOpen: (tile: LauncherTile) => void;
  onMenu: (tile: LauncherTile) => void;
  action?: { label: string; title: string; onSelect: () => void };
}) {
  if (!section.tiles.length) return null;
  return (
    <section className="plugin-launcher-group" aria-label={title}>
      <header className="plugin-launcher-group-header">
        <h2>{title}</h2>
        {action ? (
          <button
            type="button"
            className="plugin-launcher-group-action"
            tabIndex={-1}
            onClick={action.onSelect}
          >
            {action.label}
          </button>
        ) : null}
      </header>
      <div className="plugin-launcher-grid" role="presentation">
        {section.tiles.map((tile, index) => (
          <LauncherTileButton
            key={tile.id}
            tile={tile}
            active={activeIndex === startIndex + index}
            disabled={disabled}
            optionId={optionId(tile.id)}
            onOpen={() => onOpen(tile)}
            onMenu={() => onMenu(tile)}
          />
        ))}
      </div>
    </section>
  );
}

export function PluginLauncher() {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [catalog, setCatalog] = useState<LauncherCatalog | null>(null);
  const [store, setStore] = useState<LauncherStoreSnapshot>(() => readLauncherState());
  const [activeIndex, setActiveIndex] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [menuTile, setMenuTile] = useState<LauncherTile | null>(null);
  const loadPromiseRef = useRef<Promise<void> | null>(null);
  const scanRetriesRef = useRef(0);

  useEffect(() => {
    let disposed = false;
    let mediaQuery: MediaQueryList | undefined;
    let onSystemThemeChange: (() => void) | undefined;
    const applyTheme = (preference: string) => {
      if (disposed) return;
      document.documentElement.dataset.theme = isThemeColorScheme(preference)
        ? preference
        : window.matchMedia("(prefers-color-scheme: light)").matches
          ? "light"
          : "dark";
    };

    void api
      .getSettings()
      .then((settings) => {
        applyTheme(settings.theme);
        if (isThemeColorScheme(settings.theme)) return;
        mediaQuery = window.matchMedia("(prefers-color-scheme: light)");
        onSystemThemeChange = () => applyTheme(settings.theme);
        mediaQuery.addEventListener("change", onSystemThemeChange);
      })
      .catch(() => applyTheme("system"));

    return () => {
      disposed = true;
      if (mediaQuery && onSystemThemeChange) {
        mediaQuery.removeEventListener("change", onSystemThemeChange);
      }
    };
  }, []);

  const load = useCallback(async (): Promise<void> => {
    if (loadPromiseRef.current) {
      await loadPromiseRef.current;
      return;
    }
    const request = (async () => {
      try {
        const next = await api.launcherCatalog();
        setCatalog(next);
        setError(null);
        const known = [
          ...next.plugins.map((plugin) => plugin.id),
          ...next.apps.map((app) => app.id),
        ];
        setStore(pruneLauncherState(known));
        if (next.appsScanning && scanRetriesRef.current < SCAN_RETRY_LIMIT) {
          scanRetriesRef.current += 1;
          window.setTimeout(() => {
            void load();
          }, SCAN_RETRY_DELAY_MS);
        }
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : String(loadError));
      } finally {
        setLoading(false);
      }
    })();
    loadPromiseRef.current = request;
    try {
      await request;
    } finally {
      if (loadPromiseRef.current === request) loadPromiseRef.current = null;
    }
  }, []);

  const reset = useCallback(() => {
    setQuery("");
    setActiveIndex(0);
    setExpanded(false);
    setOpeningId(null);
    setError(null);
    setMenuTile(null);
    scanRetriesRef.current = 0;
    setStore(readLauncherState());
    // Warm-up may run before the host is ready, so retry the persisted theme
    // when the launcher is actually shown instead of keeping the fallback.
    void api
      .getSettings()
      .then((settings) => {
        document.documentElement.dataset.theme = isThemeColorScheme(settings.theme)
          ? settings.theme
          : window.matchMedia("(prefers-color-scheme: light)").matches
            ? "light"
            : "dark";
      })
      .catch(() => undefined);
    inputRef.current?.focus();
    void load();
  }, [load]);

  useEffect(() => {
    reset();
    return api.onPluginLauncherShown(reset);
  }, [reset]);

  // Pins and aliases can be changed in another window; web storage already
  // broadcasts that, so the panel does not need its own cross-window channel.
  useEffect(() => {
    const onStorage = () => setStore(readLauncherState());
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const index = useMemo(
    () => (catalog ? indexLauncherCatalog(catalog, store) : null),
    [catalog, store],
  );
  const recentSection = useMemo(
    () =>
      index
        ? buildLauncherRecentSection(index, store, expanded ? UNLIMITED : undefined)
        : { tiles: [], total: 0 },
    [index, store, expanded],
  );
  const pinnedSection = useMemo(
    () =>
      index
        ? buildLauncherPinnedSection(index, store, expanded ? UNLIMITED : undefined)
        : { tiles: [], total: 0 },
    [index, store, expanded],
  );
  const matchSection = useMemo(
    () =>
      index
        ? searchLauncherItems(index, query, store)
        : { tiles: [], total: 0 },
    [index, query, store],
  );

  const searching = query.trim().length > 0;
  const navTiles = useMemo(
    () =>
      searching
        ? matchSection.tiles
        : [...recentSection.tiles, ...pinnedSection.tiles],
    [searching, matchSection.tiles, recentSection.tiles, pinnedSection.tiles],
  );

  useEffect(() => {
    setActiveIndex((current) =>
      navTiles.length ? Math.min(current, navTiles.length - 1) : 0,
    );
  }, [navTiles.length]);

  const openTile = useCallback(
    async (tile: LauncherTile | undefined) => {
      if (!tile || openingId) return;
      setOpeningId(tile.id);
      setError(null);
      try {
        if (tile.kind === "plugin" && tile.pluginId) {
          await api.launcherOpenPlugin({
            pluginId: tile.pluginId,
            ...(tile.trigger
              ? { triggerId: tile.trigger.id, payload: tile.trigger.payload }
              : {}),
          });
        } else {
          await api.launcherOpenApp(tile.id);
        }
        setStore(rememberLauncherUse(tile.id));
        await api.dismissPluginLauncher();
      } catch (openError) {
        setError(openError instanceof Error ? openError.message : String(openError));
        setOpeningId(null);
      }
    },
    [openingId],
  );

  const moveActive = useCallback(
    (delta: number) => {
      if (!navTiles.length) return;
      setActiveIndex((current) => {
        const next = current + delta;
        if (next < 0) return 0;
        if (next >= navTiles.length) return navTiles.length - 1;
        return next;
      });
    },
    [navTiles.length],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      // A Chinese IME confirms candidates with Enter and moves with arrows; the
      // panel must not open a tile while a composition is still in progress.
      if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        void api.dismissPluginLauncher();
        return;
      }
      if (event.key === "Enter") {
        if (!navTiles.length) return;
        event.preventDefault();
        void openTile(navTiles[activeIndex]);
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        moveActive(LAUNCHER_COLUMNS);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        moveActive(-LAUNCHER_COLUMNS);
        return;
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        moveActive(1);
        return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        moveActive(-1);
      }
    },
    [activeIndex, moveActive, navTiles, openTile],
  );

  const togglePin = useCallback((tile: LauncherTile) => {
    const pinned = store.pins.includes(tile.id);
    setStore(setLauncherPinned(tile.id, !pinned));
  }, [store.pins]);

  const saveAliases = useCallback((tile: LauncherTile, aliases: string[]) => {
    setStore(setLauncherAliases(tile.id, aliases));
  }, []);

  const emptyText = loading
    ? t("pluginLauncher.loading")
    : searching
      ? t("pluginLauncher.noResults")
      : catalog?.appsScanning
        ? t("pluginLauncher.scanningApps")
        : t("pluginLauncher.empty");

  const expandLabel = (section: LauncherSection) =>
    t("pluginLauncher.expandRecent", { count: section.total });

  return (
    <main className="plugin-launcher" aria-label={t("pluginLauncher.title")}>
      <section className="plugin-launcher-surface">
        <div className="plugin-launcher-search-row">
          <IconSearch size={18} aria-hidden />
          <input
            ref={inputRef}
            className="plugin-launcher-input"
            value={query}
            placeholder={t("pluginLauncher.placeholder")}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            role="combobox"
            aria-expanded={navTiles.length > 0}
            aria-controls="plugin-launcher-results"
            aria-activedescendant={
              navTiles[activeIndex] ? optionId(navTiles[activeIndex].id) : undefined
            }
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleKeyDown}
          />
          <span className="plugin-launcher-shortcut" aria-hidden>
            {window.piDesktop?.platform === "darwin" ? "⌥ Space" : "Alt + Space"}
          </span>
        </div>

        <div
          id="plugin-launcher-results"
          className={`plugin-launcher-results${expanded ? " expanded" : ""}`}
          role="listbox"
          aria-label={t("pluginLauncher.results")}
        >
          {searching ? (
            matchSection.tiles.length ? (
              <LauncherSectionGrid
                title={t("pluginLauncher.matches")}
                section={matchSection}
                startIndex={0}
                activeIndex={activeIndex}
                disabled={openingId !== null}
                onOpen={(tile) => void openTile(tile)}
                onMenu={setMenuTile}
                action={
                  matchSection.total > matchSection.tiles.length
                    ? {
                        label: t("pluginLauncher.overflow", {
                          count: matchSection.total - matchSection.tiles.length,
                        }),
                        title: t("pluginLauncher.overflowHint"),
                        onSelect: () => undefined,
                      }
                    : undefined
                }
              />
            ) : (
              <div className="plugin-launcher-empty" role="status">
                <IconPlug size={20} aria-hidden />
                <span>{emptyText}</span>
              </div>
            )
          ) : recentSection.tiles.length || pinnedSection.tiles.length ? (
            <>
              <LauncherSectionGrid
                title={t("pluginLauncher.recent")}
                section={recentSection}
                startIndex={0}
                activeIndex={activeIndex}
                disabled={openingId !== null}
                onOpen={(tile) => void openTile(tile)}
                onMenu={setMenuTile}
                action={
                  recentSection.total > recentSection.tiles.length || expanded
                    ? {
                        label: expanded
                          ? t("pluginLauncher.collapse")
                          : expandLabel(recentSection),
                        title: t("pluginLauncher.recent"),
                        onSelect: () => setExpanded((current) => !current),
                      }
                    : undefined
                }
              />
              <LauncherSectionGrid
                title={t("pluginLauncher.pinned")}
                section={pinnedSection}
                startIndex={recentSection.tiles.length}
                activeIndex={activeIndex}
                disabled={openingId !== null}
                onOpen={(tile) => void openTile(tile)}
                onMenu={setMenuTile}
                action={
                  pinnedSection.total > pinnedSection.tiles.length
                    ? {
                        label: t("pluginLauncher.showAll"),
                        title: t("pluginLauncher.pinned"),
                        onSelect: () => setExpanded(true),
                      }
                    : undefined
                }
              />
            </>
          ) : (
            <div className="plugin-launcher-empty" role="status">
              <IconPlug size={20} aria-hidden />
              <span>{emptyText}</span>
            </div>
          )}
        </div>

        <footer className="plugin-launcher-footer">
          <span>{t("pluginLauncher.navigateHint")}</span>
          <span>{t("pluginLauncher.openHint")}</span>
          <span>{t("pluginLauncher.dismissHint")}</span>
          {error ? <strong role="alert">{error}</strong> : null}
        </footer>

        {menuTile ? (
          <LauncherItemMenu
            tile={menuTile}
            pinned={store.pins.includes(menuTile.id)}
            aliases={store.aliases[menuTile.id] ?? []}
            onClose={() => setMenuTile(null)}
            onTogglePin={() => togglePin(menuTile)}
            onSaveAliases={(aliases) => saveAliases(menuTile, aliases)}
          />
        ) : null}
      </section>
    </main>
  );
}
