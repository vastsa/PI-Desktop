import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useTranslation } from "react-i18next";
import type { PluginViewMeta } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import {
  isKnownWorkPanelTab,
  isToolWorkPanelTab,
  parsePluginViewRef,
  pluginWorkPanelTab,
  toolWorkPanelTab,
} from "../../lib/work-panel-tabs";
import { pluginViewIcon, pluginViewInitial } from "../../lib/plugin-view-icons";
import { useAppStore } from "../../stores/app-store";
import type { WorkPanelTab } from "../../stores/app-store";
import { cx } from "../ui";
import {
  IconChevronDown,
  IconChevronRight,
  IconClose,
  IconDiff,
  IconFileText,
  IconGlobe,
  IconPanel,
  IconPlug,
} from "../icons";
import { ReviewTab } from "./ReviewTab";
import { BrowserTab } from "./BrowserTab";
import { FilesTab } from "./FilesTab";
import { PluginViewTab } from "./PluginViewTab";
import { WorkTabEmpty } from "./WorkTabEmpty";
import {
  WORK_PANEL_CHAT_MAX_WIDTH,
  WORK_PANEL_CHAT_MIN_WIDTH,
  clampWorkPanelWidth,
  clampWorkPanelChatWidth,
  committedWorkPanelChatWidth,
  workPanelChatWidthFromPointer,
} from "../../lib/work-panel-resize";

const TAB_ICONS = {
  review: IconDiff,
  browser: IconGlobe,
  file: IconFileText,
  plugin: IconPlug,
} as const;

/**
 * Tools the host itself provides — the panel's manually launchable surfaces.
 *
 * The host provides one built-in tool and two artifact/resource surfaces:
 *
 * - **Browser** opens a live preview surface for agent-generated HTML or a URL.
 * - **Files** is supplied by the bundled `pi.files` plugin through the same
 *   `contributes.views` channel a third-party plugin uses.
 * - **Review** is an *artifact* panel, opened by the conversation's Write/Edit
 *   records rather than picked from a launcher; its records remain
 *   message-owned (ADR 0043).
 *
 * `review` and `file` therefore remain live tab *kinds* while only `browser`
 * appears in this launcher list; see the panel body below.
 */
const HEADER_TOOLS = [{ kind: "browser", Icon: IconGlobe }] as const;

type HeaderToolKind = (typeof HEADER_TOOLS)[number]["kind"];

function headerToolTab(kind: HeaderToolKind): WorkPanelTab {
  return toolWorkPanelTab(kind);
}

function tabLabel(
  tab: WorkPanelTab,
  t: (key: string) => string,
  pluginViews: PluginViewMeta[],
) {
  if (tab.kind === "plugin") {
    const view = pluginViews.find((candidate) => candidate.ref === tab.resource);
    // A view whose plugin was disabled mid-session no longer resolves; fall
    // back to its id rather than leaving the header blank until the tab closes.
    return view?.title ?? tab.resource ?? t("panel.tabs.plugin");
  }
  if (tab.kind !== "file") return t(`panel.tabs.${tab.kind}`);
  const path = tab.resource ?? "";
  return path.split("/").filter(Boolean).pop() || t("panel.tabs.file");
}

export function WorkPanel({
  panelBlocked = false,
  onCollapse,
  exiting = false,
  onExitAnimationEnd,
}: {
  /**
   * Hides every native surface in the panel. Both the preview browser and a
   * plugin view are `WebContentsView`s composited above renderer content, so a
   * blocking overlay must suppress them alike.
   */
  panelBlocked?: boolean;
  onCollapse?: () => void;
  /** Plays work-panel-out; parent unmounts after animationend. */
  exiting?: boolean;
  onExitAnimationEnd?: () => void;
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
  const setWidth = useAppStore((s) => s.setWorkPanelWidth);
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;
  /** Resources opened from the transcript; tools and plugin views list above. */
  const resourceTabs = tabs.filter((tab) => !isToolWorkPanelTab(tab));

  const [nativePanelWidth, setNativePanelWidth] = useState<number | null>(null);
  const [chatDragWidth, setChatDragWidth] = useState<number | null>(null);
  const [nativeResizeActive, setNativeResizeActive] = useState(false);
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window === "undefined" ? 0 : window.innerWidth,
  );
  const chatDragState = useRef<{
    pointerId: number;
    startClientX: number;
    startWidth: number;
    width: number;
    dirty: boolean;
    frame: number;
  } | null>(null);
  const pendingChatWidth = useRef<number | null>(null);
  const chatResizeRequestRunning = useRef(false);
  const chatResizeActive = useRef(false);
  const contextRef = useRef<HTMLDivElement | null>(null);
  const contextButtonRef = useRef<HTMLButtonElement | null>(null);
  /** Where focus lands when the menu opens: the active row, or its last row. */
  const contextOpenFocus = useRef<"active" | "last">("active");
  const [contextOpen, setContextOpen] = useState(false);
  const [nativeSurfaceReadyForExit, setNativeSurfaceReadyForExit] =
    useState(false);

  const renderPanelWidth = clampWorkPanelWidth(nativePanelWidth ?? width);
  const chatWidth = clampWorkPanelChatWidth(viewportWidth - renderPanelWidth);
  const isResizing = chatDragWidth !== null || nativeResizeActive;

  useEffect(() => {
    return api.onWorkPanelResize((event) => {
      // A programmatic chat resize changes the native outer bounds. Ignore
      // any stale native preview that arrives during that transaction so it
      // cannot rewrite the panel target owned by this renderer divider.
      if (chatResizeActive.current) return;
      if (event.phase === "preview") {
        setNativePanelWidth(clampWorkPanelWidth(event.panelWidth));
        setNativeResizeActive(true);
        return;
      }
      setNativePanelWidth(null);
      setNativeResizeActive(false);
      setWidth(clampWorkPanelWidth(event.panelWidth));
    });
  }, [setWidth]);

  useEffect(() => {
    const onViewportResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", onViewportResize);
    return () => window.removeEventListener("resize", onViewportResize);
  }, []);

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

  const enqueueChatWidth = useCallback((width: number) => {
    pendingChatWidth.current = clampWorkPanelChatWidth(width);
    chatResizeActive.current = true;
    if (chatResizeRequestRunning.current) return;
    chatResizeRequestRunning.current = true;
    void (async () => {
      while (pendingChatWidth.current !== null) {
        const nextWidth = pendingChatWidth.current;
        pendingChatWidth.current = null;
        try {
          await api.setWorkPanelChatWidth(nextWidth);
        } catch {
          // A closed window can finish a pointer gesture after its bridge is
          // gone. The native window remains the source of truth in that case.
        }
      }
      chatResizeRequestRunning.current = false;
      chatResizeActive.current = false;
    })();
  }, []);

  const menuItems = useCallback(
    () =>
      Array.from(
        contextRef.current?.querySelectorAll<HTMLButtonElement>(
          "[data-work-panel-menu-item]",
        ) ?? [],
      ),
    [],
  );

  const closeContext = useCallback(() => {
    setContextOpen(false);
    contextButtonRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!exiting) {
      setNativeSurfaceReadyForExit(false);
      return;
    }

    let current = true;
    // WebContentsView is composited above the renderer and cannot follow the
    // panel's CSS animation. Detach it before the dock starts moving.
    void api
      .browserSetVisible(false)
      .catch(() => undefined)
      .then(() => {
        if (current) setNativeSurfaceReadyForExit(true);
      });
    return () => {
      current = false;
    };
  }, [exiting]);

  useEffect(() => {
    if (!contextOpen) return;
    const onPointer = (e: PointerEvent) => {
      if (contextRef.current?.contains(e.target as Node)) return;
      setContextOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      closeContext();
    };
    const onViewportChange = () => setContextOpen(false);
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onViewportChange);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onViewportChange);
    };
  }, [closeContext, contextOpen]);

  // Menu rows own focus (ARIA menu pattern), and the row that is already
  // active is the one the pointer or keyboard most likely wants next.
  useEffect(() => {
    if (!contextOpen) return;
    const target = contextOpenFocus.current;
    contextOpenFocus.current = "active";
    requestAnimationFrame(() => {
      const items = menuItems();
      if (!items.length) return;
      if (target === "last") {
        items[items.length - 1]?.focus();
        return;
      }
      const checked = items.find(
        (item) => item.getAttribute("aria-checked") === "true",
      );
      (checked ?? items[0])?.focus();
    });
  }, [contextOpen, menuItems]);

  // Selecting a resource closes the menu explicitly; only a context switch
  // dismisses it behind the user's back.
  useEffect(() => {
    setContextOpen(false);
  }, [activeSessionId]);

  /** Close a tab from the menu without dismissing it, keeping focus in place. */
  const closeTabFromMenu = useCallback(
    (tabId: string, index: number) => {
      closeTab(tabId);
      requestAnimationFrame(() => {
        const items = menuItems();
        if (!items.length) return;
        items[Math.min(index, items.length - 1)]?.focus();
      });
    },
    [closeTab, menuItems],
  );

  const selectTab = useCallback(
    (tabId: string) => {
      activateTab(tabId);
      closeContext();
    },
    [activateTab, closeContext],
  );

  const openTool = useCallback(
    (kind: HeaderToolKind) => {
      // Reuse the singleton tab so an open tool keeps its resource instead of
      // being replaced by a blank one.
      const existing = tabs.find((tab) => tab.id === kind);
      if (existing) activateTab(existing.id);
      else openWorkPanelTab(headerToolTab(kind));
      closeContext();
    },
    [activateTab, closeContext, openWorkPanelTab, tabs],
  );

  const openPluginView = useCallback(
    (view: PluginViewMeta) => {
      // Same singleton rule as the built-in tools: one tab per view, so
      // re-picking it from the menu returns to the live page rather than
      // stacking a second copy of the same plugin surface.
      const tab = pluginWorkPanelTab(view.pluginId, view.viewId);
      const existing = tabs.find((candidate) => candidate.id === tab.id);
      if (existing) activateTab(existing.id);
      else openWorkPanelTab(tab);
      closeContext();
    },
    [activateTab, closeContext, openWorkPanelTab, tabs],
  );

  const onTriggerKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    contextOpenFocus.current = event.key === "ArrowUp" ? "last" : "active";
    setContextOpen(true);
  };

  const onContextKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" || event.key === "Tab") {
      event.preventDefault();
      closeContext();
      return;
    }
    const items = menuItems();
    if (!items.length) return;
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Delete" || event.key === "Backspace") {
      const closable = items[current]?.dataset.workPanelCloseId;
      if (!closable) return;
      event.preventDefault();
      closeTabFromMenu(closable, current);
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    let next = current;
    if (event.key === "Home") next = 0;
    else if (event.key === "End") next = items.length - 1;
    else if (event.key === "ArrowDown") next = current < 0 ? 0 : (current + 1) % items.length;
    else if (event.key === "ArrowUp") {
      next = current < 0 ? items.length - 1 : (current - 1 + items.length) % items.length;
    }
    items[next]?.focus();
  };

  const finishChatResize = useCallback(
    (target: HTMLDivElement, pointerId: number, commit: boolean) => {
      const drag = chatDragState.current;
      if (drag?.pointerId !== pointerId) return;
      chatDragState.current = null;
      chatResizeActive.current = false;
      if (drag.frame) cancelAnimationFrame(drag.frame);
      if (target.hasPointerCapture(pointerId)) {
        target.releasePointerCapture(pointerId);
      }
      setChatDragWidth(null);
      const targetWidth = commit
        ? (committedWorkPanelChatWidth(drag, drag.width, true) ??
          (drag.dirty ? drag.startWidth : null))
        : drag.dirty
          ? drag.startWidth
          : null;
      if (targetWidth !== null) enqueueChatWidth(targetWidth);
    },
    [enqueueChatWidth],
  );

  const onChatResizeStart = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.currentTarget.focus({ preventScroll: true });
      e.stopPropagation();
      const startWidth = chatWidth;
      chatResizeActive.current = true;
      chatDragState.current = {
        pointerId: e.pointerId,
        startClientX: e.clientX,
        startWidth,
        width: startWidth,
        dirty: false,
        frame: 0,
      };
      e.currentTarget.setPointerCapture(e.pointerId);
      setChatDragWidth(startWidth);
    },
    [chatWidth],
  );

  const onChatResizeMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = chatDragState.current;
    if (drag?.pointerId !== e.pointerId) return;
    drag.dirty = true;
    drag.width = workPanelChatWidthFromPointer(drag, e.clientX);
    if (drag.frame) return;
    drag.frame = requestAnimationFrame(() => {
      if (chatDragState.current !== drag) return;
      drag.frame = 0;
      setChatDragWidth(drag.width);
      enqueueChatWidth(drag.width);
    });
  }, [enqueueChatWidth]);

  const onChatResizeCommit = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      finishChatResize(e.currentTarget, e.pointerId, true);
    },
    [finishChatResize],
  );

  const onChatResizeCancel = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      finishChatResize(e.currentTarget, e.pointerId, false);
    },
    [finishChatResize],
  );

  useEffect(
    () => () => {
      const drag = chatDragState.current;
      if (drag?.frame) cancelAnimationFrame(drag.frame);
      chatResizeActive.current = false;
      document.documentElement.removeAttribute("data-work-panel-resizing");
    },
    [],
  );

  const onChatResizeKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const drag = chatDragState.current;
      if (event.key === "Escape" && drag) {
        event.preventDefault();
        finishChatResize(event.currentTarget, drag.pointerId, false);
        return;
      }
      const step = event.shiftKey ? 32 : 16;
      let nextWidth: number | null = null;
      if (event.key === "ArrowLeft") nextWidth = chatWidth - step;
      else if (event.key === "ArrowRight") nextWidth = chatWidth + step;
      else if (event.key === "Home") nextWidth = WORK_PANEL_CHAT_MIN_WIDTH;
      else if (event.key === "End") nextWidth = WORK_PANEL_CHAT_MAX_WIDTH;
      if (nextWidth === null) return;
      event.preventDefault();
      enqueueChatWidth(nextWidth);
    },
    [chatWidth, enqueueChatWidth, finishChatResize],
  );
  const activeLabel = activeTab ? tabLabel(activeTab, t, pluginViews) : t("panel.title");
  const activePluginView =
    activeTab?.kind === "plugin"
      ? pluginViews.find((view) => view.ref === activeTab.resource)
      : undefined;
  const ActiveIcon = activeTab
    ? (activeTab.kind === "plugin"
        ? pluginViewIcon(activePluginView?.icon) ?? TAB_ICONS.plugin
        : TAB_ICONS[activeTab.kind])
    : IconDiff;
  const exitAnimationReady = exiting && nativeSurfaceReadyForExit;
  const panelStyle = {
    width: renderPanelWidth,
    "--work-panel-width": `${renderPanelWidth}px`,
  } as CSSProperties;

  return (
    <aside
      className={cx(
        "work-panel",
        exiting && !exitAnimationReady && "is-exit-pending",
        exitAnimationReady && "is-exiting",
      )}
      style={panelStyle}
      data-testid="work-panel"
      data-resizing={isResizing ? "true" : undefined}
      data-exiting={exiting ? "true" : undefined}
      onAnimationEnd={(event) => {
        if (!exitAnimationReady) return;
        // Bubbled tab/chrome animations must not finish the shell exit.
        if (event.target !== event.currentTarget) return;
        if (!event.animationName.startsWith("work-panel-out")) return;
        onExitAnimationEnd?.();
      }}
    >
      <div
        className="work-panel-resize no-drag"
        role="separator"
        aria-orientation="vertical"
        aria-label={t("panel.resizeChat")}
        aria-valuemin={WORK_PANEL_CHAT_MIN_WIDTH}
        aria-valuemax={WORK_PANEL_CHAT_MAX_WIDTH}
        aria-valuenow={Math.round(chatDragWidth ?? chatWidth)}
        tabIndex={0}
        onPointerDown={onChatResizeStart}
        onPointerMove={onChatResizeMove}
        onPointerUp={onChatResizeCommit}
        onPointerCancel={onChatResizeCancel}
        onLostPointerCapture={onChatResizeCancel}
        onKeyDown={onChatResizeKeyDown}
      />
      <div className="work-panel-main">
        <header className="work-panel-header" data-work-panel-section="current">
          <div className="work-panel-context no-drag" ref={contextRef}>
            <button
              ref={contextButtonRef}
              type="button"
              className="work-panel-switcher-trigger"
              aria-haspopup="menu"
              aria-expanded={contextOpen}
              aria-controls="work-panel-context-menu"
              title={activeTab?.resource ?? activeLabel}
              onClick={() => setContextOpen((open) => !open)}
              onKeyDown={onTriggerKeyDown}
            >
              <span className="work-panel-current-icon" aria-hidden>
                <ActiveIcon size={15} />
              </span>
              <span
                id={activeTab ? `work-panel-title-${activeTab.id}` : undefined}
                className="work-panel-current-label"
              >
                {activeLabel}
              </span>
              <IconChevronDown
                size={13}
                className={cx("work-panel-switcher-chevron", contextOpen && "open")}
              />
            </button>
            {contextOpen && (
              <div
                id="work-panel-context-menu"
                className="work-panel-context-menu"
                role="menu"
                aria-label={t("panel.title")}
                onKeyDown={onContextKeyDown}
              >
                {/* Tools keep fixed positions so switching stays muscle
                    memory; open tools carry their own close control here
                    instead of repeating in a second list. */}
                <div
                  className="work-panel-menu-group"
                  role="group"
                  aria-labelledby="work-panel-menu-tools"
                >
                  <div className="work-panel-menu-title" id="work-panel-menu-tools">
                    {t("panel.tools")}
                  </div>
                  {HEADER_TOOLS.map(({ kind, Icon }, index) => {
                    const tab = tabs.find((candidate) => candidate.id === kind);
                    const selected = tab?.id === activeTabId;
                    const label = t(`panel.tabs.${kind}`);
                    return (
                      <div
                        className={cx("work-panel-menu-row", selected && "active")}
                        role="none"
                        key={kind}
                      >
                        <button
                          type="button"
                          role="menuitemradio"
                          aria-checked={selected}
                          tabIndex={-1}
                          data-work-panel-menu-item=""
                          data-work-panel-close-id={tab ? tab.id : undefined}
                          data-action={`open-work-panel-${kind}`}
                          className="work-panel-menu-item"
                          title={label}
                          onClick={() => openTool(kind)}
                        >
                          <Icon size={15} />
                          <span className="work-panel-menu-label">{label}</span>
                          {tab && !selected && (
                            <span className="work-panel-open-dot" aria-hidden />
                          )}
                        </button>
                        <span className="work-panel-menu-slot">
                          {tab && (
                            <button
                              type="button"
                              tabIndex={-1}
                              data-work-panel-menu-close=""
                              className="work-panel-menu-close"
                              title={t("panel.closeTab", { name: label })}
                              aria-label={t("panel.closeTab", { name: label })}
                              onClick={() => closeTabFromMenu(tab.id, index)}
                            >
                              <IconClose size={12} />
                            </button>
                          )}
                        </span>
                      </div>
                    );
                  })}
                </div>
                {pluginViews.length > 0 && (
                  <>
                    <div className="work-panel-context-divider" />
                    {/* Plugin views sit with the tools rather than the opened
                        resources: they are entry points the user picks, not
                        things the transcript produced. Rows mirror the tool
                        rows exactly — edge marker, open dot, reserved close
                        slot — so a plugin surface is not visibly second-class
                        next to a built-in one. */}
                    <div
                      className="work-panel-menu-group"
                      role="group"
                      aria-labelledby="work-panel-menu-plugin-views"
                    >
                      <div
                        className="work-panel-menu-title"
                        id="work-panel-menu-plugin-views"
                      >
                        {t("panel.pluginViews")}
                      </div>
                      {pluginViews.map((view, index) => {
                        const tabId = pluginWorkPanelTab(view.pluginId, view.viewId).id;
                        const tab = tabs.find((candidate) => candidate.id === tabId);
                        const selected = tab?.id === activeTabId;
                        const Icon = pluginViewIcon(view.icon);
                        const itemIndex = HEADER_TOOLS.length + index;
                        return (
                          <div
                            className={cx("work-panel-menu-row", selected && "active")}
                            role="none"
                            key={view.ref}
                          >
                            <button
                              type="button"
                              role="menuitemradio"
                              aria-checked={selected}
                              tabIndex={-1}
                              data-work-panel-menu-item=""
                              data-work-panel-close-id={tab ? tab.id : undefined}
                              data-work-panel-plugin-view={view.ref}
                              className="work-panel-menu-item"
                              title={`${view.title} — ${view.pluginName}`}
                              onClick={() => openPluginView(view)}
                            >
                              {Icon ? (
                                <Icon size={15} />
                              ) : (
                                <span className="work-panel-view-initial" aria-hidden>
                                  {pluginViewInitial(view.title)}
                                </span>
                              )}
                              <span className="work-panel-menu-label">{view.title}</span>
                              {tab && !selected && (
                                <span className="work-panel-open-dot" aria-hidden />
                              )}
                            </button>
                            <span className="work-panel-menu-slot">
                              {tab && (
                                <button
                                  type="button"
                                  tabIndex={-1}
                                  data-work-panel-menu-close=""
                                  className="work-panel-menu-close"
                                  title={t("panel.closeTab", { name: view.title })}
                                  aria-label={t("panel.closeTab", { name: view.title })}
                                  onClick={() => closeTabFromMenu(tab.id, itemIndex)}
                                >
                                  <IconClose size={12} />
                                </button>
                              )}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </>
                )}
                {resourceTabs.length > 0 && (
                  <>
                    <div className="work-panel-context-divider" />
                    <div
                      className="work-panel-menu-group"
                      role="group"
                      aria-labelledby="work-panel-menu-resources"
                    >
                      <div
                        className="work-panel-menu-title"
                        id="work-panel-menu-resources"
                      >
                        {t("panel.openItems")}
                      </div>
                      {resourceTabs.map((tab, index) => {
                        const label = tabLabel(tab, t, pluginViews);
                        const Icon = TAB_ICONS[tab.kind];
                        const selected = tab.id === activeTabId;
                        // Focus restoration after a close counts menu rows, so
                        // this index has to include every group drawn above.
                        const itemIndex =
                          HEADER_TOOLS.length + pluginViews.length + index;
                        return (
                          <div
                            className={cx("work-panel-menu-row", selected && "active")}
                            role="none"
                            key={tab.id}
                            data-work-panel-tab={tab.id}
                          >
                            <button
                              type="button"
                              role="menuitemradio"
                              aria-checked={selected}
                              tabIndex={-1}
                              data-work-panel-switch-item=""
                              data-work-panel-menu-item=""
                              data-work-panel-close-id={tab.id}
                              className="work-panel-menu-item"
                              title={tab.resource ?? label}
                              onClick={() => selectTab(tab.id)}
                            >
                              <Icon size={15} />
                              <span className="work-panel-menu-label">{label}</span>
                            </button>
                            <span className="work-panel-menu-slot">
                              <button
                                type="button"
                                tabIndex={-1}
                                data-work-panel-menu-close=""
                                className="work-panel-menu-close"
                                title={t("panel.closeTab", { name: label })}
                                aria-label={t("panel.closeTab", { name: label })}
                                onClick={() => closeTabFromMenu(tab.id, itemIndex)}
                              >
                                <IconClose size={12} />
                              </button>
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
          <div className="work-panel-actions no-drag">
            {activeTab && (
              <button
                type="button"
                className="work-panel-current-close"
                title={t("panel.closeTab", { name: activeLabel })}
                aria-label={t("panel.closeTab", { name: activeLabel })}
                onClick={() => closeTab(activeTab.id)}
              >
                <IconClose size={14} />
              </button>
            )}
            {onCollapse && (
              <button
                type="button"
                className="work-panel-toolbar-collapse"
                data-action="collapse-work-panel"
                title={t("panel.collapse")}
                aria-label={t("panel.collapse")}
                onClick={onCollapse}
              >
                <IconChevronRight size={16} />
              </button>
            )}
          </div>
        </header>
        <div className="work-panel-body">
          {activeTab?.kind === "review" && (
            <div
              id={`work-panel-surface-${activeTab.id}`}
              className="work-panel-tabpane"
              role="tabpanel"
              aria-labelledby={`work-panel-title-${activeTab.id}`}
            >
              <ReviewTab />
            </div>
          )}
          {activeTab?.kind === "browser" && (
            <div
              key={`${activeSessionId ?? "none"}:${activeTab.id}`}
              id={`work-panel-surface-${activeTab.id}`}
              className="work-panel-tabpane"
              role="tabpanel"
              aria-labelledby={`work-panel-title-${activeTab.id}`}
            >
              <BrowserTab
                blocked={
                  exiting || panelBlocked || contextOpen || isResizing
                }
                sessionId={activeSessionId}
                initialUrl={activeTab.resource}
              />
            </div>
          )}
          {activeTab?.kind === "file" && (
            <div
              key={activeTab.id}
              id={`work-panel-surface-${activeTab.id}`}
              className="work-panel-tabpane"
              role="tabpanel"
              aria-labelledby={`work-panel-title-${activeTab.id}`}
            >
              <FilesTab />
            </div>
          )}
          {/* A plugin view is remounted per ref so switching between two views
              of the same plugin re-measures rather than reusing a stale rect.
              The host process keeps the page alive across that remount, so the
              plugin does not lose its state. */}
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
                  aria-labelledby={`work-panel-title-${activeTab.id}`}
                >
                  <PluginViewTab
                    pluginId={ref.pluginId}
                    viewId={ref.viewId}
                    title={activeLabel}
                    icon={activePluginView?.icon}
                    blocked={
                      exiting || panelBlocked || contextOpen || isResizing
                    }
                  />
                </div>
              );
            })()}
          {/* `Cmd/Ctrl+J` reveals the panel without creating a resource, so the
              body can be empty. No tab exists to label a tabpanel here; the
              same entries the header menu offers — built-in tools first, then
              plugin views — are listed inline so the revealed panel is not a
              dead end. */}
          {!activeTab && (
            <div className="work-panel-tabpane" data-testid="work-panel-empty">
              <WorkTabEmpty
                icon={IconPanel}
                title={t("panel.empty.title")}
                body={t("panel.empty.body")}
              >
                <div
                  className="work-panel-empty-tools"
                  role="group"
                  aria-label={t("panel.tools")}
                >
                  {HEADER_TOOLS.map(({ kind, Icon }) => (
                    <button
                      key={kind}
                      type="button"
                      className="work-panel-empty-tool"
                      data-action={`open-work-panel-${kind}`}
                      onClick={() => openTool(kind)}
                    >
                      <Icon size={15} />
                      <span>{t(`panel.tabs.${kind}`)}</span>
                    </button>
                  ))}
                  {pluginViews.map((view) => {
                    const Icon = pluginViewIcon(view.icon);
                    return (
                      <button
                        key={view.ref}
                        type="button"
                        className="work-panel-empty-tool"
                        data-work-panel-plugin-view={view.ref}
                        title={`${view.title} — ${view.pluginName}`}
                        onClick={() => openPluginView(view)}
                      >
                        {Icon ? (
                          <Icon size={15} />
                        ) : (
                          <span className="work-panel-view-initial" aria-hidden>
                            {pluginViewInitial(view.title)}
                          </span>
                        )}
                        <span>{view.title}</span>
                      </button>
                    );
                  })}
                </div>
              </WorkTabEmpty>
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
