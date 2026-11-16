import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import {
  isThemeColorScheme,
  type LauncherCatalog,
} from "@pi-desktop/shared";
import { api } from "../lib/api";
import { resolveLauncherContentHeight } from "../lib/launcher-height";
import {
  LAUNCHER_COLUMNS,
  buildLauncherAllPluginsSection,
  buildLauncherPinnedSection,
  buildLauncherRecentSection,
  indexLauncherCatalog,
  searchLauncherItems,
  type LauncherSection,
  type LauncherTile,
} from "../lib/launcher-search";
import {
  LAUNCHER_PIN_LIMIT,
  pruneLauncherState,
  readLauncherState,
  rememberLauncherUse,
  setLauncherPinned,
  type LauncherStoreSnapshot,
} from "../lib/launcher-store";
import { LauncherTileButton } from "./launcher/LauncherTileButton";
import { IconPlug, IconSearch } from "./icons";

/** Above this many matches the panel asks the user to keep typing. */
const UNLIMITED = Number.MAX_SAFE_INTEGER;
/** A background application scan is retried this many times before it is final. */
const SCAN_RETRY_LIMIT = 3;
const SCAN_RETRY_DELAY_MS = 1200;
/** How long the pinned row shakes when the pin budget is already spent. */
const PINS_FULL_PULSE_MS = 320;

function optionId(itemId: string): string {
  return `plugin-launcher-option-${itemId.replace(/[^a-zA-Z0-9_-]+/g, "-")}`;
}

const EMPTY_SECTION: LauncherSection = { tiles: [], total: 0 };

type LauncherAction = { label: string; title: string; onSelect: () => void };

/**
 * One titled grid of tiles.
 *
 * The header carries the section's affordances — expand/collapse, open the full
 * plugin list — while the grid itself is always eight columns wide, so widening
 * the window widens tiles instead of reflowing them onto other rows. An empty
 * section renders nothing at all, header included.
 */
function LauncherSectionGrid({
  title,
  section,
  variant,
  startIndex,
  activeIndex,
  disabled,
  pinnedIds,
  actions,
  onOpen,
  onTogglePin,
}: {
  title: string;
  section: LauncherSection;
  /** `all` marks the single grid of every installed plugin. */
  variant?: "all";
  startIndex: number;
  activeIndex: number;
  disabled: boolean;
  pinnedIds: readonly string[];
  actions?: LauncherAction[];
  onOpen: (tile: LauncherTile) => void;
  onTogglePin: (tile: LauncherTile) => void;
}) {
  if (!section.tiles.length) return null;
  return (
    <section className="plugin-launcher-group" aria-label={title}>
      <header className="plugin-launcher-group-header">
        <h2>{title}</h2>
        {actions?.length ? (
          <div className="plugin-launcher-group-actions">
            {actions.map((action) => (
              <button
                key={action.label}
                type="button"
                className="plugin-launcher-group-action"
                title={action.title}
                tabIndex={-1}
                onClick={action.onSelect}
              >
                {action.label}
              </button>
            ))}
          </div>
        ) : null}
      </header>
      <div
        className={`plugin-launcher-grid${variant === "all" ? " plugin-launcher-grid-all" : ""}`}
        role="presentation"
      >
        {section.tiles.map((tile, index) => (
          <LauncherTileButton
            key={tile.id}
            tile={tile}
            pinned={pinnedIds.includes(tile.id)}
            active={activeIndex === startIndex + index}
            disabled={disabled}
            optionId={optionId(tile.id)}
            onOpen={() => onOpen(tile)}
            onTogglePin={() => onTogglePin(tile)}
          />
        ))}
      </div>
    </section>
  );
}

/** Read a computed pixel length, tolerating `auto` and unit oddities. */
function pixels(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function PluginLauncher() {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const surfaceRef = useRef<HTMLElement>(null);
  const searchRowRef = useRef<HTMLDivElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const resultsContentRef = useRef<HTMLDivElement>(null);
  const footerRef = useRef<HTMLElement>(null);
  const reportedHeightRef = useRef(0);
  const [query, setQuery] = useState("");
  const [catalog, setCatalog] = useState<LauncherCatalog | null>(null);
  const [store, setStore] = useState<LauncherStoreSnapshot>(() => readLauncherState());
  const [activeIndex, setActiveIndex] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [showAllPlugins, setShowAllPlugins] = useState(false);
  const [loading, setLoading] = useState(true);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pinsFull, setPinsFull] = useState(false);
  const [pinsPulse, setPinsPulse] = useState(0);
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
    setShowAllPlugins(false);
    setPinsFull(false);
    setPinsPulse(0);
    setOpeningId(null);
    setError(null);
    scanRetriesRef.current = 0;
    // The panel is re-shown at whatever size it had; ask for the content height
    // again instead of trusting the remembered window.
    reportedHeightRef.current = 0;
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

  // Pins and preferences can be changed in another window; web storage already
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
        : EMPTY_SECTION,
    [index, store, expanded],
  );
  const pinnedSection = useMemo(
    () => (index ? buildLauncherPinnedSection(index, store) : EMPTY_SECTION),
    [index, store],
  );
  const allPluginsSection = useMemo(
    () => (index ? buildLauncherAllPluginsSection(index, store) : EMPTY_SECTION),
    [index, store],
  );
  const matchSection = useMemo(
    () =>
      index ? searchLauncherItems(index, query, store) : EMPTY_SECTION,
    [index, query, store],
  );

  const searching = query.trim().length > 0;
  const navTiles = useMemo(() => {
    if (searching) return matchSection.tiles;
    if (showAllPlugins) return allPluginsSection.tiles;
    return [...recentSection.tiles, ...pinnedSection.tiles];
  }, [
    searching,
    showAllPlugins,
    matchSection.tiles,
    allPluginsSection.tiles,
    recentSection.tiles,
    pinnedSection.tiles,
  ]);

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

  const openPluginMarket = useCallback(async () => {
    setError(null);
    try {
      await api.launcherOpenPluginMarket();
    } catch (marketError) {
      setError(
        marketError instanceof Error ? marketError.message : String(marketError),
      );
    }
  }, []);

  const togglePin = useCallback(
    (tile: LauncherTile) => {
      const pinned = store.pins.includes(tile.id);
      if (!pinned && store.pins.length >= LAUNCHER_PIN_LIMIT) {
        // The row is full: say so, and shake the pins so the eye lands on the
        // section that refused the request.
        setPinsFull(true);
        setPinsPulse((current) => current + 1);
        return;
      }
      setPinsFull(false);
      setStore(setLauncherPinned(tile.id, !pinned));
    },
    [store.pins],
  );

  useEffect(() => {
    if (!pinsPulse) return;
    const timer = window.setTimeout(() => setPinsPulse(0), PINS_FULL_PULSE_MS);
    return () => window.clearTimeout(timer);
  }, [pinsPulse]);

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
        if (showAllPlugins) {
          // The full list is a view inside the panel, not a separate window:
          // the first Escape leaves it and a second one dismisses the panel.
          setShowAllPlugins(false);
          setActiveIndex(0);
          return;
        }
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
    [activeIndex, moveActive, navTiles, openTile, showAllPlugins],
  );

  /**
   * Ask the host for exactly the height this render needs.
   *
   * Every part of the panel that decides its height is measured here: the
   * search row, the natural height of the results content, the footer, and the
   * padding/border around them. `results` scrolls, so its own box cannot be
   * trusted — the inner content wrapper is what reports the height.
   */
  const measureContentHeight = useCallback(() => {
    const main = mainRef.current;
    const surface = surfaceRef.current;
    const searchRow = searchRowRef.current;
    const results = resultsRef.current;
    const content = resultsContentRef.current;
    const footer = footerRef.current;
    if (!main || !surface || !searchRow || !results || !content || !footer) {
      return;
    }
    const mainStyle = window.getComputedStyle(main);
    const surfaceStyle = window.getComputedStyle(surface);
    const resultsStyle = window.getComputedStyle(results);
    const height = resolveLauncherContentHeight({
      searchRowHeight: searchRow.offsetHeight,
      resultsHeight:
        content.offsetHeight +
        pixels(resultsStyle.paddingTop) +
        pixels(resultsStyle.paddingBottom),
      footerHeight: footer.offsetHeight,
      chromeHeight:
        pixels(mainStyle.paddingTop) +
        pixels(mainStyle.paddingBottom) +
        pixels(surfaceStyle.borderTopWidth) +
        pixels(surfaceStyle.borderBottomWidth),
    });
    if (height <= 0 || height === reportedHeightRef.current) return;
    reportedHeightRef.current = height;
    void api.launcherSetContentHeight(height).catch(() => undefined);
  }, []);

  // Every view change re-measures; the observer below only has to catch
  // reflows the panel does not cause itself (font scale, zoom, OS text size).
  useLayoutEffect(() => {
    measureContentHeight();
  }, [
    measureContentHeight,
    query,
    showAllPlugins,
    expanded,
    store,
    catalog,
    loading,
    error,
    pinsFull,
  ]);

  useEffect(() => {
    let frame: number | null = null;
    const schedule = () => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        measureContentHeight();
      });
    };
    const targets = [resultsRef.current, resultsContentRef.current].filter(
      (target): target is HTMLDivElement => Boolean(target),
    );
    const observer =
      typeof ResizeObserver === "function"
        ? new ResizeObserver(schedule)
        : null;
    for (const target of targets) observer?.observe(target);
    window.addEventListener("resize", schedule);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", schedule);
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [measureContentHeight]);

  const emptyText = loading
    ? t("pluginLauncher.loading")
    : searching
      ? t("pluginLauncher.noResults")
      : catalog?.appsScanning
        ? t("pluginLauncher.scanningApps")
        : t("pluginLauncher.empty");

  const marketAction = (
    <button
      type="button"
      className="plugin-launcher-empty-action"
      onClick={() => void openPluginMarket()}
    >
      {t("pluginLauncher.openPluginMarket")}
    </button>
  );

  const recentActions: LauncherAction[] = [];
  if (recentSection.total > recentSection.tiles.length || expanded) {
    recentActions.push({
      label: expanded
        ? t("pluginLauncher.collapse")
        : t("pluginLauncher.expandRecent", { count: recentSection.total }),
      title: t("pluginLauncher.recent"),
      onSelect: () => setExpanded((current) => !current),
    });
  }
  if (allPluginsSection.total > 0) {
    recentActions.push({
      label: t("pluginLauncher.showAllPlugins"),
      title: t("pluginLauncher.allPlugins"),
      onSelect: () => {
        setExpanded(false);
        setShowAllPlugins(true);
        setActiveIndex(0);
      },
    });
  }

  const renderResults = () => {
    if (searching) {
      if (matchSection.tiles.length) {
        return (
          <LauncherSectionGrid
            title={t("pluginLauncher.matches")}
            section={matchSection}
            startIndex={0}
            activeIndex={activeIndex}
            disabled={openingId !== null}
            pinnedIds={store.pins}
            onOpen={(tile) => void openTile(tile)}
            onTogglePin={togglePin}
            actions={
              matchSection.total > matchSection.tiles.length
                ? [
                    {
                      label: t("pluginLauncher.overflow", {
                        count: matchSection.total - matchSection.tiles.length,
                      }),
                      title: t("pluginLauncher.overflowHint"),
                      onSelect: () => undefined,
                    },
                  ]
                : undefined
            }
          />
        );
      }
      return (
        <div className="plugin-launcher-empty" role="status">
          <IconPlug size={20} aria-hidden />
          <span>{emptyText}</span>
          {marketAction}
        </div>
      );
    }

    if (showAllPlugins) {
      if (allPluginsSection.tiles.length) {
        return (
          <LauncherSectionGrid
            title={t("pluginLauncher.allPlugins")}
            variant="all"
            section={allPluginsSection}
            startIndex={0}
            activeIndex={activeIndex}
            disabled={openingId !== null}
            pinnedIds={store.pins}
            onOpen={(tile) => void openTile(tile)}
            onTogglePin={togglePin}
          />
        );
      }
      return (
        <div className="plugin-launcher-empty" role="status">
          <IconPlug size={20} aria-hidden />
          <span>{emptyText}</span>
        </div>
      );
    }

    if (recentSection.tiles.length || pinnedSection.tiles.length) {
      return (
        <>
          <LauncherSectionGrid
            title={t("pluginLauncher.recent")}
            section={recentSection}
            startIndex={0}
            activeIndex={activeIndex}
            disabled={openingId !== null}
            pinnedIds={store.pins}
            onOpen={(tile) => void openTile(tile)}
            onTogglePin={togglePin}
            actions={recentActions}
          />
          {pinnedSection.tiles.length ? (
            <div
              key={`pins-${pinsPulse}`}
              className={`plugin-launcher-pin-group${pinsPulse ? " shaking" : ""}`}
            >
              <LauncherSectionGrid
                title={t("pluginLauncher.pinned")}
                section={pinnedSection}
                startIndex={recentSection.tiles.length}
                activeIndex={activeIndex}
                disabled={openingId !== null}
                pinnedIds={store.pins}
                onOpen={(tile) => void openTile(tile)}
                onTogglePin={togglePin}
              />
            </div>
          ) : null}
        </>
      );
    }

    return (
      <div className="plugin-launcher-empty" role="status">
        <IconPlug size={20} aria-hidden />
        <span>{emptyText}</span>
        {marketAction}
      </div>
    );
  };

  return (
    <main
      className="plugin-launcher"
      aria-label={t("pluginLauncher.title")}
      ref={mainRef}
    >
      <section className="plugin-launcher-surface" ref={surfaceRef}>
        <div className="plugin-launcher-search-row" ref={searchRowRef}>
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
            onChange={(event) => {
              setQuery(event.target.value);
              // Typing always means "search": the full plugin list steps aside
              // instead of filtering a view it cannot express.
              if (showAllPlugins) {
                setShowAllPlugins(false);
                setActiveIndex(0);
              }
            }}
            onKeyDown={handleKeyDown}
          />
          <span className="plugin-launcher-shortcut" aria-hidden>
            {window.piDesktop?.platform === "darwin" ? "⌥ Space" : "Alt + Space"}
          </span>
        </div>

        <div
          id="plugin-launcher-results"
          className="plugin-launcher-results"
          role="listbox"
          aria-label={t("pluginLauncher.results")}
          ref={resultsRef}
        >
          <div className="plugin-launcher-results-content" ref={resultsContentRef}>
            {renderResults()}
          </div>
        </div>

        <footer className="plugin-launcher-footer" ref={footerRef}>
          <span>{t("pluginLauncher.navigateHint")}</span>
          <span>{t("pluginLauncher.openHint")}</span>
          <span>{t("pluginLauncher.dismissHint")}</span>
          {pinsFull ? (
            <span className="plugin-launcher-pin-notice" role="status">
              {t("pluginLauncher.pinsFull", { limit: LAUNCHER_PIN_LIMIT })}
            </span>
          ) : null}
          {error ? <strong role="alert">{error}</strong> : null}
        </footer>
      </section>
    </main>
  );
}
