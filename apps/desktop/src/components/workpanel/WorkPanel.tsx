import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useTranslation } from "react-i18next";
import type { PluginViewMeta } from "@pi-desktop/shared";
import {
  isKnownWorkPanelTab,
  parsePluginViewRef,
  pluginWorkPanelTab,
  toolWorkPanelTab,
} from "../../lib/work-panel-tabs";
import { pluginViewIcon, pluginViewInitial } from "../../lib/plugin-view-icons";
import { useAppStore } from "../../stores/app-store";
import type { WorkPanelTab } from "../../stores/app-store";
import { cx } from "../ui";
import { TooltipButton } from "../ui";
import type { IconProps } from "../icons";
import {
  IconBot,
  IconChevronLeft,
  IconClose,
  IconDiff,
  IconFileText,
  IconPanelMaximize,
  IconPanelRestore,
  IconPlug,
  IconPlus,
} from "../icons";
import { ReviewTab } from "./ReviewTab";
import { FilesTab } from "./FilesTab";
import { PluginViewTab } from "./PluginViewTab";
import { SubagentPanel } from "./SubagentPanel";
import type { SubagentPanelSelection } from "../../lib/subagent-panel";
import {
  MAIN_PANE_MIN_WIDTH,
  WORK_PANEL_COMPACT_MIN_WIDTH,
  WORK_PANEL_MIN_WIDTH,
  clampWorkPanelWidth,
  workPanelLayout,
} from "../../lib/work-panel-resize";

const TAB_ICONS = {
  new: IconPlus,
  review: IconDiff,
  file: IconFileText,
  plugin: IconPlug,
} as const;

type WorkPanelResizeState = {
  pointerId: number;
  startClientX: number;
  startWidth: number;
  minimumWidth: number;
  currentWidth: number;
  frame: number;
};

type WorkPanelTool = {
  id: string;
  tab: WorkPanelTab;
  label: string;
  icon: ComponentType<IconProps> | null;
  initial?: string;
  description?: string;
  shortcut?: string;
};

function tabLabel(
  tab: WorkPanelTab,
  t: (key: string) => string,
  pluginViews: PluginViewMeta[],
) {
  if (tab.kind === "plugin") {
    const view = pluginViews.find((candidate) => candidate.ref === tab.resource);
    // A view whose plugin was disabled mid-session no longer resolves; fall
    // back to its id rather than leaving the tab blank until it closes.
    return view?.title ?? tab.resource ?? t("panel.tabs.plugin");
  }
  if (tab.kind === "new") return t("panel.new.title");
  if (tab.kind !== "file") return t(`panel.tabs.${tab.kind}`);
  const path = tab.resource ?? "";
  return path.split("/").filter(Boolean).pop() || t("panel.tabs.file");
}

function workPanelTools(
  t: (key: string) => string,
  pluginViews: PluginViewMeta[],
): WorkPanelTool[] {
  // Review is the only host-owned launcher. Files, Browser, and every future
  // tool are plugin-contributed views, so their list stays data-driven.
  return [
    {
      id: "review",
      tab: toolWorkPanelTab("review"),
      label: t("panel.tabs.review"),
      icon: IconDiff,
    },
    ...pluginViews.map((view) => {
      const Icon = pluginViewIcon(view.icon);
      return {
        id: view.ref,
        tab: pluginWorkPanelTab(view.pluginId, view.viewId),
        label: view.title,
        icon: Icon,
        ...(Icon ? {} : { initial: pluginViewInitial(view.title) }),
        description: view.pluginName,
      };
    }),
  ];
}

function ToolIcon({ item, size = 15 }: { item: WorkPanelTool; size?: number }) {
  if (item.icon) return <item.icon size={size} />;
  return (
    <span className="work-panel-view-initial" aria-hidden>
      {item.initial}
    </span>
  );
}

export function WorkPanel({
  panelBlocked = false,
  exiting = false,
  onExitAnimationEnd,
  subagentPanel = null,
  onCloseSubagentPanel,
  containerWidth = 0,
  sidebarCollapsed = false,
  sidebarExiting = false,
  sidebarWidth = 0,
  onAutoCollapseSidebar,
  maximized = false,
  onToggleMaximize,
}: {
  /**
   * Hides every native surface in the panel. Both the preview browser and a
   * plugin view are `WebContentsView`s composited above renderer content, so a
   * blocking overlay must suppress them alike.
   */
  panelBlocked?: boolean;
  /** Plays work-panel-out; parent unmounts after animationend. */
  exiting?: boolean;
  onExitAnimationEnd?: () => void;
  /** Temporarily replaces the resource body with the selected subagent detail. */
  subagentPanel?: SubagentPanelSelection | null;
  onCloseSubagentPanel?: () => void;
  /** Current renderer shell width used for the three-column budget. */
  containerWidth?: number;
  /** Sidebar state is part of the shared shell budget. */
  sidebarCollapsed?: boolean;
  /** Keep the dock in the budget while `sidebar-out` still occupies flex space. */
  sidebarExiting?: boolean;
  sidebarWidth?: number;
  /** Called on the first frame where the main pane would hit its hard floor. */
  onAutoCollapseSidebar?: () => void;
  /** Preview mode: the panel takes MainChat's width as well. */
  maximized?: boolean;
  /** Toggles the preview mode from the panel header. */
  onToggleMaximize?: () => void;
}) {
  const { t } = useTranslation();
  const rawTabs = useAppStore((s) => s.workPanelTabs);
  const tabs = rawTabs.filter(isKnownWorkPanelTab);
  const activeTabId = useAppStore((s) => s.activeWorkPanelTabId);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const pluginViews = useAppStore((s) => s.pluginViews);
  const width = useAppStore((s) => s.workPanelWidth);
  const activateTab = useAppStore((s) => s.activateWorkPanelTab);
  const closeTab = useAppStore((s) => s.closeWorkPanelTab);
  const openWorkPanelTab = useAppStore((s) => s.openWorkPanelTab);
  const openNewWorkPanelTab = useAppStore((s) => s.openNewWorkPanelTab);
  const replaceWorkPanelTab = useAppStore((s) => s.replaceWorkPanelTab);
  const setWidth = useAppStore((s) => s.setWorkPanelWidth);
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;
  const tools = workPanelTools(t, pluginViews);

  const [panelDragWidth, setPanelDragWidth] = useState<number | null>(null);
  const panelResizeState = useRef<WorkPanelResizeState | null>(null);
  const tabButtonRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const newTabButtonRef = useRef<HTMLButtonElement | null>(null);
  const [nativeSurfaceReadyForExit, setNativeSurfaceReadyForExit] =
    useState(false);

  const requestedPanelWidth = panelDragWidth ?? width;
  const panelMinimum =
    requestedPanelWidth < WORK_PANEL_MIN_WIDTH
      ? WORK_PANEL_COMPACT_MIN_WIDTH
      : WORK_PANEL_MIN_WIDTH;
  // The first render can precede ResizeObserver's first notification. Use a
  // conservative shell estimate for that frame; the measured width takes over
  // before a user can interact with the divider.
  const sidebarOccupiesBudget = !sidebarCollapsed || sidebarExiting;
  const budgetWidth =
    containerWidth > 0
      ? containerWidth
      : requestedPanelWidth +
        (sidebarOccupiesBudget ? sidebarWidth : 0) +
        MAIN_PANE_MIN_WIDTH;
  const layout = workPanelLayout({
    containerWidth: budgetWidth,
    sidebarWidth,
    sidebarCollapsed: !sidebarOccupiesBudget,
    requestedPanelWidth,
    maximized,
  });
  const renderPanelWidth = layout.panelWidth;
  const isResizing = panelDragWidth !== null;

  useLayoutEffect(() => {
    if (!exiting && layout.shouldCollapseSidebar) onAutoCollapseSidebar?.();
  }, [exiting, layout.shouldCollapseSidebar, onAutoCollapseSidebar]);

  useEffect(() => {
    if (isResizing) {
      document.documentElement.setAttribute("data-work-panel-resizing", "true");
    } else {
      document.documentElement.removeAttribute("data-work-panel-resizing");
    }
    return () => {
      document.documentElement.removeAttribute("data-work-panel-resizing");
    };
  }, [isResizing]);

  useEffect(() => {
    if (!exiting) {
      setNativeSurfaceReadyForExit(false);
      return;
    }
    // Plugin views (and the host guest clamped to them) hide via `blocked`
    // before the dock CSS animation starts.
    setNativeSurfaceReadyForExit(true);
  }, [exiting]);

  useLayoutEffect(() => {
    if (!activeTabId) return;
    tabButtonRefs.current[activeTabId]?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
    });
  }, [activeTabId, tabs.length]);

  const selectTool = useCallback(
    (item: WorkPanelTool, sourceTabId?: string) => {
      if (sourceTabId) {
        replaceWorkPanelTab(sourceTabId, item.tab);
        return;
      }
      const existing = tabs.find((tab) => tab.id === item.tab.id);
      if (existing) activateTab(existing.id);
      else openWorkPanelTab(item.tab);
    },
    [activateTab, openWorkPanelTab, replaceWorkPanelTab, tabs],
  );

  const closeTabAndFocus = useCallback(
    (tabId: string) => {
      const index = tabs.findIndex((tab) => tab.id === tabId);
      const nextTab = index >= 0 ? tabs[index + 1] ?? tabs[index - 1] : undefined;
      closeTab(tabId);
      requestAnimationFrame(() => {
        if (nextTab) tabButtonRefs.current[nextTab.id]?.focus();
        else newTabButtonRef.current?.focus();
      });
    },
    [closeTab, tabs],
  );

  const onTabKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>, tabId: string) => {
      const index = tabs.findIndex((tab) => tab.id === tabId);
      if (index < 0) return;
      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        closeTabAndFocus(tabId);
        return;
      }
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const nextIndex =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? tabs.length - 1
            : event.key === "ArrowLeft"
              ? (index - 1 + tabs.length) % tabs.length
              : (index + 1) % tabs.length;
      const nextTab = tabs[nextIndex];
      if (!nextTab) return;
      activateTab(nextTab.id);
      requestAnimationFrame(() => tabButtonRefs.current[nextTab.id]?.focus());
    },
    [activateTab, closeTabAndFocus, tabs],
  );

  const onTabStripWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    const strip = event.currentTarget;
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
    if (strip.scrollWidth <= strip.clientWidth) return;
    strip.scrollLeft += event.deltaY;
    event.preventDefault();
  };

  const finishPanelResize = useCallback(
    (target: HTMLDivElement, pointerId: number, cancelled: boolean) => {
      const drag = panelResizeState.current;
      if (drag?.pointerId !== pointerId) return;
      panelResizeState.current = null;
      if (drag.frame) cancelAnimationFrame(drag.frame);
      if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
      setPanelDragWidth(null);
      if (!cancelled && drag.currentWidth !== drag.startWidth) {
        setWidth(drag.currentWidth);
      }
    },
    [setWidth],
  );

  const onPanelResizeStart = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      // While maximized there is no second column to trade width with.
      if (maximized) return;
      if (event.button !== 0 || panelResizeState.current) return;
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.focus({ preventScroll: true });
      const startWidth = clampWorkPanelWidth(renderPanelWidth, panelMinimum);
      panelResizeState.current = {
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startWidth,
        minimumWidth: panelMinimum,
        currentWidth: startWidth,
        frame: 0,
      };
      setPanelDragWidth(startWidth);
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [maximized, panelMinimum, renderPanelWidth],
  );

  const onPanelResizeMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = panelResizeState.current;
    if (drag?.pointerId !== event.pointerId) return;
    drag.currentWidth = clampWorkPanelWidth(
      drag.startWidth + drag.startClientX - event.clientX,
      drag.minimumWidth,
    );
    if (drag.frame) return;
    drag.frame = requestAnimationFrame(() => {
      if (panelResizeState.current !== drag) return;
      drag.frame = 0;
      setPanelDragWidth(drag.currentWidth);
    });
  }, []);

  const onPanelResizeCommit = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      finishPanelResize(event.currentTarget, event.pointerId, false);
    },
    [finishPanelResize],
  );

  const onPanelResizeCancel = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      finishPanelResize(event.currentTarget, event.pointerId, true);
    },
    [finishPanelResize],
  );

  useEffect(
    () => () => {
      const drag = panelResizeState.current;
      if (drag?.frame) cancelAnimationFrame(drag.frame);
      panelResizeState.current = null;
      document.documentElement.removeAttribute("data-work-panel-resizing");
    },
    [],
  );

  const onPanelResizeKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const drag = panelResizeState.current;
      if (event.key === "Escape" && drag) {
        event.preventDefault();
        finishPanelResize(event.currentTarget, drag.pointerId, true);
        return;
      }
      // While maximized there is no second column to trade width with.
      if (maximized) return;
      const step = event.shiftKey ? 32 : 16;
      const minimum = Math.min(panelMinimum, layout.maxPanelWidth);
      const maximum = Math.max(minimum, layout.maxPanelWidth);
      let nextWidth: number | null = null;
      if (event.key === "ArrowLeft") nextWidth = renderPanelWidth + step;
      else if (event.key === "ArrowRight") nextWidth = renderPanelWidth - step;
      else if (event.key === "Home") nextWidth = minimum;
      else if (event.key === "End") nextWidth = maximum;
      if (nextWidth === null) return;
      event.preventDefault();
      setWidth(clampWorkPanelWidth(nextWidth, minimum));
    },
    [finishPanelResize, layout.maxPanelWidth, maximized, panelMinimum, renderPanelWidth, setWidth],
  );

  const activePluginView =
    activeTab?.kind === "plugin"
      ? pluginViews.find((view) => view.ref === activeTab.resource)
      : undefined;
  const activeLabel = activeTab
    ? tabLabel(activeTab, t, pluginViews)
    : t("panel.title");
  const exitAnimationReady = exiting && nativeSurfaceReadyForExit;
  const panelStyle = {
    width: renderPanelWidth,
    maxWidth: layout.maxPanelWidth,
    "--work-panel-width": `${renderPanelWidth}px`,
  } as CSSProperties;

  return (
    <aside
      className={cx(
        "work-panel",
        maximized && "is-maximized",
        exiting && !exitAnimationReady && "is-exit-pending",
        exitAnimationReady && "is-exiting",
      )}
      style={panelStyle}
      data-testid="work-panel"
      data-resizing={isResizing ? "true" : undefined}
      data-exiting={exiting ? "true" : undefined}
      onAnimationEnd={(event) => {
        if (!exitAnimationReady) return;
        if (event.target !== event.currentTarget) return;
        if (!event.animationName.startsWith("work-panel-out")) return;
        onExitAnimationEnd?.();
      }}
    >
      <div
        className="work-panel-resize no-drag"
        role="separator"
        aria-orientation="vertical"
        aria-label={t("panel.resize")}
        aria-valuemin={Math.min(
          panelMinimum,
          Math.max(WORK_PANEL_COMPACT_MIN_WIDTH, layout.maxPanelWidth),
        )}
        aria-valuemax={Math.max(
          Math.min(panelMinimum, layout.maxPanelWidth),
          layout.maxPanelWidth,
        )}
        aria-valuenow={Math.round(panelDragWidth ?? renderPanelWidth)}
        aria-disabled={maximized || undefined}
        data-maximized={maximized ? "true" : undefined}
        tabIndex={0}
        onPointerDown={onPanelResizeStart}
        onPointerMove={onPanelResizeMove}
        onPointerUp={onPanelResizeCommit}
        onPointerCancel={onPanelResizeCancel}
        onLostPointerCapture={onPanelResizeCancel}
        onKeyDown={onPanelResizeKeyDown}
      />
      <div className="work-panel-main">
        <header className="work-panel-header">
          <div className="work-panel-tab-strip-wrap no-drag">
            {subagentPanel ? (
              <div className="work-panel-subagent-heading" aria-label={t("panel.subagent")}>
                <IconBot size={15} />
                <span>{t("panel.subagent")}</span>
              </div>
            ) : (
              <div
                className="work-panel-tab-strip"
                role="tablist"
                aria-label={t("panel.tabsLabel")}
                onWheel={onTabStripWheel}
              >
                {tabs.map((tab) => {
                  const label = tabLabel(tab, t, pluginViews);
                  const selected = tab.id === activeTabId;
                  const Icon =
                    tab.kind === "plugin"
                      ? pluginViewIcon(
                          pluginViews.find((view) => view.ref === tab.resource)?.icon,
                        ) ?? TAB_ICONS.plugin
                      : TAB_ICONS[tab.kind];
                  return (
                    <div className={cx("work-panel-tab", selected && "active")} key={tab.id}>
                      <button
                        ref={(node) => {
                          tabButtonRefs.current[tab.id] = node;
                        }}
                        type="button"
                        role="tab"
                        id={`work-panel-tab-${tab.id}`}
                        aria-selected={selected}
                        aria-controls={`work-panel-surface-${tab.id}`}
                        tabIndex={selected ? 0 : -1}
                        className="work-panel-tab-button"
                        title={tab.resource ?? label}
                        onClick={() => activateTab(tab.id)}
                        onAuxClick={(event) => {
                          if (event.button !== 1) return;
                          event.preventDefault();
                          closeTabAndFocus(tab.id);
                        }}
                        onKeyDown={(event) => onTabKeyDown(event, tab.id)}
                      >
                        <Icon size={14} />
                        <span className="work-panel-tab-label">{label}</span>
                      </button>
                      <button
                        type="button"
                        className="work-panel-tab-close"
                        aria-label={t("panel.closeTab", { name: label })}
                        title={t("panel.closeTab", { name: label })}
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={() => closeTabAndFocus(tab.id)}
                      >
                        <IconClose size={12} />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          <div className="work-panel-actions no-drag">
            {subagentPanel && onCloseSubagentPanel ? (
              <TooltipButton
                type="button"
                className="work-panel-subagent-back"
                tooltip={t("panel.subagentClose")}
                ariaLabel={t("panel.subagentClose")}
                onClick={onCloseSubagentPanel}
              >
                <IconChevronLeft size={15} />
              </TooltipButton>
            ) : (
              <TooltipButton
                ref={newTabButtonRef}
                type="button"
                className="work-panel-new-tab"
                tooltip={t("panel.new.open")}
                ariaLabel={t("panel.new.open")}
                onClick={openNewWorkPanelTab}
              >
                <IconPlus size={16} />
              </TooltipButton>
            )}
            <TooltipButton
              type="button"
              className="work-panel-maximize"
              tooltip={t(maximized ? "panel.restore" : "panel.maximize")}
              ariaLabel={t(maximized ? "panel.restore" : "panel.maximize")}
              aria-pressed={maximized}
              onClick={() => onToggleMaximize?.()}
            >
              {maximized ? (
                <IconPanelRestore size={15} />
              ) : (
                <IconPanelMaximize size={15} />
              )}
            </TooltipButton>
          </div>
        </header>
        <div className="work-panel-body">
          {subagentPanel ? <SubagentPanel selection={subagentPanel} /> : null}
          {!subagentPanel && activeTab?.kind === "review" && (
            <div
              id={`work-panel-surface-${activeTab.id}`}
              className="work-panel-tabpane"
              role="tabpanel"
              aria-labelledby={`work-panel-tab-${activeTab.id}`}
            >
              <ReviewTab />
            </div>
          )}
          {!subagentPanel && activeTab?.kind === "file" && (
            <div
              key={activeTab.id}
              id={`work-panel-surface-${activeTab.id}`}
              className="work-panel-tabpane"
              role="tabpanel"
              aria-labelledby={`work-panel-tab-${activeTab.id}`}
            >
              <FilesTab />
            </div>
          )}
          {!subagentPanel &&
            activeTab?.kind === "plugin" &&
            (() => {
              const ref = parsePluginViewRef(activeTab.resource);
              if (!ref) return null;
              return (
                <div
                  key={activeTab.id}
                  id={`work-panel-surface-${activeTab.id}`}
                  className="work-panel-tabpane"
                  role="tabpanel"
                  aria-labelledby={`work-panel-tab-${activeTab.id}`}
                >
                  <PluginViewTab
                    pluginId={ref.pluginId}
                    viewId={ref.viewId}
                    title={activeLabel}
                    icon={activePluginView?.icon}
                    sessionId={activeSessionId ?? undefined}
                    location={activeTab.location}
                    // Native WebContentsViews composite above renderer content.
                    blocked={exiting || panelBlocked}
                  />
                </div>
              );
            })()}
          {!subagentPanel && (!activeTab || activeTab.kind === "new") && (
            <div
              className="work-panel-tabpane"
              data-testid="work-panel-empty"
              id={activeTab ? `work-panel-surface-${activeTab.id}` : undefined}
              role={activeTab ? "tabpanel" : undefined}
              aria-labelledby={
                activeTab ? `work-panel-tab-${activeTab.id}` : undefined
              }
            >
              <div className="work-panel-launcher">
                <div className="work-panel-launcher-title">{t("panel.new.title")}</div>
                <div
                  className="work-panel-launcher-list"
                  role="group"
                  aria-label={t("panel.toolsAndPanels")}
                >
                  {tools.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      className="work-panel-launcher-row"
                      data-work-panel-launcher-item={item.id}
                      onClick={() =>
                        selectTool(
                          item,
                          activeTab?.kind === "new" ? activeTab.id : undefined,
                        )
                      }
                    >
                      <span className="work-panel-launcher-icon" aria-hidden>
                        <ToolIcon item={item} />
                      </span>
                      <span className="work-panel-launcher-label">{item.label}</span>
                      {item.shortcut ? <kbd>{item.shortcut}</kbd> : null}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
