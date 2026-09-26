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
import { api } from "../../lib/api";
import { useBlockingOverlayActive } from "../../lib/blocking-overlay";
import {
  workPanelTabReorderScrollDelta,
  workPanelTabReorderInsertAfter,
  workPanelTabReorderShouldArm,
} from "../../lib/work-panel-tab-reorder";
import {
  isKnownWorkPanelTab,
  parsePluginViewRef,
  pluginWorkPanelTab,
  remoteTerminalWorkPanelTab,
  subagentTabDisplayLabels,
  toolWorkPanelTab,
} from "../../lib/work-panel-tabs";
import { sessionSurfaceGates } from "../../lib/session-capabilities";
import type { PluginViewMeta } from "@pi-desktop/shared";
import { pluginViewIcon, pluginViewInitial } from "../../lib/plugin-view-icons";
import { useAppStore } from "../../stores/app-store";
import type { WorkPanelTab } from "../../stores/app-store";
import { cx } from "../ui";
import { TooltipButton } from "../ui";
import type { IconProps } from "../icons";
import {
  IconBot,
  IconClose,
  IconDiff,
  IconFileText,
  IconPanelMaximize,
  IconPanelRestore,
  IconPlug,
  IconPlus,
  IconTerminal,
} from "../icons";
import { ReviewTab } from "./ReviewTab";
import { FilesTab } from "./FilesTab";
import { PluginViewTab } from "./PluginViewTab";
import { SubagentTranscriptTab } from "./SubagentTranscriptTab";
import { RemoteTerminalTab } from "./RemoteTerminalTab";
import { WorkTabEmpty } from "./WorkTabEmpty";
import {
  MAIN_PANE_MIN_WIDTH,
  WORK_PANEL_COMPACT_MIN_WIDTH,
  WORK_PANEL_MIN_WIDTH,
  clampWorkPanelWidth,
  workPanelLayout,
  workPanelResetWidth,
  workPanelWidthBounds,
} from "../../lib/work-panel-resize";

const TAB_ICONS = {
  new: IconPlus,
  review: IconDiff,
  file: IconFileText,
  plugin: IconPlug,
  subagent: IconBot,
  terminal: IconTerminal,
} as const;

type WorkPanelResizeState = {
  pointerId: number;
  startClientX: number;
  startWidth: number;
  minimumWidth: number;
  currentWidth: number;
  frame: number;
};

type WorkPanelTabReorderState = {
  pointerId: number;
  sourceTabId: string;
  activeSessionId: string | undefined;
  activeTabId: string | null;
  tabSignature: string;
  startClientX: number;
  startClientY: number;
  lastClientX: number;
  lastClientY: number;
  targetTabId: string | null;
  insertAfter: boolean;
  armed: boolean;
  autoScrollFrame: number | null;
  onMove: (event: PointerEvent) => void;
  onUp: (event: PointerEvent) => void;
  onCancel: (event: PointerEvent) => void;
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
  if (tab.kind === "subagent") return tab.label ?? t("panel.tabs.subagent");
  if (tab.kind === "terminal") return t("panel.tabs.terminal");
  if (tab.kind !== "file") return t(`panel.tabs.${tab.kind}`);
  const path = tab.resource ?? "";
  return path.split("/").filter(Boolean).pop() || t("panel.tabs.file");
}

function workPanelTools(
  t: (key: string) => string,
  pluginViews: PluginViewMeta[],
  canTerminal: boolean,
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
    ...(canTerminal
      ? [{
          id: "terminal",
          tab: remoteTerminalWorkPanelTab(),
          label: t("panel.tabs.terminal"),
          icon: IconTerminal,
        }]
      : []),
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
  const blockingOverlayActive = useBlockingOverlayActive();
  const rawTabs = useAppStore((s) => s.workPanelTabs);
  const tabs = rawTabs.filter(isKnownWorkPanelTab);
  const activeTabId = useAppStore((s) => s.activeWorkPanelTabId);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const activeSession = useAppStore(
    (s) => s.sessions.find((session) => session.id === activeSessionId) ?? null,
  );
  const canTerminal = sessionSurfaceGates(activeSession).canTerminal;
  const pluginViews = useAppStore((s) => s.pluginViews);
  const width = useAppStore((s) => s.workPanelWidth);
  const activateTab = useAppStore((s) => s.activateWorkPanelTab);
  const reorderTabs = useAppStore((s) => s.reorderWorkPanelTabs);
  const closeTab = useAppStore((s) => s.closeWorkPanelTab);
  const openWorkPanelTab = useAppStore((s) => s.openWorkPanelTab);
  const openNewWorkPanelTab = useAppStore((s) => s.openNewWorkPanelTab);
  const replaceWorkPanelTab = useAppStore((s) => s.replaceWorkPanelTab);
  const setWidth = useAppStore((s) => s.setWorkPanelWidth);
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;
  const tools = workPanelTools(t, pluginViews, canTerminal);
  const tabSignature = JSON.stringify(
    tabs.map(({ id, kind, resource, location }) => [id, kind, resource, location]),
  );
  // Subagent tabs may share an agent name; repeats gain a 1-based `#n`
  // suffix in strip order so the row stays unambiguous. The base label
  // already falls back to panel.tabs.subagent when no name was captured.
  const subagentTabsInOrder = tabs.filter((tab) => tab.kind === "subagent");
  const subagentDisplayLabels = subagentTabDisplayLabels(
    subagentTabsInOrder.map((tab) => tabLabel(tab, t, pluginViews)),
  );
  const subagentLabelById = new Map(
    subagentTabsInOrder.map(
      (tab, index) => [tab.id, subagentDisplayLabels[index]] as const,
    ),
  );

  const [panelDragWidth, setPanelDragWidth] = useState<number | null>(null);
  const panelResizeState = useRef<WorkPanelResizeState | null>(null);
  const tabReorderState = useRef<WorkPanelTabReorderState | null>(null);
  const tabStripRef = useRef<HTMLDivElement | null>(null);
  const suppressedTabClickPointerIdsRef = useRef<Set<number>>(new Set());
  const tabButtonRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const newTabButtonRef = useRef<HTMLButtonElement | null>(null);
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null);
  const [dropIndicator, setDropIndicator] = useState<{
    tabId: string;
    insertAfter: boolean;
  } | null>(null);
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

  const finishTabReorder = useCallback(() => {
    const state = tabReorderState.current;
    if (state) {
      window.removeEventListener("pointermove", state.onMove, true);
      window.removeEventListener("pointerup", state.onUp, true);
      window.removeEventListener("pointercancel", state.onCancel, true);
      if (state.autoScrollFrame !== null) {
        cancelAnimationFrame(state.autoScrollFrame);
        state.autoScrollFrame = null;
      }
      tabReorderState.current = null;
    }
    setDraggingTabId(null);
    setDropIndicator(null);
    document.documentElement.removeAttribute("data-work-panel-tab-reordering");
  }, []);

  useLayoutEffect(() => {
    const state = tabReorderState.current;
    if (
      state &&
      (state.activeSessionId !== activeSessionId ||
        state.activeTabId !== activeTabId ||
        state.tabSignature !== tabSignature)
    ) {
      suppressedTabClickPointerIdsRef.current.add(state.pointerId);
      finishTabReorder();
    }
  }, [activeSessionId, activeTabId, finishTabReorder, tabSignature]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const state = tabReorderState.current;
      if (event.key !== "Escape" || !state) return;
      event.preventDefault();
      suppressedTabClickPointerIdsRef.current.add(state.pointerId);
      finishTabReorder();
    };
    const onWindowBlur = () => {
      const state = tabReorderState.current;
      if (state) suppressedTabClickPointerIdsRef.current.add(state.pointerId);
      finishTabReorder();
    };
    const onPointerDown = (event: PointerEvent) => {
      // A reused pointer id starts a new gesture; unrelated pointers do not
      // clear a canceled gesture's pending click suppression.
      suppressedTabClickPointerIdsRef.current.delete(event.pointerId);
    };
    const onClick = (event: MouseEvent) => {
      if (
        event.detail === 0 ||
        !("pointerId" in event) ||
        typeof event.pointerId !== "number" ||
        !suppressedTabClickPointerIdsRef.current.has(event.pointerId)
      ) {
        return;
      }
      suppressedTabClickPointerIdsRef.current.delete(event.pointerId);
      if (
        !(event.target instanceof Element) ||
        !event.target.closest('[role="tab"]')
      ) {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("blur", onWindowBlur);
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("blur", onWindowBlur);
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("click", onClick, true);
      suppressedTabClickPointerIdsRef.current.clear();
      finishTabReorder();
    };
  }, [finishTabReorder]);

  const reorderTab = useCallback(
    (sourceTabId: string, targetTabId: string, insertAfter: boolean) => {
      if (sourceTabId === targetTabId) return;
      reorderTabs(sourceTabId, targetTabId, insertAfter);
      requestAnimationFrame(() => {
        tabButtonRefs.current[sourceTabId]?.focus({ preventScroll: true });
      });
    },
    [reorderTabs],
  );

  const beginTabReorder = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>, sourceTabId: string) => {
      if (
        event.button !== 0 ||
        event.pointerType === "touch" ||
        tabReorderState.current
      ) {
        return;
      }
      // Pointer click suppression is armed only when this drag completes.

      const updateDropTarget = (state: WorkPanelTabReorderState) => {
        const strip = tabStripRef.current;
        const target = strip
          ? document
              .elementFromPoint(state.lastClientX, state.lastClientY)
              ?.closest<HTMLElement>("[data-work-panel-tab-id]")
          : null;
        if (!target || !strip?.contains(target)) {
          state.targetTabId = null;
          setDropIndicator(null);
          return;
        }

        const targetTabId = target.dataset.workPanelTabId;
        if (!targetTabId || targetTabId === state.sourceTabId) {
          state.targetTabId = null;
          setDropIndicator(null);
          return;
        }
        const rect = target.getBoundingClientRect();
        const insertAfter = workPanelTabReorderInsertAfter(
          state.lastClientX,
          rect.left,
          rect.width,
        );
        state.targetTabId = targetTabId;
        state.insertAfter = insertAfter;
        setDropIndicator({ tabId: targetTabId, insertAfter });
      };

      const startAutoScroll = (state: WorkPanelTabReorderState) => {
        if (state.autoScrollFrame !== null) return;

        const tick = () => {
          const current = tabReorderState.current;
          const strip = tabStripRef.current;
          if (!current || current !== state || !current.armed || !strip) {
            state.autoScrollFrame = null;
            return;
          }

          const stripRect = strip.getBoundingClientRect();
          if (
            current.lastClientY < stripRect.top ||
            current.lastClientY > stripRect.bottom ||
            strip.scrollWidth <= strip.clientWidth
          ) {
            current.autoScrollFrame = null;
            return;
          }

          const delta = workPanelTabReorderScrollDelta(
            current.lastClientX,
            stripRect.left,
            stripRect.right,
          );
          if (!delta) {
            current.autoScrollFrame = null;
            return;
          }

          const maxScrollLeft = strip.scrollWidth - strip.clientWidth;
          const nextScrollLeft = Math.min(
            maxScrollLeft,
            Math.max(0, strip.scrollLeft + delta),
          );
          if (nextScrollLeft === strip.scrollLeft) {
            current.autoScrollFrame = null;
            return;
          }

          strip.scrollLeft = nextScrollLeft;
          updateDropTarget(current);
          current.autoScrollFrame = requestAnimationFrame(tick);
        };

        state.autoScrollFrame = requestAnimationFrame(tick);
      };

      const onMove = (moveEvent: PointerEvent) => {
        const state = tabReorderState.current;
        if (!state || state.pointerId !== moveEvent.pointerId) return;
        state.lastClientX = moveEvent.clientX;
        state.lastClientY = moveEvent.clientY;
        if (!state.armed) {
          if (
            !workPanelTabReorderShouldArm(
              moveEvent.clientX - state.startClientX,
              moveEvent.clientY - state.startClientY,
            )
          ) {
            return;
          }
          state.armed = true;
          document.documentElement.setAttribute(
            "data-work-panel-tab-reordering",
            "true",
          );
          setDraggingTabId(state.sourceTabId);
        }

        moveEvent.preventDefault();
        updateDropTarget(state);
        startAutoScroll(state);
      };

      const onUp = (upEvent: PointerEvent) => {
        const state = tabReorderState.current;
        if (!state || state.pointerId !== upEvent.pointerId) return;
        if (state.armed) {
          upEvent.preventDefault();
          if (state.targetTabId) {
            reorderTab(state.sourceTabId, state.targetTabId, state.insertAfter);
          }
          finishTabReorder();
          suppressedTabClickPointerIdsRef.current.add(state.pointerId);
          return;
        }
        finishTabReorder();
      };

      const onCancel = (cancelEvent: PointerEvent) => {
        if (tabReorderState.current?.pointerId !== cancelEvent.pointerId) return;
        suppressedTabClickPointerIdsRef.current.delete(cancelEvent.pointerId);
        finishTabReorder();
      };

      const state: WorkPanelTabReorderState = {
        pointerId: event.pointerId,
        sourceTabId,
        activeSessionId,
        activeTabId,
        tabSignature,
        startClientX: event.clientX,
        startClientY: event.clientY,
        lastClientX: event.clientX,
        lastClientY: event.clientY,
        targetTabId: null,
        insertAfter: false,
        armed: false,
        autoScrollFrame: null,
        onMove,
        onUp,
        onCancel,
      };
      tabReorderState.current = state;
      window.addEventListener("pointermove", onMove, true);
      window.addEventListener("pointerup", onUp, true);
      window.addEventListener("pointercancel", onCancel, true);
    },
    [activeSessionId, activeTabId, finishTabReorder, reorderTab, tabSignature],
  );

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
      const closingTab = tabs[index];
      if (closingTab?.kind === "terminal" && closingTab.terminalId && activeSessionId) {
        void api
          .remoteTerminalClose({ sessionId: activeSessionId, terminalId: closingTab.terminalId })
          .catch(() => undefined);
      }
      closeTab(tabId);
      requestAnimationFrame(() => {
        if (nextTab) tabButtonRefs.current[nextTab.id]?.focus();
        else newTabButtonRef.current?.focus();
      });
    },
    [activeSessionId, closeTab, tabs],
  );

  const rememberTerminalId = useCallback(
    (sessionId: string, openRequestId: string, terminalId: string) => {
      const remembered = useAppStore
        .getState()
        .rememberWorkPanelTerminalId(sessionId, openRequestId, terminalId);
      if (remembered) return;
      // The user may close the tab before the Host replies to `open`. Once
      // that late response arrives, close the otherwise orphaned PTY.
      void api
        .remoteTerminalClose({ sessionId, terminalId })
        .catch(() => undefined);
    },
    [],
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
      if (event.altKey && ["ArrowLeft", "ArrowRight"].includes(event.key)) {
        event.preventDefault();
        const target = tabs[index + (event.key === "ArrowLeft" ? -1 : 1)];
        if (!target) return;
        reorderTab(tabId, target.id, event.key === "ArrowRight");
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
    [activateTab, closeTabAndFocus, reorderTab, tabs],
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
      const { minimum, maximum } = workPanelWidthBounds(
        panelMinimum,
        layout.maxPanelWidth,
      );
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

  /**
   * Double-click reset: the default width, kept inside the same live bounds
   * the keyboard path uses, so a reset never breaches the MainChat floor or
   * reopens a compact panel wider than the window allows.
   */
  const onPanelResizeReset = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      // While maximized there is no second column to trade width with.
      if (maximized) return;
      // A gesture that is still open (a second pointer) must not overwrite the
      // reset when it is finally released.
      const drag = panelResizeState.current;
      if (drag) finishPanelResize(event.currentTarget, drag.pointerId, true);
      setPanelDragWidth(null);
      setWidth(workPanelResetWidth(panelMinimum, layout.maxPanelWidth));
    },
    [finishPanelResize, layout.maxPanelWidth, maximized, panelMinimum, setWidth],
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
        onDoubleClick={onPanelResizeReset}
      />
      <div className="work-panel-main">
        <header className="work-panel-header">
          <div className="work-panel-tab-strip-wrap no-drag">
              <div
                ref={tabStripRef}
                className="work-panel-tab-strip"
                role="tablist"
                aria-label={t("panel.tabsLabel")}
                onWheel={onTabStripWheel}
              >
                {tabs.map((tab) => {
                  const label =
                    tab.kind === "subagent"
                      ? (subagentLabelById.get(tab.id) ?? t("panel.tabs.subagent"))
                      : tabLabel(tab, t, pluginViews);
                  const selected = tab.id === activeTabId;
                  const Icon =
                    tab.kind === "plugin"
                      ? pluginViewIcon(
                          pluginViews.find((view) => view.ref === tab.resource)?.icon,
                        ) ?? TAB_ICONS.plugin
                      : TAB_ICONS[tab.kind];
                  return (
                    <div
                      className={cx(
                        "work-panel-tab",
                        selected && "active",
                        draggingTabId === tab.id && "is-dragging",
                        dropIndicator?.tabId === tab.id &&
                          (dropIndicator.insertAfter ? "is-drop-after" : "is-drop-before"),
                      )}
                      data-work-panel-tab-id={tab.id}
                      key={tab.id}
                    >
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
                        aria-grabbed={draggingTabId === tab.id}
                        aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight"
                        className="work-panel-tab-button"
                        title={tab.kind === "subagent" ? label : tab.resource ?? label}
                        onPointerDown={(event) => beginTabReorder(event, tab.id)}
                        onDragStart={(event) => event.preventDefault()}
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
          </div>
          <div className="work-panel-actions no-drag">
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
          {activeTab?.kind === "subagent" && (
            <div
              key={activeTab.id}
              id={`work-panel-surface-${activeTab.id}`}
              className="work-panel-tabpane"
              role="tabpanel"
              aria-labelledby={`work-panel-tab-${activeTab.id}`}
            >
              <SubagentTranscriptTab delegationId={activeTab.resource ?? ""} />
            </div>
          )}
          {activeTab?.kind === "review" && (
            <div
              id={`work-panel-surface-${activeTab.id}`}
              className="work-panel-tabpane"
              role="tabpanel"
              aria-labelledby={`work-panel-tab-${activeTab.id}`}
            >
              <ReviewTab />
            </div>
          )}
          {activeTab?.kind === "file" && (
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
          {activeTab?.kind === "plugin" &&
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
                    blocked={exiting || panelBlocked || blockingOverlayActive}
                  />
                </div>
              );
            })()}
          {activeTab?.kind === "terminal" && (
            <div
              key={activeTab.id}
              id={`work-panel-surface-${activeTab.id}`}
              className="work-panel-tabpane"
              role="tabpanel"
              aria-labelledby={`work-panel-tab-${activeTab.id}`}
            >
              {canTerminal && activeSession ? (
                <RemoteTerminalTab
                  sessionId={activeSession.id}
                  hostKey={activeSession.remote?.hostKey ?? ""}
                  hostLabel={activeSession.remote?.hostLabel ?? ""}
                  openRequestId={activeTab.resource ?? activeTab.id}
                  onTerminalId={rememberTerminalId}
                  blocked={exiting || panelBlocked || blockingOverlayActive}
                />
              ) : (
                <WorkTabEmpty
                  icon={IconTerminal}
                  title={t("panel.terminal.unavailable")}
                />
              )}
            </div>
          )}
          {(!activeTab || activeTab.kind === "new") && (
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
