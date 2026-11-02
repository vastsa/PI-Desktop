import { IconClock } from "./icons";
import { RemoteProjectGroups } from "./remote/RemoteProjectGroups";
import { groupRemoteProjectSessions } from "../lib/remote-project-catalog";
import { isRemoteSession, sessionAllows } from "../lib/remote-session-safety";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type AnimationEventHandler as ReactAnimationEventHandler,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { TooltipButton, cx } from "./ui";

import { portalToBody } from "../lib/portal-visibility";
import {
  placeSidebarFloatingMenuTop,
  SIDEBAR_FLOATING_MENU_MAX_HEIGHT,
  SIDEBAR_MENU_VIEWPORT_PADDING,
} from "../lib/sidebar-floating-menu";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";
import { formatSessionLastReplyDate } from "../lib/sidebar-session-date";
import { SessionHoverCard } from "../features/sessions/SessionHoverCard";
import { useSessionHoverCard } from "../features/sessions/useSessionHoverCard";
import { isDefaultSessionTitle, useAppStore } from "../stores/app-store";
import {
  getGlobalPinnedSessions,
  normalizeProjectPath,
  sessionArchived,
  sessionPinned,
} from "../lib/sidebar-session-groups";
import {
  getVisibleProjectSessions,
  updateProjectSessionExpansion,
} from "../lib/sidebar-project-sessions";
import { listableSessions } from "../lib/session-origin";
import {
  composerDropItems,
  hasComposerFileDrag,
} from "../lib/composer-drop";
import {
  projectGroupKeyFromPoint,
  projectReorderInsertAfter,
  projectReorderShouldArm,
  sameProjectReorderBucket,
} from "../lib/sidebar-project-reorder";
import {
  sidebarSessionStatus,
  type SidebarSessionStatus,
} from "../lib/sidebar-session-status";
import {
  projectRunSummaryIsLive,
  resolveSidebarRunningAffordances,
  summarizeProjectRuns,
} from "../lib/sidebar-project-runs";
import {
  ProjectRunBadge,
  ProjectRunCount,
  ProjectRunRail,
} from "./ProjectRunIndicator";
import { ErrorCodes, formatSessionLink } from "@pi-desktop/shared";
import type { SessionSummary } from "@pi-desktop/shared";
import type {
  ProjectMeta,
  ProjectSort,
  SessionSort,
} from "../lib/sidebar-preferences";
import {
  clampSidebarWidth,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
} from "../lib/sidebar-preferences";
import {
  SIDEBAR_RESIZE_STEP,
  sidebarPointerResize,
  sidebarResetWidth,
} from "../lib/sidebar-resize";
import { BrandLogo } from "./BrandLogo";
import { NotificationCenter } from "./NotificationCenter";
import {
  WorktreeBadge,
  WorktreeDialogs,
  useWorktreeDeleteLossText,
  useWorktreeProjectMenuItems,
  useWorktreeSessionMenuItems,
} from "../features/worktree/WorktreeSidebarParts";
import { WorktreeBehindWatcher } from "../features/worktree/WorktreeBehind";
import { SidebarMenuPanel, sidebarMenuKeyDown } from "./SidebarMenuPanel";
import {
  sidebarMenuAction,
  sidebarMenuCheck,
  sidebarMenuGroup,
  sidebarMenuSection,
  sidebarMenuSubmenu,
  type SidebarMenuPanelContent,
} from "../lib/sidebar-menu";
import { useArmedDelete } from "../hooks/use-armed-delete";
import { useUpdateState } from "../hooks/use-update-state";
import { ProjectDeleteDialog } from "./ProjectDeleteDialog";
import { ProjectEditDialog } from "./ProjectEditDialog";
import { SessionRenameDialog } from "./SessionRenameDialog";
import {
  IconArchive,
  IconArchiveRestore,
  IconArrowUpDown,
  IconPlug,
  IconBranch,
  IconCheck,
  IconChevronDown,
  IconCopy,
  IconCircleAlert,
  IconNewSession,
  IconFolder,
  IconMore,
  IconNewProject,
  IconPin,
  IconPencil,
  IconSidebar,
  IconSettings,
  IconStar,
  IconTrash,
  IconX,
} from "./icons";

type ProjectEntry = {
  path: string;
  displayPath?: string;
  key: string;
  name: string;
  sessions: SessionSummary[];
  open: boolean;
  active: boolean;
  meta: ProjectMeta;
  /** Best-effort git branch from the project workspace, if known. */
  branch?: string;
};

/** Private MIME so a sidebar session drag is never mistaken for an OS file drop. */
const SESSION_DRAG_MIME = "application/x-pi-desktop-session";

type SidebarResizeState = {
  pointerId: number;
  startX: number;
  startWidth: number;
  currentWidth: number;
  frame: number;
  handle: HTMLDivElement;
};

type ProjectReorderPointerState = {
  pointerId: number;
  projectKey: string;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  armed: boolean;
  dropKey: string | null;
  dropTop: number;
  dropHeight: number;
  insertAfter: boolean;
  onMove: (event: PointerEvent) => void;
  onUp: (event: PointerEvent) => void;
  onCancel: (event: PointerEvent) => void;
};

function clearSidebarResizeStyles(): void {
  document.documentElement.removeAttribute("data-sidebar-resizing");
}

function projectName(path: string, fallback?: string) {
  if (fallback?.trim()) return fallback.trim();
  const clean = path.replace(/[\\/]+$/, "");
  const parts = clean.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || path;
}

function timestamp(value?: string) {
  const parsed = value ? Date.parse(value) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

function optionalTimestamp(value?: string): number | null {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function projectMetaFor(
  path: string,
  projectMeta: Record<string, ProjectMeta>,
): ProjectMeta {
  return projectMeta[normalizeProjectPath(path) || path] ?? projectMeta[path] ?? {};
}

function projectDomId(path: string): string {
  let hash = 2166136261;
  for (let index = 0; index < path.length; index += 1) {
    hash ^= path.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `sidebar-project-${(hash >>> 0).toString(36)}`;
}

function firstSessionDate(
  sessions: SessionSummary[],
  field: "createdAt" | "updatedAt",
): number | null {
  const values = sessions
    .map((session) => timestamp(session[field]))
    .filter((value) => value > 0);
  return values.length ? Math.min(...values) : null;
}

function lastSessionDate(
  sessions: SessionSummary[],
  field: "createdAt" | "updatedAt",
): number | null {
  const values = sessions
    .map((session) => timestamp(session[field]))
    .filter((value) => value > 0);
  return values.length ? Math.max(...values) : null;
}

function compareOptionalDate(
  a: number | null,
  b: number | null,
  descending: boolean,
): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return descending ? b - a : a - b;
}

export function Sidebar({
  onToggleSidebar,
  sidebarToggleShortcut,
  sidebarWidth,
  widthMax = SIDEBAR_WIDTH_MAX,
  onWidthChange,
  onWidthCommit,
  onResizeCollapse,
  className,
  onAnimationEnd,
}: {
  onToggleSidebar: () => void;
  sidebarToggleShortcut: string;
  sidebarWidth: number;
  widthMax?: number;
  onWidthChange: (width: number) => void;
  onWidthCommit: (width: number) => void;
  onResizeCollapse: () => void;
  className?: string;
  onAnimationEnd?: ReactAnimationEventHandler<HTMLElement>;
}) {
  const { t, i18n } = useTranslation();
  const sessions = useAppStore((s) => s.sessions);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const selectingSessionId = useAppStore((s) => s.selectingSessionId);
  const workspace = useAppStore((s) => s.workspace);
  const openProjects = useAppStore((s) => s.openProjects);
  const openProjectPathsState = useAppStore((s) => s.openProjectPaths);
  const activeProjectPathState = useAppStore((s) => s.activeProjectPath);
  const projectMeta = useAppStore((s) => s.projectMeta);
  const projectCollapsed = useAppStore((s) => s.projectCollapsed);
  const sessionMeta = useAppStore((s) => s.sessionMeta);
  const sessionView = useAppStore((s) => s.sessionView);
  const projectSort = useAppStore((s) => s.projectSort);
  const runningSessions = useAppStore((s) => s.runningSessions);
  const sessionOutcomes = useAppStore((s) => s.sessionOutcomes);
  const pendingPermissions = useAppStore((s) => s.pendingPermissions);
  const setPage = useAppStore((s) => s.setPage);
  const navBack = useAppStore((s) => s.navBack);
  const canNavBack = useAppStore((s) => s.canNavBack);
  const page = useAppStore((s) => s.page);
  const settings = useAppStore((s) => s.settings);
  // Project headers must answer "is anything running under here?" while the
  // group is collapsed, so both affordances are resolved once per render
  // rather than re-derived per row.
  const runningAffordances = resolveSidebarRunningAffordances(settings);
  const prefetchSession = useAppStore((s) => s.prefetchSession);
  const selectSession = useAppStore((s) => s.selectSession);
  const newSession = useAppStore((s) => s.newSession);
  const forkSessionAction = useAppStore((s) => s.forkSession);
  const openProject = useAppStore((s) => s.openProject);
  const refreshProject = useAppStore((s) => s.refreshProject);
  const clearProject = useAppStore((s) => s.clearProject);
  const activateProject = useAppStore((s) => s.activateProject);
  const renameProject = useAppStore((s) => s.renameProject);
  const toggleSessionPinned = useAppStore((s) => s.toggleSessionPinned);
  const archiveSessionAction = useAppStore((s) => s.archiveSession);
  const restoreSession = useAppStore((s) => s.restoreSession);
  const renameSession = useAppStore((s) => s.renameSession);
  const deleteSessionAction = useAppStore((s) => s.deleteSession);
  const setSessionSort = useAppStore((s) => s.setSessionSort);
  const moveSessionProject = useAppStore((s) => s.moveSessionProject);
  const setSessionArchiveVisibility = useAppStore((s) => s.setSessionArchiveVisibility);
  const toggleProjectPinned = useAppStore((s) => s.toggleProjectPinned);
  const archiveProjectAction = useAppStore((s) => s.archiveProject);
  const restoreProject = useAppStore((s) => s.restoreProject);
  const setProjectCollapsed = useAppStore((s) => s.setProjectCollapsed);
  const setProjectSort = useAppStore((s) => s.setProjectSort);
  const reorderProjects = useAppStore((s) => s.reorderProjects);
  const showToast = useAppStore((s) => s.showToast);
  const version = useAppStore((s) => s.version);
  const setSettingsTab = useAppStore((s) => s.setSettingsTab);
  const setSettingsAnchor = useAppStore((s) => s.setSettingsAnchor);
  const update = useUpdateState();

  const [sortOpen, setSortOpen] = useState(false);
  const [sessionMenu, setSessionMenu] = useState<string | null>(null);
  const [renameFor, setRenameFor] = useState<SessionSummary | null>(null);
  const [editProjectFor, setEditProjectFor] = useState<ProjectEntry | null>(null);
  const [deleteProjectFor, setDeleteProjectFor] = useState<ProjectEntry | null>(null);
  // Which row menu item is armed for its second, confirming click.
  const { armed: armedDelete, setArmed: setArmedDelete } = useArmedDelete();
  const [projectMenu, setProjectMenu] = useState<string | null>(null);
  // Multi-select: Shift/Cmd+click session rows for batch operations.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const lastClickedIdRef = useRef<string | null>(null);
  const [sectionMenu, setSectionMenu] = useState<"sessions" | "projects" | null>(null);
  const [menuPosition, setMenuPosition] = useState<{
    top: number;
    left: number;
    anchorTop: number;
    anchorBottom: number;
  } | null>(null);
  const {
    card: sessionHoverCard,
    show: revealSessionHoverCard,
    hide: hideSessionHoverCard,
    scheduleHide: scheduleSessionHoverCardHide,
    keepVisible: keepSessionHoverCardVisible,
    registerDismissGuard: registerSessionHoverCardDismissGuard,
  } = useSessionHoverCard();
  const [expandedProjectSessions, setExpandedProjectSessions] = useState<Record<string, boolean>>({});
  const [draggingSessionId, setDraggingSessionId] = useState<string | null>(null);
  const [dropProjectKey, setDropProjectKey] = useState<string | null>(null);
  const [projectsDropActive, setProjectsDropActive] = useState(false);
  const [sidebarResizing, setSidebarResizing] = useState(false);
  const [draggingProjectKey, setDraggingProjectKey] = useState<string | null>(null);
  const [dropIndicator, setDropIndicator] = useState<{ key: string; insertAfter: boolean } | null>(null);
  const [windowFocused, setWindowFocused] = useState(true);

  const menuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const menuFirstItemRef = useRef<HTMLButtonElement | null>(null);
  const floatingMenuRef = useRef<HTMLDivElement | null>(null);
  const sessionPrefetchTimerRef = useRef<number | undefined>(undefined);
  const sidebarResizeRef = useRef<SidebarResizeState | null>(null);
  const projectReorderRef = useRef<ProjectReorderPointerState | null>(null);
  const suppressProjectTitleClickRef = useRef(false);
  const projectEntriesRef = useRef<ProjectEntry[]>([]);
  const reorderProjectEntriesRef = useRef<(
    sourceKey: string,
    targetKey: string,
    insertAfter: boolean,
  ) => void>(() => {});

  const finishSidebarResize = useCallback((cancelled: boolean, collapse = false) => {
    const state = sidebarResizeRef.current;
    if (!state) return;
    if (collapse) {
      // Keep the previewed width for the exit animation and persist nothing:
      // the shell restores the preferred expanded width on reopen.
    } else if (cancelled) {
      onWidthChange(state.startWidth);
    } else {
      onWidthChange(state.currentWidth);
      onWidthCommit(state.currentWidth);
    }
    sidebarResizeRef.current = null;
    if (state.frame) cancelAnimationFrame(state.frame);
    clearSidebarResizeStyles();
    if (state.handle.hasPointerCapture(state.pointerId)) {
      state.handle.releasePointerCapture(state.pointerId);
    }
    setSidebarResizing(false);
    if (collapse) onResizeCollapse();
  }, [onResizeCollapse, onWidthChange, onWidthCommit]);

  const startSidebarResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || sidebarResizeRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.focus({ preventScroll: true });
    // Anchor to the rendered width so pressing the handle never resizes the
    // column; the live budget only limits where the gesture may land.
    const startWidth = clampSidebarWidth(sidebarWidth);
    sidebarResizeRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth,
      currentWidth: startWidth,
      frame: 0,
      handle: event.currentTarget,
    };
    setSidebarResizing(true);
    document.documentElement.setAttribute("data-sidebar-resizing", "true");
    event.currentTarget.setPointerCapture(event.pointerId);
  }, [sidebarWidth, widthMax]);

  const moveSidebarResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const state = sidebarResizeRef.current;
    if (!state || state.pointerId !== event.pointerId) return;
    const result = sidebarPointerResize({
      startWidth: state.startWidth,
      deltaX: event.clientX - state.startX,
      maxWidth: widthMax,
    });
    if (result.type === "collapse") {
      finishSidebarResize(true, true);
      return;
    }
    state.currentWidth = result.width;
    if (state.frame) return;
    state.frame = requestAnimationFrame(() => {
      if (sidebarResizeRef.current !== state) return;
      state.frame = 0;
      onWidthChange(state.currentWidth);
    });
  }, [finishSidebarResize, onWidthChange, widthMax]);

  const endSidebarResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (sidebarResizeRef.current?.pointerId !== event.pointerId) return;
    finishSidebarResize(false);
  }, [finishSidebarResize]);

  const cancelSidebarResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (sidebarResizeRef.current?.pointerId !== event.pointerId) return;
    finishSidebarResize(true);
  }, [finishSidebarResize]);

  const handleSidebarResizeKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const currentWidth = clampSidebarWidth(sidebarWidth, widthMax);
    const nextWidth = event.key === "Home"
      ? SIDEBAR_WIDTH_MIN
      : event.key === "End"
        ? clampSidebarWidth(widthMax, widthMax)
        : clampSidebarWidth(
            currentWidth + (event.key === "ArrowRight" ? SIDEBAR_RESIZE_STEP : -SIDEBAR_RESIZE_STEP),
            widthMax,
          );
    if (nextWidth === currentWidth) return;
    onWidthCommit(nextWidth);
  }, [onWidthCommit, sidebarWidth, widthMax]);

  /**
   * Double-click reset: the shell's default width, clamped by the live
   * three-column budget. A pointer gesture that is somehow still open is
   * dropped first so its release cannot overwrite the reset.
   */
  const resetSidebarWidth = useCallback(() => {
    if (sidebarResizeRef.current) finishSidebarResize(true);
    onWidthCommit(sidebarResetWidth(widthMax));
  }, [finishSidebarResize, onWidthCommit, widthMax]);

  useEffect(() => {
    if (!sidebarResizing) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      finishSidebarResize(true);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [finishSidebarResize, sidebarResizing]);

  useEffect(() => {
    return () => {
      const state = sidebarResizeRef.current;
      if (!state) return;
      if (state.frame) cancelAnimationFrame(state.frame);
      onWidthChange(state.startWidth);
      clearSidebarResizeStyles();
      sidebarResizeRef.current = null;
    };
  }, [onWidthChange]);

  // Mirror window focus onto the sidebar; a blurred window can keep CSS :hover
  // latched on the row under the cursor.
  useEffect(() => {
    const onWindowFocus = () => setWindowFocused(document.hasFocus());
    const onWindowBlur = () => setWindowFocused(false);
    window.addEventListener("focus", onWindowFocus);
    window.addEventListener("blur", onWindowBlur);
    return () => {
      window.removeEventListener("focus", onWindowFocus);
      window.removeEventListener("blur", onWindowBlur);
    };
  }, []);

  // Escape clears multi-select (only when no menu is open — menus consume
  // their own Escape first, so clearing happens on the next press).
  useEffect(() => {
    if (selectedIds.size === 0) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Let menu/sort close handlers consume Escape first.
      if (sessionMenu || projectMenu || sectionMenu || sortOpen) return;
      setSelectedIds(new Set());
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedIds.size, sessionMenu, projectMenu, sectionMenu, sortOpen]);

  const showArchived = sessionView.archived;
  const sessionSort = sessionView.sort;
  const displaySessionSort: Exclude<SessionSort, "manual"> =
    sessionSort === "manual" ? "recent" : sessionSort;
  const displayProjectSort: ProjectSort = projectSort;
  const activeProjectPath = normalizeProjectPath(activeProjectPathState ?? workspace?.path);
  const selectedSessionId = selectingSessionId ?? activeSessionId;
  const openProjectPaths = useMemo(
    () =>
      openProjectPathsState
        .map((path) => normalizeProjectPath(path))
        .filter((path): path is string => Boolean(path)),
    [openProjectPathsState],
  );

  const closeMenus = useCallback((restoreFocus = true) => {
    const trigger = menuTriggerRef.current;
    setSortOpen(false);
    setSessionMenu(null);
    setProjectMenu(null);
    setSectionMenu(null);
    setMenuPosition(null);
    if (restoreFocus && trigger) requestAnimationFrame(() => trigger.focus());
  }, []);

  const placeMenu = useCallback((event: ReactMouseEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const anchor = { top: rect.top, bottom: rect.bottom };
    setMenuPosition({
      top: placeSidebarFloatingMenuTop(
        anchor,
        SIDEBAR_FLOATING_MENU_MAX_HEIGHT,
        window.innerHeight,
      ),
      left: Math.max(SIDEBAR_MENU_VIEWPORT_PADDING, rect.right + 4),
      anchorTop: anchor.top,
      anchorBottom: anchor.bottom,
    });
  }, []);

  // Body-level sidebar menus always anchor their left edge to the right side
  // of the trigger or pointer; they never flip to the left at the viewport edge.
  const placeMenuAtPoint = useCallback((x: number, y: number) => {
    const anchor = { top: y, bottom: y };
    setMenuPosition({
      top: placeSidebarFloatingMenuTop(
        anchor,
        SIDEBAR_FLOATING_MENU_MAX_HEIGHT,
        window.innerHeight,
      ),
      left: Math.max(SIDEBAR_MENU_VIEWPORT_PADDING, x + 4),
      anchorTop: anchor.top,
      anchorBottom: anchor.bottom,
    });
  }, []);

  const openSessionRowMenu = useCallback(
    (sessionId: string, trigger: HTMLButtonElement | null) => {
      menuTriggerRef.current = trigger;
      setSortOpen(false);
      setProjectMenu(null);
      setSectionMenu(null);
      hideSessionHoverCard();
      setSessionMenu(sessionId);
    },
    [hideSessionHoverCard],
  );

  const openProjectRowMenu = useCallback(
    (projectKey: string, trigger: HTMLButtonElement | null) => {
      menuTriggerRef.current = trigger;
      setSortOpen(false);
      setSessionMenu(null);
      setSectionMenu(null);
      setProjectMenu(projectKey);
    },
    [],
  );

  const openSectionMenu = useCallback(
    (section: "sessions" | "projects", x: number, y: number) => {
      menuTriggerRef.current = null;
      setSortOpen(false);
      setSessionMenu(null);
      setProjectMenu(null);
      placeMenuAtPoint(x, y);
      setSectionMenu(section);
    },
    [placeMenuAtPoint],
  );

  useEffect(() => {
    if (!sortOpen && !sessionMenu && !projectMenu && !sectionMenu) return;
    const onPointer = (e: PointerEvent) => {
      // Right-click must not dismiss first; contextmenu handlers reopen create menus.
      if (e.button === 2 || (e.pointerType === "mouse" && e.buttons === 2)) return;
      const target = e.target as Node;
      if ((target as Element)?.closest?.(
        ".sidebar-popover, .sidebar-row-menu, .notification-popover-portaled",
      )) return;
      closeMenus(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      closeMenus();
    };
    const onViewportChange = () => closeMenus(false);
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onViewportChange);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onViewportChange);
    };
  }, [sortOpen, sessionMenu, projectMenu, sectionMenu, closeMenus]);

  useEffect(() => {
    if (!sessionMenu && !projectMenu && !sectionMenu && !sortOpen) return;
    requestAnimationFrame(() => menuFirstItemRef.current?.focus());
  }, [sessionMenu, projectMenu, sectionMenu, sortOpen]);

  const menuAnchorTop = menuPosition?.anchorTop;
  const menuAnchorBottom = menuPosition?.anchorBottom;

  useLayoutEffect(() => {
    if (menuAnchorTop === undefined || menuAnchorBottom === undefined) return;
    const menu = floatingMenuRef.current;
    if (!menu) return;

    const reposition = () => {
      const top = placeSidebarFloatingMenuTop(
        { top: menuAnchorTop, bottom: menuAnchorBottom },
        menu.getBoundingClientRect().height,
        window.innerHeight,
      );
      setMenuPosition((current) =>
        current && current.top !== top ? { ...current, top } : current,
      );
    };

    reposition();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(reposition);
    observer.observe(menu);
    return () => observer.disconnect();
  }, [
    menuAnchorTop,
    menuAnchorBottom,
    sessionMenu,
    projectMenu,
    sectionMenu,
    sortOpen,
  ]);

  // An update only earns the accent dot once it is actionable — a pending
  // check or a failed one keeps the chip quiet.
  const updateReady =
    update?.status === "available" || update?.status === "downloaded";
  const appVersion = update?.currentVersion || version?.version || "";
  const buildLabel = updateReady
    ? `v${update?.availableVersion ?? appVersion}`
    : update?.status === "checking"
      ? t("updates.checking")
      : appVersion
        ? `v${appVersion}`
        : t("nav.buildUnknown");
  const buildTitle = updateReady
    ? t("updates.available", { version: update?.availableVersion ?? "" })
    : t("nav.checkForUpdates");
  const taskTitle = useCallback((title?: string | null) => {
    const value = (title || "").trim();
    return isDefaultSessionTitle(value) ? t("chat.untitledTask") : value;
  }, [t]);

  const filtered = useMemo(() => {
    // A scheduled run's transcript belongs to the Scheduled page, not to the
    // project groups: that page's task column and run history are its entry
    // point (issue #1291). The session stays in the store so the chat surface
    // can still resolve its title, source, and capabilities when it is opened
    // from there.
    const candidates = listableSessions(sessions)
      .filter((session) => showArchived || !sessionArchived(session, sessionMeta[session.id]));
    // Empty sessions are durable sidebar rows now. Their message count, not
    // their title, controls New Task reuse, so a manual rename never changes
    // the empty-slot behavior.
    return candidates;
  }, [sessions, showArchived, sessionMeta]);

  const compareSessions = useCallback((a: SessionSummary, b: SessionSummary) => {
    const aMeta = sessionMeta[a.id] ?? {};
    const bMeta = sessionMeta[b.id] ?? {};
    const archiveOrder = Number(sessionArchived(a, aMeta)) - Number(sessionArchived(b, bMeta));
    if (archiveOrder !== 0) return archiveOrder;
    const pinOrder = Number(sessionPinned(b, bMeta)) - Number(sessionPinned(a, aMeta));
    if (pinOrder !== 0) return pinOrder;
    if (displaySessionSort === "name") {
      const byName = taskTitle(a.title).localeCompare(taskTitle(b.title), undefined, {
        sensitivity: "base",
      });
      if (byName !== 0) return byName;
    } else if (displaySessionSort === "oldest") {
      const byCreated = compareOptionalDate(
        optionalTimestamp(a.createdAt),
        optionalTimestamp(b.createdAt),
        false,
      );
      if (byCreated !== 0) return byCreated;
    } else if (displaySessionSort === "created") {
      const byCreated = compareOptionalDate(
        optionalTimestamp(a.createdAt),
        optionalTimestamp(b.createdAt),
        true,
      );
      if (byCreated !== 0) return byCreated;
    } else {
      const byRecent = compareOptionalDate(
        optionalTimestamp(a.updatedAt),
        optionalTimestamp(b.updatedAt),
        true,
      );
      if (byRecent !== 0) return byRecent;
    }
    return a.id.localeCompare(b.id);
  }, [displaySessionSort, sessionMeta, taskTitle]);

  const pinnedSessions = useMemo(
    () => getGlobalPinnedSessions(filtered, sessionMeta, projectMeta, showArchived)
      .sort(compareSessions),
    [filtered, sessionMeta, projectMeta, showArchived, compareSessions],
  );
  const pinnedSessionIds = useMemo(
    () => new Set(pinnedSessions.map((session) => session.id)),
    [pinnedSessions],
  );

  const projectEntries = useMemo(() => {
    const byPath = new Map<string, ProjectEntry>();
    const add = (rawPath: string, name?: string, branch?: string, open = false) => {
      const normalized = normalizeProjectPath(rawPath);
      if (!normalized) return;
      const existing = byPath.get(normalized);
      if (existing) {
        existing.open ||= open;
        if (name && existing.name === projectName(existing.path)) existing.name = name;
        if (branch && !existing.branch) existing.branch = branch;
        return;
      }
      const meta = projectMetaFor(rawPath, projectMeta);
      byPath.set(normalized, {
        path: rawPath,
        displayPath: openProjects.find((project) => normalizeProjectPath(project.path) === normalized)?.remote?.path
          ?? (normalizeProjectPath(workspace?.path) === normalized ? workspace?.remote?.path : undefined),
        key: normalized,
        name: projectName(rawPath, meta.name ?? name),
        sessions: [],
        open,
        active: normalized === activeProjectPath,
        meta,
        branch,
      });
    };
    for (const path of openProjectPaths) {
      const record = openProjects.find(
        (project) => normalizeProjectPath(project.path) === path,
      );
      add(path, record?.name, record?.branch, true);
    }
    if (workspace?.path) add(workspace.path, workspace.name, workspace.branch, true);
    for (const session of filtered) {
      const sessionPath = normalizeProjectPath(session.projectPath);
      if (!sessionPath) continue;
      // A closed project remains discoverable in Projects, but its historical
      // sessions must not recreate a sidebar tab that the user just closed.
      const entry = byPath.get(sessionPath);
      if (entry) entry.sessions.push(session);
    }
    const result = [...byPath.values()].filter(
      (entry) => showArchived || !entry.meta.archived,
    );
    for (const entry of result) entry.sessions.sort(compareSessions);
    result.sort((a, b) => {
      const archiveOrder = Number(!!a.meta.archived) - Number(!!b.meta.archived);
      if (archiveOrder !== 0) return archiveOrder;
      const pinOrder = Number(!!b.meta.pinned) - Number(!!a.meta.pinned);
      if (pinOrder !== 0) return pinOrder;
      if (displayProjectSort === "manual") {
        const byOrder =
          (a.meta.order ?? Number.MAX_SAFE_INTEGER) -
          (b.meta.order ?? Number.MAX_SAFE_INTEGER);
        if (byOrder !== 0) return byOrder;
      } else if (displayProjectSort === "name") {
        const byName = a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
        if (byName !== 0) return byName;
      } else if (
        displayProjectSort === "oldest" ||
        displayProjectSort === "created"
      ) {
        const dateForProject =
          displayProjectSort === "oldest" ? firstSessionDate : lastSessionDate;
        const aCreated = dateForProject(a.sessions, "createdAt");
        const bCreated = dateForProject(b.sessions, "createdAt");
        const byCreated = compareOptionalDate(
          aCreated,
          bCreated,
          displayProjectSort === "created",
        );
        if (byCreated !== 0) return byCreated;
      } else {
        const aRecent = lastSessionDate(a.sessions, "updatedAt");
        const bRecent = lastSessionDate(b.sessions, "updatedAt");
        const byRecent = compareOptionalDate(aRecent, bRecent, true);
        if (byRecent !== 0) return byRecent;
      }
      return a.key.localeCompare(b.key);
    });
    return result;
  }, [
    filtered,
    openProjectPaths,
    openProjects,
    workspace,
    activeProjectPath,
    projectMeta,
    showArchived,
    displayProjectSort,
    sessionMeta,
    compareSessions,
  ]);

  // Look up project entries by normalized path so session rows can fetch the
  // workspace name (and any other project metadata) for the hover card.
  const projectEntriesByPath = useMemo(() => {
    const map = new Map<string, ProjectEntry>();
    for (const entry of projectEntries) map.set(entry.key, entry);
    return map;
  }, [projectEntries]);

  projectEntriesRef.current = projectEntries;

  const finishProjectReorderPress = useCallback((opts?: { keepClickSuppressed?: boolean }) => {
    const state = projectReorderRef.current;
    if (state) {
      window.removeEventListener("pointermove", state.onMove, true);
      window.removeEventListener("pointerup", state.onUp, true);
      window.removeEventListener("pointercancel", state.onCancel, true);
      projectReorderRef.current = null;
    }
    if (!opts?.keepClickSuppressed) suppressProjectTitleClickRef.current = false;
    setDraggingProjectKey(null);
    setDropIndicator(null);
    document.documentElement.removeAttribute("data-project-reordering");
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (!projectReorderRef.current) return;
      event.preventDefault();
      finishProjectReorderPress();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      finishProjectReorderPress();
    };
  }, [finishProjectReorderPress]);

  const reorderProjectEntries = useCallback(
    (sourceKey: string, targetKey: string, insertAfter: boolean) => {
      if (!sourceKey || !targetKey || sourceKey === targetKey) return;
      const keys = projectEntries.map((entry) => entry.key);
      const sourceIndex = keys.indexOf(sourceKey);
      const targetIndex = keys.indexOf(targetKey);
      if (sourceIndex < 0 || targetIndex < 0) return;
      const source = projectEntries[sourceIndex];
      const target = projectEntries[targetIndex];
      if (!sameProjectReorderBucket(source.meta, target.meta)) {
        return;
      }
      keys.splice(sourceIndex, 1);
      const nextTargetIndex = keys.indexOf(targetKey) + (insertAfter ? 1 : 0);
      keys.splice(nextTargetIndex, 0, sourceKey);
      reorderProjects(keys);
    },
    [projectEntries, reorderProjects],
  );
  reorderProjectEntriesRef.current = reorderProjectEntries;

  const beginProjectReorderPress = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>, projectKey: string) => {
      if (event.button !== 0 || event.pointerType === "touch" || projectReorderRef.current) {
        return;
      }

      const onMove = (moveEvent: PointerEvent) => {
        const current = projectReorderRef.current;
        if (!current || current.pointerId !== moveEvent.pointerId) return;
        current.lastX = moveEvent.clientX;
        current.lastY = moveEvent.clientY;
        if (!current.armed) {
          if (
            !projectReorderShouldArm(
              moveEvent.clientX - current.startX,
              moveEvent.clientY - current.startY,
            )
          ) {
            return;
          }
          current.armed = true;
          suppressProjectTitleClickRef.current = true;
          document.documentElement.setAttribute("data-project-reordering", "true");
          setDraggingProjectKey(current.projectKey);
        }
        moveEvent.preventDefault();
        const target = projectGroupKeyFromPoint(moveEvent.clientX, moveEvent.clientY);
        const source = projectEntriesRef.current.find((entry) => entry.key === current.projectKey);
        const destination = target
          ? projectEntriesRef.current.find((entry) => entry.key === target.key)
          : undefined;
        if (
          target &&
          source &&
          destination &&
          target.key !== current.projectKey &&
          sameProjectReorderBucket(source.meta, destination.meta)
        ) {
          const insertAfter = projectReorderInsertAfter(
            moveEvent.clientY,
            target.top,
            target.height,
          );
          current.dropKey = target.key;
          current.dropTop = target.top;
          current.dropHeight = target.height;
          current.insertAfter = insertAfter;
          setDropIndicator({ key: target.key, insertAfter });
        } else {
          current.dropKey = null;
          setDropIndicator(null);
        }
      };

      const onUp = (upEvent: PointerEvent) => {
        const current = projectReorderRef.current;
        if (!current || current.pointerId !== upEvent.pointerId) return;
        if (current.armed) {
          upEvent.preventDefault();
          if (current.dropKey) {
            reorderProjectEntriesRef.current(
              current.projectKey,
              current.dropKey,
              current.insertAfter,
            );
          }
          finishProjectReorderPress({ keepClickSuppressed: true });
          return;
        }
        finishProjectReorderPress();
      };

      const onCancel = (cancelEvent: PointerEvent) => {
        const current = projectReorderRef.current;
        if (!current || current.pointerId !== cancelEvent.pointerId) return;
        finishProjectReorderPress();
      };

      const state: ProjectReorderPointerState = {
        pointerId: event.pointerId,
        projectKey,
        startX: event.clientX,
        startY: event.clientY,
        lastX: event.clientX,
        lastY: event.clientY,
        armed: false,
        dropKey: null,
        dropTop: 0,
        dropHeight: 0,
        insertAfter: false,
        onMove,
        onUp,
        onCancel,
      };
      projectReorderRef.current = state;
      window.addEventListener("pointermove", onMove, true);
      window.addEventListener("pointerup", onUp, true);
      window.addEventListener("pointercancel", onCancel, true);
    },
    [finishProjectReorderPress],
  );

  const moveProjectWithKeyboard = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>, projectKey: string) => {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      const index = projectEntries.findIndex((entry) => entry.key === projectKey);
      const target = projectEntries[index + (event.key === "ArrowUp" ? -1 : 1)];
      if (!target) return;
      event.preventDefault();
      event.stopPropagation();
      reorderProjectEntries(projectKey, target.key, event.key === "ArrowDown");
    },
    [projectEntries, reorderProjectEntries],
  );

  const showSessionHoverCard = useCallback((
    session: SessionSummary,
    target: HTMLElement,
    temporary: boolean,
  ) => {
    const projectPath = session.projectPath ?? "";
    const normalizedProjectPath = normalizeProjectPath(projectPath);
    const entry = projectEntriesByPath.get(normalizedProjectPath ?? "");
    revealSessionHoverCard({
      session: { ...session, title: taskTitle(session.title) },
      target,
      temporary,
      space: isRemoteSession(session)
        ? `${session.remoteWorkspaceLabel ?? t("remote:workspace")} · ${session.remoteHostLabel ?? t("remote:remote")}`
        : temporary ? t("nav.hoverCardTemporarySpace") : entry?.name ?? projectName(projectPath),
      branch: entry?.branch,
    });
  }, [projectEntriesByPath, revealSessionHoverCard, t, taskTitle]);

  const temporarySessions = useMemo(
    () => filtered
      .filter((session) => !normalizeProjectPath(session.projectPath) && !(isRemoteSession(session) && session.remoteProjectId))
      .sort(compareSessions),
    [filtered, compareSessions],
  );
  const temporarySessionHistory = useMemo(
    () => temporarySessions.filter((session) => !pinnedSessionIds.has(session.id)),
    [temporarySessions, pinnedSessionIds],
  );
  const remoteProjectGroups = useMemo(() => groupRemoteProjectSessions(
    filtered.filter((session) => isRemoteSession(session) && !pinnedSessionIds.has(session.id)), compareSessions,
  ), [filtered, pinnedSessionIds, compareSessions]);
  // Flat ordered list of every visible session id — used for Shift+click range selection.
  const flatSessionOrder = useMemo(() => {
    const ids: string[] = [];
    // Pinned first (same order as rendered)
    for (const s of pinnedSessions) ids.push(s.id);
    // Then project sessions
    for (const entry of projectEntries) {
      for (const s of entry.sessions) {
        if (!pinnedSessionIds.has(s.id)) ids.push(s.id);
      }
    }
    for (const group of remoteProjectGroups) for (const session of group.sessions) ids.push(session.id);
    // Then temporary (standalone) sessions
    for (const s of temporarySessionHistory) ids.push(s.id);
    return ids;
  }, [pinnedSessions, projectEntries, pinnedSessionIds, temporarySessionHistory, remoteProjectGroups]);

  /** Handle multi-select click on a session row. Returns true if the click was consumed by multi-select. */
  const handleMultiSelectClick = (event: React.MouseEvent, sessionId: string): boolean => {
    const isMeta = event.metaKey || event.ctrlKey;
    const isShift = event.shiftKey;
    if (!isMeta && !isShift) {
      // Plain click: clear selection, let normal handler run.
      if (selectedIds.size > 0) setSelectedIds(new Set());
      lastClickedIdRef.current = sessionId;
      return false;
    }
    event.preventDefault();
    event.stopPropagation();
    if (isMeta && !isShift) {
      // Toggle individual item
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (next.has(sessionId)) next.delete(sessionId);
        else next.add(sessionId);
        return next;
      });
      lastClickedIdRef.current = sessionId;
      return true;
    }
    if (isShift) {
      // Range select from lastClickedId to current
      const anchor = lastClickedIdRef.current;
      if (!anchor) {
        setSelectedIds(new Set([sessionId]));
        lastClickedIdRef.current = sessionId;
        return true;
      }
      const startIdx = flatSessionOrder.indexOf(anchor);
      const endIdx = flatSessionOrder.indexOf(sessionId);
      if (startIdx === -1 || endIdx === -1) {
        setSelectedIds(new Set([sessionId]));
        lastClickedIdRef.current = sessionId;
        return true;
      }
      const lo = Math.min(startIdx, endIdx);
      const hi = Math.max(startIdx, endIdx);
      const range = flatSessionOrder.slice(lo, hi + 1);
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const id of range) next.add(id);
        return next;
      });
      // Don't update lastClickedIdRef on shift-click so further shifts extend from same anchor
      return true;
    }
    return false;
  };

  // Clear multi-select when sessions list changes (e.g. after batch delete)
  const sessionIdSet = useMemo(() => new Set(sessions.map((s) => s.id)), [sessions]);
  useEffect(() => {
    if (selectedIds.size === 0) return;
    // Remove any selected ids that no longer exist
    let changed = false;
    const next = new Set<string>();
    for (const id of selectedIds) {
      if (sessionIdSet.has(id)) next.add(id);
      else changed = true;
    }
    if (changed) setSelectedIds(next);
  }, [sessionIdSet]); // intentionally not including selectedIds to avoid loop

  const renderSessionStatus = (status: SidebarSessionStatus) => {
    const labelKey =
      status === "running"
        ? "nav.sessionRunning"
        : status === "selected"
          ? "nav.sessionSelected"
          : status === "completed"
            ? "nav.sessionCompleted"
            : status === "failed"
              ? "nav.sessionFailed"
              : "nav.sessionPermission";
    const fallback =
      status === "running"
        ? "In progress"
        : status === "selected"
          ? "Selected"
          : status === "completed"
            ? "Completed"
            : status === "failed"
              ? "Failed"
              : "Permission required";
    const label = t(labelKey, { defaultValue: fallback });
    return (
      <span className={`thread-item-status ${status}`} aria-label={label} title={label}>
        {status === "completed" ? <IconCheck size={10} aria-hidden /> : null}
        {status === "failed" ? <IconCircleAlert size={11} aria-hidden /> : null}
      </span>
    );
  };

  const reportError = useCallback(
    (error: unknown) => {
      showToast(error instanceof Error ? error.message : String(error), {
        variant: "error",
      });
    },
    [showToast],
  );

  const focusComposer = useCallback(() => {
    requestAnimationFrame(() => {
      document.querySelector<HTMLTextAreaElement>(".composer-input")?.focus();
    });
  }, []);

  const selectProject = async (path: string): Promise<boolean> => {
    const normalized = normalizeProjectPath(path);
    if (!normalized) return false;
    if (normalized === activeProjectPath) return true;
    try {
      return Boolean(await activateProject(path));
    } catch (error) {
      reportError(error);
      return false;
    }
  };

  const selectProjectSession = async (session: SessionSummary): Promise<boolean> => {
    try {
      await selectSession(session.id);
      focusComposer();
      return true;
    } catch (error) {
      reportError(error);
      return false;
    }
  };

  const selectTemporarySession = async (sessionId: string) => {
    try {
      await selectSession(sessionId);
      focusComposer();
    } catch (error) {
      reportError(error);
    }
  };

  const scheduleSessionPrefetch = (sessionId: string) => {
    window.clearTimeout(sessionPrefetchTimerRef.current);
    sessionPrefetchTimerRef.current = window.setTimeout(() => {
      void prefetchSession(sessionId).catch(() => undefined);
    }, 120);
  };

  const cancelSessionPrefetch = () => {
    window.clearTimeout(sessionPrefetchTimerRef.current);
    sessionPrefetchTimerRef.current = undefined;
  };

  const openSessionFromHover = useCallback(async (sessionId: string) => {
    cancelSessionPrefetch();
    hideSessionHoverCard();
    try {
      // A dead reference must fail visibly instead of selecting an empty chat.
      // The store's session list is the cheapest complete existence signal; an
      // unknown id still gets one detail read so a stale list cannot block a
      // session that really exists.
      const known = useAppStore.getState().sessions.some((session) => session.id === sessionId);
      if (!known) {
        // Only presence is read from this reply, so ask for the smallest window
        // the host accepts. The uncapped read moved every message of the
        // session over IPC to answer one boolean.
        const detail = await api.getSession(sessionId, { messageLimit: 1 });
        if (!detail.session) {
          reportError(new Error(t("sessionCollaboration.sessionMissing")));
          return;
        }
      }
      await selectSession(sessionId);
      focusComposer();
    } catch (error) {
      reportError(error);
    }
  }, [focusComposer, hideSessionHoverCard, reportError, selectSession, t]);

  useEffect(() => cancelSessionPrefetch, []);

  const setCollapsed = (path: string, value: boolean) => {
    const normalized = normalizeProjectPath(path) || path;
    setProjectCollapsed(normalized, value);
    if (value) {
      setExpandedProjectSessions((previous) =>
        updateProjectSessionExpansion(previous, normalized, false),
      );
    }
  };

  const setSort = (next: SessionSort) => {
    setSessionSort(next);
    setProjectSort(next);
    closeMenus();
  };

  const toggleShowArchived = () => {
    const next = !showArchived;
    setSessionArchiveVisibility(next);
    closeMenus();
  };

  const expandProjectSessions = (projectKey: string) => {
    setExpandedProjectSessions((previous) =>
      updateProjectSessionExpansion(previous, projectKey, true),
    );
  };

  const toggleSessionPin = (session: SessionSummary) => {
    toggleSessionPinned(session.id);
    closeMenus(false);
    // Pinning moves a row between lists, replacing its previous DOM node.
    requestAnimationFrame(() => {
      const row = document.querySelector<HTMLElement>(
        `[data-sidebar-session-row="${CSS.escape(session.id)}"] [data-action="session-menu"]`,
      );
      const target = row && !row.closest('[aria-hidden="true"]')
        ? row
        : document.querySelector<HTMLElement>('[data-action="session-sort"]');
      target?.focus();
    });
  };

  const archiveSession = async (session: SessionSummary) => {
    const archived = sessionArchived(session, sessionMeta[session.id]);
    const wasActive = activeSessionId === session.id;
    const next =
      !archived && wasActive
        ? session.projectPath
          ? projectEntries
              .find((entry) => entry.key === normalizeProjectPath(session.projectPath))
              ?.sessions.find(
                (item) =>
                  item.id !== session.id &&
                  !sessionArchived(item, sessionMeta[item.id]),
              )
          : temporarySessions.find(
              (item) =>
                item.id !== session.id &&
                !sessionArchived(item, sessionMeta[item.id]),
            )
        : undefined;
    try {
      closeMenus();
      if (archived) {
        restoreSession(session.id);
        return;
      }
      if (wasActive && next) {
        if (!(await selectProjectSession(next))) return;
        archiveSessionAction(session.id);
        return;
      }
      if (wasActive) {
        // Archive first so an empty active slot is not reused as its own
        // replacement. Restore it if creating the fallback slot fails.
        archiveSessionAction(session.id);
        try {
          await newSession({ projectPath: session.projectPath ?? null });
        } catch (error) {
          restoreSession(session.id);
          throw error;
        }
        return;
      }
      archiveSessionAction(session.id);
    } catch (error) {
      reportError(error);
    }
  };

  const deleteSession = async (session: SessionSummary) => {
    closeMenus();
    const wasActive = activeSessionId === session.id;
    const sameScope = session.projectPath
      ? projectEntries.find(
          (entry) => entry.key === normalizeProjectPath(session.projectPath),
        )?.sessions ?? []
      : temporarySessions;
    const next = wasActive
      ? sameScope.find(
          (item) =>
            item.id !== session.id &&
            !sessionArchived(item, sessionMeta[item.id]),
        ) ?? projectEntries
          .flatMap((entry) => entry.sessions)
          .find(
            (item) =>
              item.id !== session.id &&
              !sessionArchived(item, sessionMeta[item.id]),
          )
      : undefined;
    try {
      await deleteSessionAction(session.id);
      if (wasActive) {
        if (next) await selectProjectSession(next);
        else await newSession({ projectPath: session.projectPath ?? null });
      }
    } catch (error) {
      reportError(error);
    }
  };

  /**
   * Two-step delete for one row's menu item. The first click arms the item and
   * relabels it; only the second click runs the delete, and the arm expires on
   * its own. The menu stays open between the two clicks.
   */
  const requestDeleteSession = (session: SessionSummary) => {
    if (armedDelete !== session.id) {
      setArmedDelete(session.id);
      return;
    }
    setArmedDelete(null);
    void deleteSession(session);
  };

  /** Batch delete: delete all selected sessions sequentially. */
  const batchDeleteSessions = async () => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    closeMenus();
    const toDelete = sessions.filter(
      (s) => ids.includes(s.id) && s.source !== "pi-native",
    );
    for (const session of toDelete) {
      try {
        await deleteSessionAction(session.id);
      } catch (error) {
        reportError(error);
      }
    }
    // If we deleted the active session, create or select a fallback
    if (ids.includes(activeSessionId ?? "")) {
      const remaining = sessions.find(
        (s) => !ids.includes(s.id) && !sessionArchived(s, sessionMeta[s.id]),
      );
      try {
        if (remaining) await selectSession(remaining.id);
        else await newSession({ projectPath: null });
      } catch (error) {
        reportError(error);
      }
    }
    setSelectedIds(new Set());
  };

  /** Batch archive: archive all selected sessions. */
  const batchArchiveSessions = async () => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    closeMenus();
    for (const id of ids) {
      const session = sessions.find((s) => s.id === id);
      if (!session) continue;
      const alreadyArchived = sessionArchived(session, sessionMeta[session.id]);
      if (alreadyArchived) continue;
      archiveSessionAction(id);
    }
    // If we archived the active session (and it wasn't already archived), select a fallback
    const activeWasArchived = (() => {
      if (!activeSessionId || !ids.includes(activeSessionId)) return false;
      const s = sessions.find((s) => s.id === activeSessionId);
      return s ? !sessionArchived(s, sessionMeta[s.id]) : false;
    })();
    if (activeWasArchived) {
      const remaining = sessions.find(
        (s) => !ids.includes(s.id) && !sessionArchived(s, sessionMeta[s.id]),
      );
      try {
        if (remaining) await selectSession(remaining.id);
        else await newSession({ projectPath: null });
      } catch (error) {
        reportError(error);
      }
    }
    setSelectedIds(new Set());
  };

  /** Always route project deletion through the explicit confirmation dialog. */
  const requestDeleteProject = (entry: ProjectEntry) => {
    closeMenus(false);
    setDeleteProjectFor(entry);
  };

  const openProjectFolder = async (entry: ProjectEntry) => {
    closeMenus(false);
    try {
      await api.openProjectFolder(entry.path);
    } catch (error) {
      reportError(error);
    }
  };

  const editProjectEntry = (entry: ProjectEntry, name: string) => {
    renameProject(entry.path, name);
  };

  const forkSession = async (session: SessionSummary) => {
    if (!sessionAllows(session, "canEditMessages")) return;
    closeMenus(false);
    try {
      await forkSessionAction(session.id);
      focusComposer();
    } catch (error) {
      reportError(error);
    }
  };

  const copyConversationId = async (session: SessionSummary) => {
    try {
      await navigator.clipboard.writeText(session.id);
      showToast(t("chat.copied"));
    } catch (error) {
      reportError(error);
    }
    closeMenus();
  };

  /**
   * The link another conversation references: pasting it into a Composer draft
   * carries a bounded excerpt of this conversation into that turn (issue #1324).
   */
  const copySessionLink = async (session: SessionSummary) => {
    try {
      await navigator.clipboard.writeText(formatSessionLink(session.id));
      showToast(t("chat.copied"));
    } catch (error) {
      reportError(error);
    }
    closeMenus();
  };

  const copyTextToClipboard = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      showToast(t("chat.copied"));
    } catch (error) {
      reportError(error);
    }
    closeMenus();
  };

  const copySessionPath = async (session: SessionSummary) => {
    if (isRemoteSession(session)) return;
    try {
      const { path } = await api.getSessionScratchPath(session.id);
      await copyTextToClipboard(path);
    } catch (error) {
      reportError(error);
      closeMenus();
    }
  };

  const openSessionPath = async (session: SessionSummary) => {
    if (isRemoteSession(session)) return;
    closeMenus(false);
    try {
      await api.openSessionScratchPath(session.id);
    } catch (error) {
      reportError(error);
    }
  };

  const toggleProjectPin = (entry: ProjectEntry) => {
    toggleProjectPinned(entry.path);
    closeMenus();
  };

  const archiveProject = async (entry: ProjectEntry) => {
    const archived = Boolean(entry.meta.archived);
    const wasActive = entry.active;
    const next = !archived
      ? projectEntries.find(
          (candidate) =>
            candidate.key !== entry.key && !candidate.meta.archived,
        )
      : undefined;
    try {
      closeMenus();
      if (archived) {
        restoreProject(entry.path);
        return;
      }
      // Move the visible context before hiding the active project. This
      // prevents an archived, invisible project from remaining active.
      if (wasActive) {
        if (next) {
          if (!(await selectProject(next.path))) return;
        } else {
          await clearProject();
        }
      }
      archiveProjectAction(entry.path);
    } catch (error) {
      reportError(error);
    }
  };

  const createSession = async (options?: { projectPath?: string | null }) => {
    try {
      await newSession(options);
      focusComposer();
    } catch (error) {
      reportError(error);
    }
  };

  const createProjectSession = async (path: string) => {
    await createSession({ projectPath: path });
  };

  const openProjectPicker = async () => {
    try {
      await openProject();
    } catch (error) {
      reportError(error);
    }
  };

  const moveSessionToProject = useCallback(
    async (sessionId: string, projectPath: string, projectName: string) => {
      if (sessionId.startsWith("remote:")) return;
      // A running turn owns the current project's instructions, tools, and
      // working directory; the host rejects the move as well.
      if (runningSessions[sessionId]) {
        showToast(
          t("nav.moveRunningSessionBlocked", {
            defaultValue: "Stop the running session before moving it.",
          }),
          { variant: "warning" },
        );
        return;
      }
      try {
        const moved = await moveSessionProject(sessionId, projectPath);
        if (!moved) {
          showToast(
            t("nav.moveSessionUnavailable", {
              defaultValue: "This session cannot move to that project.",
            }),
            { variant: "warning" },
          );
          return;
        }
        showToast(
          t("nav.sessionMoved", {
            name: projectName,
            defaultValue: "Moved to " + projectName,
          }),
          { variant: "success" },
        );
      } catch (error) {
        reportError(error);
      }
    },
    [moveSessionProject, reportError, runningSessions, showToast, t],
  );

  /**
   * The row menu acts on the selection while a multi-selection is open, so the
   * panel's items come from the selection rather than from the clicked row.
   */
  const batchSelected = Boolean(
    sessionMenu && selectedIds.size > 1 && selectedIds.has(sessionMenu),
  );

  /**
   * Repository rows of the open menu. Both builders run every render, but they
   * key their probes and reads to the open target, so a closed menu reads
   * nothing; `onDone` is the sidebar's own close path.
   */
  const menuSession = sessionMenu
    ? sessions.find((item) => item.id === sessionMenu)
    : undefined;
  const sessionWorktreeItems = useWorktreeSessionMenuItems({
    sessionId: menuSession?.id ?? "",
    title: taskTitle(menuSession?.title),
    worktree: menuSession?.worktree,
    running: Boolean(menuSession && runningSessions[menuSession.id]),
    onDone: () => closeMenus(false),
  });
  const sessionDeleteLoss = useWorktreeDeleteLossText(
    menuSession && armedDelete === menuSession.id ? menuSession.id : "",
  );
  const menuProject = projectMenu
    ? projectEntries.find((item) => item.key === projectMenu)
    : undefined;
  const projectIsolationItems = useWorktreeProjectMenuItems({
    projectPath: menuProject?.path ?? "",
    projectName: menuProject?.name ?? "",
    onDone: () => closeMenus(false),
  });


  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    sidebarMenuKeyDown(event, closeMenus);
  };

  const menuSortLabel = (value: Exclude<SessionSort, "manual"> | "created") =>
    value === "recent"
      ? t("nav.sortRecent", { defaultValue: "Recently updated" })
      : value === "oldest"
        ? t("nav.sortOldest", { defaultValue: "Oldest first" })
        : value === "name"
          ? t("nav.sortName", { defaultValue: "Name" })
          : t("nav.sortCreated", { defaultValue: "Created date" });



  const sessionMenuContent = useCallback(
    (session: SessionSummary): SidebarMenuPanelContent => {
      const meta = sessionMeta[session.id] ?? {};
      const archived = sessionArchived(session, meta);
      const pinned = sessionPinned(session, meta);
      const native = session.source === "pi-native";
      const gitItems = [
        ...(native || !sessionAllows(session, "canEditMessages")
          ? []
          : [
              sidebarMenuAction({
                id: "fork-session",
                label: t("nav.createBranch"),
                icon: <IconBranch size={14} />,
                title: t("nav.createBranch"),
                disabled: Boolean(runningSessions[session.id]),
                onSelect: () => void forkSession(session),
              }),
            ]),
        ...sessionWorktreeItems,
      ];
      return {
        label: t("nav.sessionActions", { defaultValue: "Session actions" }),
        items: [
          ...(native
            ? []
            : [
                sidebarMenuAction({
                  id: "rename-session",
                  label: t("nav.renameTask", { defaultValue: "Rename task" }),
                  icon: <IconPencil size={14} />,
                  onSelect: () => {
                    closeMenus(false);
                    setRenameFor(session);
                  },
                }),
              ]),
          sidebarMenuAction({
            id: "toggle-session-pin",
            label: pinned
              ? t("nav.unpinTask", { defaultValue: "Unpin" })
              : t("nav.pinTask", { defaultValue: "Pin" }),
            icon: <IconPin size={14} />,
            onSelect: () => toggleSessionPin(session),
          }),
          sidebarMenuAction({
            id: "toggle-session-archive",
            label: archived
              ? t("nav.restoreTask", { defaultValue: "Restore" })
              : t("nav.archiveTask", { defaultValue: "Archive" }),
            icon: archived ? <IconArchiveRestore size={14} /> : <IconArchive size={14} />,
            onSelect: () => void archiveSession(session),
          }),
          ...(gitItems.length
            ? [
                sidebarMenuSubmenu({
                  id: "session-git",
                  label: t("worktree.menu.group", { defaultValue: "Git" }),
                  icon: <IconBranch size={14} />,
                  items: gitItems,
                }),
              ]
            : []),
          sidebarMenuSubmenu({
            id: "session-copy",
            label: t("chat.copy", { defaultValue: "Copy" }),
            icon: <IconCopy size={14} />,
            items: [
              sidebarMenuAction({
                id: "copy-conversation-id",
                label: t("nav.copyConversationId"),
                icon: <IconCopy size={14} />,
                onSelect: () => void copyConversationId(session),
              }),
              ...(!isRemoteSession(session)
                ? [
                    sidebarMenuAction({
                      id: "copy-session-path",
                      label: t("nav.copySessionPath"),
                      icon: <IconFolder size={14} />,
                      onSelect: () => void copySessionPath(session),
                    }),
                  ]
                : []),
              sidebarMenuAction({
                id: "copy-session-link",
                label: t("nav.copySessionLink"),
                icon: <IconCopy size={14} />,
                onSelect: () => void copySessionLink(session),
              }),
            ],
          }),
          ...(settings?.developerMode === true && !isRemoteSession(session)
            ? [
                sidebarMenuAction({
                  id: "open-session-path",
                  label: t("nav.openSessionPath"),
                  icon: <IconFolder size={14} />,
                  onSelect: () => void openSessionPath(session),
                }),
              ]
            : []),
          ...(native
            ? []
            : [
                sidebarMenuSubmenu({
                  id: "session-danger",
                  label: t("nav.dangerZone", { defaultValue: "Danger zone" }),
                  icon: <IconTrash size={14} />,
                  items: [
                    sidebarMenuAction({
                      id: "delete-session",
                      label: armedDelete === session.id
                        ? t("nav.deleteTaskConfirm", { defaultValue: "Delete?" })
                        : t("nav.deleteTask", { defaultValue: "Delete" }),
                      icon: <IconX size={14} />,
                      danger: true,
                      armed: armedDelete === session.id,
                      onSelect: () => requestDeleteSession(session),
                    }),
                  ],
                  notes: sessionDeleteLoss
                    ? [{ id: "session-delete-loss", text: sessionDeleteLoss }]
                    : undefined,
                }),
              ]),
        ],
      };
    },
    [
      armedDelete,
      archiveSession,
      copyConversationId,
      copySessionPath,
      copySessionLink,
      forkSession,
      openSessionPath,
      requestDeleteSession,
      runningSessions,
      sessionDeleteLoss,
      sessionMeta,
      sessionWorktreeItems,
      settings?.developerMode,
      t,
      toggleSessionPin,
    ],
  );

  const projectMenuContent = useCallback(
    (entry: ProjectEntry): SidebarMenuPanelContent => {
      const archived = Boolean(entry.meta.archived);
      return {
        label: t("project.openActions", { name: entry.name }),
        items: [
          sidebarMenuAction({
            id: "open-project-folder",
            label: t("project.openFolder", { defaultValue: "Open folder" }),
            icon: <IconFolder size={14} />,
            onSelect: () => void openProjectFolder(entry),
          }),
          sidebarMenuAction({
            id: "edit-project",
            label: t("project.edit", { defaultValue: "Edit project" }),
            icon: <IconPencil size={14} />,
            onSelect: () => {
              closeMenus(false);
              setEditProjectFor(entry);
            },
          }),
          sidebarMenuAction({
            id: "toggle-project-pin",
            label: entry.meta.pinned ? t("project.unpin") : t("project.pin"),
            icon: <IconPin size={14} />,
            onSelect: () => toggleProjectPin(entry),
          }),
          sidebarMenuAction({
            id: "toggle-project-archive",
            label: archived
              ? t("project.restore", { defaultValue: "Restore project" })
              : t("project.archive", { defaultValue: "Archive project" }),
            icon: archived ? <IconArchiveRestore size={14} /> : <IconArchive size={14} />,
            onSelect: () => void archiveProject(entry),
          }),
          sidebarMenuSubmenu({
            id: "project-copy",
            label: t("chat.copy", { defaultValue: "Copy" }),
            icon: <IconCopy size={14} />,
            items: [
              sidebarMenuAction({
                id: "copy-project-name",
                label: t("project.copyName"),
                icon: <IconCopy size={14} />,
                onSelect: () => void copyTextToClipboard(entry.name),
              }),
              sidebarMenuAction({
                id: "copy-project-path",
                label: t("project.copyPath"),
                icon: <IconFolder size={14} />,
                onSelect: () => void copyTextToClipboard(entry.displayPath ?? entry.path),
              }),
            ],
          }),
          sidebarMenuSubmenu({
            id: "project-git",
            label: t("worktree.menu.group", { defaultValue: "Git" }),
            icon: <IconBranch size={14} />,
            items: projectIsolationItems,
          }),
          sidebarMenuSubmenu({
            id: "project-danger",
            label: t("nav.dangerZone", { defaultValue: "Danger zone" }),
            icon: <IconTrash size={14} />,
            items: [
              sidebarMenuAction({
                id: "delete-project",
                label: t("project.delete", { defaultValue: "Delete project" }),
                icon: <IconTrash size={14} />,
                danger: true,
                onSelect: () => requestDeleteProject(entry),
              }),
            ],
          }),
        ],
      };
    },
    [
      archiveProject,
      openProjectFolder,
      projectIsolationItems,
      copyTextToClipboard,
      requestDeleteProject,
      t,
      toggleProjectPin,
    ],
  );

  const batchMenuContent = useCallback(
    (count: number): SidebarMenuPanelContent => ({
      label: t("nav.sessionActions", { defaultValue: "Session actions" }),
      hint: t("nav.batchSelectionHint", {
        defaultValue: "{{count}} sessions selected",
        count,
      }),
      items: [
        sidebarMenuAction({
          id: "batch-archive",
          label: t("nav.batchArchive", { defaultValue: "Archive {{count}} sessions", count }),
          icon: <IconArchive size={14} />,
          onSelect: () => void batchArchiveSessions(),
        }),
        sidebarMenuSubmenu({
          id: "batch-danger",
          label: t("nav.dangerZone", { defaultValue: "Danger zone" }),
          icon: <IconTrash size={14} />,
          items: [
            sidebarMenuAction({
              id: "batch-delete",
              label: armedDelete === "batch"
                ? t("nav.batchDeleteConfirm", { defaultValue: "Delete {{count}} sessions?", count })
                : t("nav.batchDelete", { defaultValue: "Delete {{count}} sessions", count }),
              icon: <IconTrash size={14} />,
              danger: true,
              armed: armedDelete === "batch",
              onSelect: () => {
                if (armedDelete !== "batch") {
                  setArmedDelete("batch");
                  return;
                }
                setArmedDelete(null);
                void batchDeleteSessions();
              },
            }),
          ],
        }),
      ],
    }),
    [armedDelete, batchArchiveSessions, batchDeleteSessions, t],
  );

  const sortMenuContent = useMemo(
    (): SidebarMenuPanelContent => ({
      label: t("nav.sortSessions", { defaultValue: "Sort sessions" }),
      items: [
        sidebarMenuGroup({
          id: "sort",
          label: t("nav.sortSessions", { defaultValue: "Sort sessions" }),
          options: (["recent", "oldest", "name", "created"] as const).map((value) => ({
            id: `sort-${value}`,
            label: menuSortLabel(value),
            selected: displaySessionSort === value,
            onSelect: () => setSort(value),
          })),
        }),
        sidebarMenuSection({
          id: "view",
          label: t("nav.viewOptions", { defaultValue: "View" }),
        }),
        sidebarMenuCheck({
          id: "toggle-show-archived",
          label: t("nav.showArchived", { defaultValue: "Show archived" }),
          checked: showArchived,
          onSelect: toggleShowArchived,
        }),
      ],
    }),
    [displaySessionSort, menuSortLabel, setSort, showArchived, t, toggleShowArchived],
  );

  const beginSessionDrag = useCallback(
    (event: ReactDragEvent<HTMLDivElement>, sessionId: string) => {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData(SESSION_DRAG_MIME, sessionId);
      event.dataTransfer.setData("text/plain", sessionId);
      setDraggingSessionId(sessionId);
    },
    [],
  );

  const endSessionDrag = useCallback(() => {
    setDraggingSessionId(null);
    setDropProjectKey(null);
  }, []);

  // A dragged row can unmount before its own `dragend` fires (sort refresh,
  // archive, delete), which would otherwise leave the drag session and the
  // group highlight active for the next, unrelated drag.
  useEffect(() => {
    if (!draggingSessionId) return;
    const clearDragState = () => {
      setDraggingSessionId(null);
      setDropProjectKey(null);
    };
    window.addEventListener("dragend", clearDragState);
    window.addEventListener("drop", clearDragState, true);
    return () => {
      window.removeEventListener("dragend", clearDragState);
      window.removeEventListener("drop", clearDragState, true);
    };
  }, [draggingSessionId]);

  const sessionIdFromDrag = (dataTransfer: DataTransfer): string | null => {
    try {
      return dataTransfer.getData(SESSION_DRAG_MIME) || null;
    } catch {
      return null;
    }
  };

  const sessionIdForDragOver = (
    dataTransfer: DataTransfer,
    localSessionId: string | null,
  ): string | null => {
    if (!Array.from(dataTransfer.types).includes(SESSION_DRAG_MIME)) return null;
    return sessionIdFromDrag(dataTransfer) ?? localSessionId;
  };

  // A project group accepts a session row from another group. The current
  // group is not a drop target so a drag within one project is a no-op.
  const onProjectDropTargetOver = (
    event: ReactDragEvent<HTMLElement>,
    entry: ProjectEntry,
  ) => {
    const sessionId = sessionIdForDragOver(event.dataTransfer, draggingSessionId);
    if (!sessionId) return;
    const dragged = sessions.find((item) => item.id === sessionId);
    if (!dragged || normalizeProjectPath(dragged.projectPath) === entry.key) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDropProjectKey(entry.key);
  };

  const onProjectDropTargetLeave = (entry: ProjectEntry) => {
    setDropProjectKey((current) => (current === entry.key ? null : current));
  };

  const onProjectDropTargetDrop = (
    event: ReactDragEvent<HTMLElement>,
    entry: ProjectEntry,
  ) => {
    // The transfer payload is authoritative: a stale dragging id must never
    // move a session the user did not drag.
    const sessionId = sessionIdFromDrag(event.dataTransfer);
    setDraggingSessionId(null);
    setDropProjectKey(null);
    const dragged = sessionId
      ? sessions.find((item) => item.id === sessionId)
      : undefined;
    // Without a session payload this is a native folder drop for the projects
    // list, which the container handles.
    if (!dragged) return;
    event.preventDefault();
    event.stopPropagation();
    void moveSessionToProject(dragged.id, entry.path, entry.name);
  };

  // Native folder drops on the projects list add or switch to that project.
  const onProjectsAreaDragOver = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!hasComposerFileDrag(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setProjectsDropActive(true);
  };

  const onProjectsAreaDragLeave = (event: ReactDragEvent<HTMLDivElement>) => {
    const related = event.relatedTarget;
    if (related instanceof Node && event.currentTarget.contains(related)) return;
    setProjectsDropActive(false);
  };

  const onProjectsAreaDrop = async (event: ReactDragEvent<HTMLDivElement>) => {
    if (!hasComposerFileDrag(event.dataTransfer)) return;
    event.preventDefault();
    setProjectsDropActive(false);
    const directories = composerDropItems(event.dataTransfer, api.getDroppedFilePath)
      .filter((item) => item.isDirectory && item.path);
    if (!directories.length) {
      showToast(
        t("nav.dropFolderToAddProject", {
          defaultValue: "Drop a folder to add it as a project.",
        }),
        { variant: "warning" },
      );
      return;
    }
    for (const directory of directories) {
      try {
        await activateProject(directory.path!);
      } catch (error) {
        reportError(error);
      }
    }
  };

  const renderSessionRows = (
    items: SessionSummary[],
    options?: {
      temporary?: boolean;
      projectPath?: string;
      global?: boolean;
      showLastReplyDate?: boolean;
    },
  ) => items.map((session) => {
    const meta = sessionMeta[session.id] ?? {};
    const normalizedProjectPath = normalizeProjectPath(session.projectPath);
    const temporary = options?.temporary ?? !normalizedProjectPath;
    const owningProject = options?.global && normalizedProjectPath
      ? projectEntriesByPath.get(normalizedProjectPath)?.name
        ?? projectName(normalizedProjectPath, projectMetaFor(normalizedProjectPath, projectMeta).name)
      : t("nav.hoverCardTemporarySpace");
    const active = page === "chat" && selectedSessionId === session.id;
    const archived = sessionArchived(session, meta);
    const running = Boolean(runningSessions[session.id]);
    const hasPendingPermission = (pendingPermissions[session.id]?.length ?? 0) > 0;
    const status = sidebarSessionStatus({
      running,
      selected: active,
      outcome: sessionOutcomes[session.id],
      hasPendingPermission,
    });
    const lastReplyDate = options?.showLastReplyDate
      ? formatSessionLastReplyDate(
          session.updatedAt,
          new Date(),
          i18n.resolvedLanguage ?? i18n.language,
        )
      : "";
    return (
      <div
        key={session.id}
        className={`thread-item ${active ? "active" : ""} ${archived ? "archived" : ""} ${draggingSessionId === session.id ? "is-dragging" : ""} ${selectedIds.has(session.id) ? "selected" : ""}`}
        data-sidebar-session-row={session.id}
        draggable={!running && !isRemoteSession(session)}
        onDragStart={(event) => {
          if (running || isRemoteSession(session)) {
            event.preventDefault();
            return;
          }
          beginSessionDrag(event, session.id);
        }}
        onDragEnd={endSessionDrag}
        onClick={(event) => {
          const target = event.target as HTMLElement | null;
          if (target?.closest("button, [data-action]")) return;
          if (handleMultiSelectClick(event, session.id)) return;
          cancelSessionPrefetch();
          hideSessionHoverCard();
          void (temporary
            ? selectTemporarySession(session.id)
            : selectProjectSession(session));
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          // If right-clicking a non-selected row while multi-select is active,
          // add it to the selection instead of replacing.
          if (selectedIds.size > 0 && !selectedIds.has(session.id)) {
            setSelectedIds((prev) => new Set([...prev, session.id]));
          }
          placeMenuAtPoint(event.clientX, event.clientY);
          openSessionRowMenu(
            session.id,
            event.currentTarget.querySelector<HTMLButtonElement>(
              '[data-action="session-menu"]',
            ),
          );
        }}
      >
        {status ? renderSessionStatus(status) : null}
        <button
          type="button"
          className="thread-item-main"
          onPointerEnter={() => scheduleSessionPrefetch(session.id)}
          onPointerLeave={cancelSessionPrefetch}
          onFocus={() => void prefetchSession(session.id).catch(() => undefined)}
          onMouseEnter={(event) =>
            showSessionHoverCard(session, event.currentTarget, temporary)
          }
          onMouseLeave={scheduleSessionHoverCardHide}
          onFocusCapture={(event) =>
            showSessionHoverCard(session, event.currentTarget, temporary)
          }
          onBlur={scheduleSessionHoverCardHide}
          onClick={(event) => {
            if (handleMultiSelectClick(event, session.id)) return;
            cancelSessionPrefetch();
            hideSessionHoverCard();
            void (temporary
              ? selectTemporarySession(session.id)
              : selectProjectSession(session));
          }}
          aria-current={active ? "page" : undefined}
          aria-describedby={sessionHoverCard?.session.id === session.id ? `session-hover-${session.id}` : undefined}
        >
          {sessionPinned(session, meta) ? (
            <IconPin size={11} className="thread-item-pin" aria-hidden />
          ) : null}
          {session.source === "pi-native" ? (
            <span className="thread-item-source" title="Native Pi session">Pi</span>
          ) : null}
          {isRemoteSession(session) && <span className="thread-item-source" title={session.remoteHostLabel}>{t("remote:remote")}</span>}
          <WorktreeBadge worktree={session.worktree} sessionId={session.id} />
          <span className="thread-item-title">{taskTitle(session.title)}</span>
          {options?.global ? (
            <span className="thread-item-project">
              {owningProject}
            </span>
          ) : null}
        </button>
        <div
          className={cx(
            "thread-item-meta",
            sessionMenu === session.id && "is-menu-open",
          )}
        >
          {lastReplyDate ? (
            <span className="thread-item-last-reply">{lastReplyDate}</span>
          ) : null}
          <TooltipButton
            type="button"
            className="thread-item-more"
            data-action="session-menu"
            tooltip={t("nav.sessionActions", { defaultValue: "Session actions" })}
            ariaLabel={t("nav.sessionActions", { defaultValue: "Session actions" })}
            aria-haspopup="menu"
            aria-expanded={sessionMenu === session.id}
            onClick={(event) => {
              event.stopPropagation();
              if (sessionMenu === session.id) {
                closeMenus();
                return;
              }
              placeMenu(event);
              openSessionRowMenu(session.id, event.currentTarget);
            }}
          >
            <IconMore size={14} />
          </TooltipButton>
        </div>
      </div>
    );
  });

  const renderProjectGroup = (entry: ProjectEntry) => {
    const collapsedProject = entry.meta.collapsed ?? projectCollapsed[entry.key] ?? false;
    const projectId = projectDomId(entry.key);
    const isMenuOpen = projectMenu === entry.key;

    // Show the initial page by default; the remaining sessions stay folded
    // behind the Load more affordance.
    const sessionsExpanded = expandedProjectSessions[entry.key] ?? false;
    const history = entry.sessions.filter((session) => !pinnedSessionIds.has(session.id));
    const { visibleSessions, hiddenCount } = getVisibleProjectSessions(
      history,
      sessionsExpanded,
    );

    // The live counts cover every session in the group, including pinned and
    // folded ones, because the header answers for the whole project.
    const runSummary = summarizeProjectRuns(
      entry.sessions,
      runningSessions,
      pendingPermissions,
    );
    const runIsLive = projectRunSummaryIsLive(runSummary);
    const showRunBadge = runningAffordances.badge && runIsLive;
    const showRunRail = runningAffordances.rail && runIsLive;

    const renderProjectSessions = (sessions: SessionSummary[]) => {
      const result: React.ReactNode[] = [
        ...renderSessionRows(sessions, {
          projectPath: entry.path,
      showLastReplyDate: settings?.sidebarSessionTime === true,
        }),
      ];
      // Add "load more" button if there are hidden sessions
      if (hiddenCount > 0) {
        result.push(
          <button
            key="load-more"
            type="button"
            className="sidebar-load-more"
            onClick={() => expandProjectSessions(entry.key)}
          >
            {t("nav.loadMoreCount", { count: hiddenCount })}
          </button>
        );
      }
      return result;
    };

    return (
      <section
        key={entry.key}
        className={`sidebar-session-group project-group ${entry.meta.archived ? "archived" : ""} ${runIsLive ? "has-running-sessions" : ""} ${showRunRail ? "has-run-rail" : ""} ${collapsedProject ? "is-collapsed" : ""} ${dropProjectKey === entry.key ? "is-drop-target" : ""} ${draggingProjectKey === entry.key ? "is-dragging" : ""} ${dropIndicator?.key === entry.key ? (dropIndicator.insertAfter ? "is-drop-after" : "is-drop-before") : ""}`}
        aria-labelledby={projectId}
        data-sidebar-project-group={entry.key}
        data-current-workspace={entry.active ? "true" : undefined}
        onDragOver={(event) => {
          onProjectDropTargetOver(event, entry);
        }}
        onDragLeave={(event) => {
          const relatedTarget = event.relatedTarget;
          if (relatedTarget instanceof Node && event.currentTarget.contains(relatedTarget)) {
            return;
          }
          onProjectDropTargetLeave(entry);
        }}
        onDrop={(event) => {
          onProjectDropTargetDrop(event, entry);
        }}
      >
        {showRunRail ? <ProjectRunRail summary={runSummary} /> : null}
        <div
          className="sidebar-session-group-header"
          onClick={(event) => {
            // Same one-target rule as a session row: the header's own controls
            // stay the only spelled-out targets, so the gutter next to a hidden
            // control still activates and toggles the group.
            const target = event.target as HTMLElement | null;
            if (target?.closest("button, [data-action]")) return;
            void (async () => {
              if (!entry.active && !(await selectProject(entry.path))) return;
              setCollapsed(entry.path, !collapsedProject);
            })();
          }}
          onContextMenu={(event) => {
            if (projectReorderRef.current) {
              event.preventDefault();
              event.stopPropagation();
              return;
            }
            event.preventDefault();
            event.stopPropagation();
            placeMenuAtPoint(event.clientX, event.clientY);
            openProjectRowMenu(
              entry.key,
              event.currentTarget.querySelector<HTMLButtonElement>(
                ".project-more",
              ),
            );
          }}
        >
          <TooltipButton
            type="button"
            id={projectId}
            className="sidebar-session-group-title project-toggle"
            tooltip={entry.displayPath ?? entry.path}
            tooltipDelayMs={500}
            tooltipClassName="ui-tooltip-path"
            ariaLabel={entry.name}
            aria-describedby={`${projectId}-path-description`}
            aria-expanded={!collapsedProject}
            aria-controls={`${projectId}-sessions`}
            aria-keyshortcuts="ArrowUp ArrowDown"
            aria-grabbed={draggingProjectKey === entry.key}
            data-action="toggle-project-collapse"
            onDragStart={(event) => event.preventDefault()}
            onPointerDown={(event) => beginProjectReorderPress(event, entry.key)}
            onKeyDown={(event) => moveProjectWithKeyboard(event, entry.key)}
            onClick={() => {
              if (suppressProjectTitleClickRef.current) {
                suppressProjectTitleClickRef.current = false;
                return;
              }
              void (async () => {
                if (!entry.active && !(await selectProject(entry.path))) return;
                setCollapsed(entry.path, !collapsedProject);
              })();
            }}
          >
            <IconChevronDown
              size={13}
              className={`sidebar-disclosure-icon ${collapsedProject ? "collapsed" : ""}`}
            />
            {entry.meta.pinned ? (
              <IconStar
                size={13}
                fill="currentColor"
                className="sidebar-project-pin"
                aria-hidden
              />
            ) : (
              <IconFolder size={13} aria-hidden />
            )}
            <span>{entry.name}</span>
            {showRunBadge ? <ProjectRunBadge summary={runSummary} /> : null}
            {showRunRail ? <ProjectRunCount summary={runSummary} /> : null}
            {entry.active ? <span className="sidebar-project-active-dot" aria-label={t("project.active", { defaultValue: "Active" })} /> : null}
          </TooltipButton>
          <span id={`${projectId}-path-description`} className="sr-only">
            {entry.displayPath ?? entry.path}
            {". "}
            {t("project.reorder", { name: entry.name, defaultValue: "Reorder {{name}}" })}
          </span>
          <div className="sidebar-menu-wrap">
            <TooltipButton
              type="button"
              className="thread-item-more project-more"
              tooltip={t("project.openActions", { name: entry.name })}
              ariaLabel={t("project.openActions", { name: entry.name })}
              aria-haspopup="menu"
              aria-expanded={isMenuOpen}
              onClick={(event) => {
                event.stopPropagation();
                if (isMenuOpen) {
                  closeMenus();
                  return;
                }
                placeMenu(event);
                openProjectRowMenu(entry.key, event.currentTarget);
              }}
            >
              <IconMore size={14} />
            </TooltipButton>
          </div>
          <TooltipButton
            type="button"
            className="sidebar-session-group-add"
            tooltip={entry.active ? t("project.newTask") : t("project.openAndNewTask", { defaultValue: "Open project and create task" })}
            ariaLabel={entry.active ? t("project.newTask") : t("project.openAndNewTask", { defaultValue: "Open project and create task" })}
            onClick={() => void createProjectSession(entry.path)}
          >
            <IconNewSession size={13} />
          </TooltipButton>
        </div>
        <div
          id={`${projectId}-sessions`}
          className={`sidebar-session-group-body project ${collapsedProject ? "collapsed" : ""}`}
          role="region"
          aria-hidden={collapsedProject}
          inert={collapsedProject ? true : undefined}
        >
          <div className="sidebar-session-group-clip">
            <div className="sidebar-session-group-list">
              {entry.sessions.length > 0 ? renderProjectSessions(visibleSessions) : (
                <div className="sidebar-session-empty">{t("nav.noProjectSessions")}</div>
              )}
            </div>
          </div>
        </div>
      </section>
    );
  };

  /**
   * One panel renders whatever menu is open. The content builders above decide
   * which rows exist, so this stays placement and nothing else.
   */
  const renderFloatingMenu = () => {
    if (!menuPosition || typeof document === "undefined") return null;
    const position = { top: menuPosition.top, left: menuPosition.left };
    const session = sessionMenu
      ? sessions.find((item) => item.id === sessionMenu)
      : undefined;
    const entry = projectMenu
      ? projectEntries.find((item) => item.key === projectMenu)
      : undefined;
    if (sectionMenu) {
      const isSessions = sectionMenu === "sessions";
      return portalToBody(
        <SidebarMenuPanel
          menuRef={floatingMenuRef}
          firstItemRef={menuFirstItemRef}
          className="sidebar-section-menu"
          position={position}
          onKeyDown={onMenuKeyDown}
          content={{
            label: isSessions ? t("nav.newTemporarySession") : t("nav.newProject"),
            items: [
              sidebarMenuAction({
                id: isSessions ? "new-standalone-session" : "new-project",
                label: isSessions
                  ? t("nav.newTemporarySession")
                  : t("nav.newProject"),
                icon: isSessions
                  ? <IconNewSession size={14} />
                  : <IconNewProject size={14} />,
                onSelect: () => {
                  closeMenus(false);
                  if (isSessions) void createSession({ projectPath: null });
                  else void openProjectPicker();
                },
              }),
            ],
          }}
        />,
      );
    }
    if (sortOpen) {
      return portalToBody(
        <SidebarMenuPanel
          menuRef={floatingMenuRef}
          firstItemRef={menuFirstItemRef}
          className="sidebar-sort-menu"
          position={position}
          onKeyDown={onMenuKeyDown}
          content={sortMenuContent}
        />,
      );
    }
    if (session) {
      return portalToBody(
        <SidebarMenuPanel
          menuRef={floatingMenuRef}
          firstItemRef={menuFirstItemRef}
          position={position}
          onKeyDown={onMenuKeyDown}
          content={
            batchSelected
              ? batchMenuContent(selectedIds.size)
              : sessionMenuContent(session)
          }
        />,
      );
    }
    if (entry) {
      const content = projectMenuContent(entry);
      return portalToBody(
        <SidebarMenuPanel
          menuRef={floatingMenuRef}
          firstItemRef={menuFirstItemRef}
          position={position}
          onKeyDown={onMenuKeyDown}
          content={content}
        />,
      );
    }
    return null;
  };

  return (
    <aside
      className={cx("sidebar", "sidebar-surface", className)}
      data-window-blur={windowFocused ? undefined : "true"}
      onAnimationEnd={onAnimationEnd}
    >
      <div className="sidebar-header">
        <TooltipButton
          type="button"
          className="brand no-drag"
          data-nav="home"
          tooltip={t("nav.home")}
          ariaLabel={t("nav.home")}
          onClick={() => setPage("chat")}
        >
          <BrandLogo size={20} />
          <span>{t("app.shellName")}</span>
        </TooltipButton>
        <div className="sidebar-header-actions no-drag">
          <TooltipButton
            type="button"
            className="icon-btn icon-btn-square"
            tooltip={
              sidebarToggleShortcut
                ? `${t("nav.collapseSidebar")} (${sidebarToggleShortcut})`
                : t("nav.collapseSidebar")
            }
            ariaLabel={t("nav.collapseSidebar")}
            aria-expanded={true}
            data-nav="toggle-sidebar"
            onClick={onToggleSidebar}
          >
            <IconSidebar size={15} />
          </TooltipButton>
        </div>
      </div>

      <div className="sidebar-body no-drag">

        {pinnedSessions.length > 0 ? (
          <section
            className="sidebar-pinned-sessions"
            aria-labelledby="sidebar-pinned-label"
            data-sidebar-session-section="pinned"
          >
            <div className="sidebar-list-toolbar sidebar-list-toolbar-secondary">
              <span id="sidebar-pinned-label" className="sidebar-list-label">
                {t("nav.pinnedSessions")}
              </span>
            </div>
            <div className="sidebar-session-group-body pinned" onScroll={() => closeMenus(false)}>
              {renderSessionRows(pinnedSessions, { global: true })}
            </div>
          </section>
        ) : null}

        <section
          className="sidebar-standalone-sessions"
          aria-labelledby="sidebar-standalone-sessions-label"
          data-sidebar-session-section="temporary"
        >
          <div
            className="sidebar-list-toolbar sidebar-list-toolbar-secondary"
            data-sidebar-section="sessions"
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              openSectionMenu("sessions", event.clientX, event.clientY);
            }}
            onPointerDown={(event) => {
              // Keep native drag/text selection from eating the secondary click path.
              if (event.button === 2) event.preventDefault();
            }}
          >
            <span id="sidebar-standalone-sessions-label" className="sidebar-list-label">
              {t("nav.sessions", { defaultValue: "Sessions" })}
            </span>
            <div className="sidebar-toolbar-actions">
              <div className="sidebar-menu-wrap">
                <TooltipButton
                  type="button"
                  className={`sidebar-toolbar-button ${sortOpen ? "active" : ""}`}
                  data-action="session-sort"
                  ariaLabel={t("nav.sortSessions", { defaultValue: "Sort sessions" })}
                  tooltip={t("nav.sortSessions", { defaultValue: "Sort sessions" })}
                  aria-haspopup="menu"
                  aria-expanded={sortOpen}
                  onClick={(event) => {
                    if (sortOpen) {
                      closeMenus();
                      return;
                    }
                    placeMenu(event);
                    menuTriggerRef.current = event.currentTarget;
                    setSessionMenu(null);
                    setProjectMenu(null);
                    setSectionMenu(null);
                    setSortOpen(true);
                  }}
                >
                  <IconArrowUpDown size={14} />
                </TooltipButton>
              </div>
              <TooltipButton
                type="button"
                className="sidebar-toolbar-button"
                data-action="new-standalone-session"
                tooltip={t("nav.newTemporarySession")}
                ariaLabel={t("nav.newTemporarySession")}
                onClick={() => void createSession({ projectPath: null })}
              >
                <IconNewSession size={14} />
              </TooltipButton>
            </div>
          </div>
          <div
            className="sidebar-session-group-body standalone"
            onScroll={() => {
              if (sessionMenu || projectMenu || sectionMenu || sortOpen) closeMenus(false);
            }}
            onContextMenu={(event) => {
              if ((event.target as Element).closest?.("[data-sidebar-session-row]")) return;
              event.preventDefault();
              event.stopPropagation();
              openSectionMenu("sessions", event.clientX, event.clientY);
            }}
          >
            {temporarySessionHistory.length > 0 ? (
              renderSessionRows(temporarySessionHistory, { temporary: true })
            ) : temporarySessions.length === 0 ? (
              <div className="sidebar-session-empty">{t("nav.noTemporarySessions")}</div>
            ) : null}
          </div>
        </section>

        <div
          className="sidebar-list-toolbar"
          data-sidebar-section="projects"
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            openSectionMenu("projects", event.clientX, event.clientY);
          }}
          onPointerDown={(event) => {
            if (event.button === 2) event.preventDefault();
          }}
        >
          <span className="sidebar-list-label">{t("nav.projects")}</span>
          <TooltipButton
            type="button"
            className="sidebar-toolbar-button"
            data-action="new-project"
            tooltip={t("nav.newProject")}
            ariaLabel={t("nav.newProject")}
            onClick={() => void openProjectPicker()}
          >
            <IconNewProject size={14} />
          </TooltipButton>
        </div>

        <div
          className={`sidebar-session-groups min-h-0 flex-1 overflow-auto px-0.5 ${projectsDropActive ? "is-drop-target" : ""}`}
          onScroll={() => {
            if (sessionMenu || projectMenu || sectionMenu || sortOpen) closeMenus(false);
          }}
          onContextMenu={(event) => {
            if (
              (event.target as Element).closest?.(
                "[data-sidebar-session-row], [data-sidebar-project-group]",
              )
            ) {
              return;
            }
            event.preventDefault();
            event.stopPropagation();
            openSectionMenu("projects", event.clientX, event.clientY);
          }}
          onDragEnter={(event) => {
            if (hasComposerFileDrag(event.dataTransfer)) event.preventDefault();
          }}
          onDragOver={onProjectsAreaDragOver}
          onDragLeave={onProjectsAreaDragLeave}
          onDrop={onProjectsAreaDrop}
        >
          {projectEntries.length > 0 ? projectEntries.map(renderProjectGroup) : (
            <section className="sidebar-session-group" aria-labelledby="sidebar-project-group-label">
              <div className="sidebar-session-group-header">
                <button type="button" id="sidebar-project-group-label" className="sidebar-session-group-title" onClick={() => void openProjectPicker()}>
                  <IconFolder size={13} />
                  <span>{t("project.open")}</span>
                </button>
              </div>
            </section>
          )}
          <RemoteProjectGroups groups={remoteProjectGroups}
            renderSessions={(sessions) => renderSessionRows(sessions, {
              temporary: false,
              showLastReplyDate: settings?.sidebarSessionTime === true,
            })} />
        </div>

        <div className="sidebar-footer no-drag">
          <div className="footer-actions">
            <TooltipButton
              type="button"
              className={`footer-action ${page === "settings" ? "active" : ""}`}
              data-nav="settings"
              tooltip={t("nav.settings")}
              ariaLabel={t("nav.settings")}
              onClick={() => setPage("settings")}
              aria-pressed={page === "settings"}
            >
              <IconSettings size={14} aria-hidden />
            </TooltipButton>
            <TooltipButton
              type="button"
              className={`footer-action ${page === "plugins" ? "active" : ""}`}
              data-nav="plugins"
              tooltip={t("nav.plugins")}
              ariaLabel={t("nav.plugins")}
              onClick={() => page === "plugins"
                ? (canNavBack() ? navBack() : setPage("chat"))
                : setPage("plugins")}
              aria-pressed={page === "plugins"}
            >
              <IconPlug size={14} aria-hidden />
            </TooltipButton>
            {settings?.scheduledTasksEnabled !== false && (
              <TooltipButton
                type="button"
                className={`footer-action ${page === "scheduled" ? "active" : ""}`}
                data-nav="scheduled"
                tooltip={t("scheduled.title")}
                ariaLabel={t("scheduled.title")}
                onClick={() => setPage("scheduled")}
                aria-pressed={page === "scheduled"}
              >
                <IconClock size={14} aria-hidden />
              </TooltipButton>
            )}
            <NotificationCenter onBeforeOpen={() => closeMenus(false)} />
          </div>

          <TooltipButton
            type="button"
            className={`footer-build ${updateReady ? "has-update" : ""}`}
            data-nav="build"
            tooltip={buildTitle}
            ariaLabel={buildTitle}
            onClick={() => {
              if (updateReady) {
                setSettingsAnchor("updates.title");
                setSettingsTab("about");
                return;
              }
              void (async () => {
                try {
                  await api.updatesCheck();
                } catch { /* ignore */ }
              })();
            }}
          >
            <span className="footer-build-version">{buildLabel}</span>
            {updateReady ? <span className="footer-build-dot" aria-hidden /> : null}
          </TooltipButton>
        </div>
      </div>
      {renderFloatingMenu()}
      {sessionHoverCard ? (
        <SessionHoverCard
          key={sessionHoverCard.session.id}
          card={sessionHoverCard}
          runningSessions={runningSessions}
          pendingPermissions={pendingPermissions}
          refreshProject={refreshProject}
          onOpenSession={openSessionFromHover}
          keepVisible={keepSessionHoverCardVisible}
          scheduleHide={scheduleSessionHoverCardHide}
          registerDismissGuard={registerSessionHoverCardDismissGuard}
        />
      ) : null}
      <WorktreeDialogs />
      <WorktreeBehindWatcher />
      {renameFor ? (
        <SessionRenameDialog
          session={renameFor}
          onClose={() => setRenameFor(null)}
          onSave={(title) => renameSession(renameFor.id, title)}
          onError={reportError}
        />
      ) : null}
      {editProjectFor ? (
        <ProjectEditDialog
          project={editProjectFor}
          onClose={() => setEditProjectFor(null)}
          onSaved={(group) => {
            editProjectEntry(editProjectFor, group.name);
            // A promoted primary owns the group name from now on, so the entry
            // that opens there later already carries it.
            if (
              normalizeProjectPath(editProjectFor.path) !==
              normalizeProjectPath(group.primaryPath)
            ) {
              renameProject(group.primaryPath, group.name);
            }
          }}
          onError={reportError}
        />
      ) : null}
      {deleteProjectFor ? (
        <ProjectDeleteDialog
          project={{
            name: deleteProjectFor.name,
            path: deleteProjectFor.path,
            sessionCount: deleteProjectFor.sessions.length,
          }}
          runningSessionIds={deleteProjectFor.sessions
            .filter((session) => runningSessions[session.id] === true)
            .map((session) => session.id)}
          onClose={() => setDeleteProjectFor(null)}
          onDeleted={() => {
            setDeleteProjectFor(null);
            showToast(t("project.deleted", { name: deleteProjectFor.name }), {
              variant: "success",
            });
          }}
          onError={reportError}
        />
      ) : null}
      <div
        className={cx("sidebar-resize-handle no-drag", sidebarResizing && "is-resizing")}
        role="separator"
        aria-orientation="vertical"
        aria-label={t("nav.resizeSidebar")}
        aria-valuemin={SIDEBAR_WIDTH_MIN}
        aria-valuemax={clampSidebarWidth(widthMax, widthMax)}
        aria-valuenow={clampSidebarWidth(sidebarWidth, widthMax)}
        aria-valuetext={t("nav.sidebarWidth", { width: clampSidebarWidth(sidebarWidth, widthMax) })}
        tabIndex={0}
        onPointerDown={startSidebarResize}
        onPointerMove={moveSidebarResize}
        onPointerUp={endSidebarResize}
        onPointerCancel={cancelSidebarResize}
        onLostPointerCapture={cancelSidebarResize}
        onKeyDown={handleSidebarResizeKeyDown}
        onDoubleClick={resetSidebarWidth}
      />
    </aside>
  );
}
