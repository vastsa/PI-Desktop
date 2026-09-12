import {
  useCallback,
  useEffect,
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

// --- Time-based session grouping ---
type TimeGroup = "today" | "yesterday" | "thisWeek" | "older14d" | "archived";

function getTimeGroup(dateStr?: string): TimeGroup {
  if (!dateStr) return "older14d";
  const ts = Date.parse(dateStr);
  if (!Number.isFinite(ts)) return "older14d";
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 86400000;
  const startOfWeek = startOfToday - 6 * 86400000; // last 7 days
  const startOf14d = startOfToday - 13 * 86400000;
  if (ts >= startOfToday) return "today";
  if (ts >= startOfYesterday) return "yesterday";
  if (ts >= startOfWeek) return "thisWeek";
  if (ts >= startOf14d) return "older14d";
  return "archived"; // older than 14 days
}

const TIME_GROUP_ORDER: TimeGroup[] = ["today", "yesterday", "thisWeek", "older14d", "archived"];
/** Default number of most-recent sessions shown per project group before the rest fold. */
const MAX_VISIBLE_SESSIONS = 10;
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";
import { isDefaultSessionTitle, useAppStore } from "../stores/app-store";
import { normalizeProjectPath } from "../lib/sidebar-session-groups";
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
import type {
  Mode,
  PermissionMode,
  ProjectWorkspace,
  SessionSummary,
} from "@pi-desktop/shared";
import type {
  ProjectMeta,
  ProjectSort,
  SessionMeta,
  SessionSort,
} from "../lib/sidebar-preferences";
import {
  clampSidebarWidth,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
} from "../lib/sidebar-preferences";
import { BrandLogo } from "./BrandLogo";
import { NotificationCenter } from "./NotificationCenter";
import { ProjectRenameDialog, SessionRenameDialog } from "./SessionRenameDialog";
import { useUpdateState } from "../hooks/use-update-state";
import {
  IconArchive,
  IconArchiveRestore,
  IconArrowUpDown,
  IconPlug,
  IconBranch,
  IconCheck,
  IconChevronDown,
  IconClock,
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
  IconX,
} from "./icons";

type ProjectEntry = {
  path: string;
  key: string;
  name: string;
  sessions: SessionSummary[];
  open: boolean;
  active: boolean;
  meta: ProjectMeta;
  /** Best-effort git branch from the project workspace, if known. */
  branch?: string;
};

type SessionHoverCard = {
  id: string;
  top: number;
  left: number;
  title: string;
  mode: Mode;
  permissionMode: PermissionMode;
  space: string;
  branch?: string;
  updatedAt: string;
  temporary: boolean;
};

const VIEWPORT_PADDING = 8;
const SIDEBAR_RESIZE_STEP = 16;
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

function sessionArchived(
  session: SessionSummary,
  meta: SessionMeta | undefined,
): boolean {
  return Boolean(meta?.archived || (session as SessionSummary & { archived?: boolean }).archived);
}

function sessionPinned(
  session: SessionSummary,
  meta: SessionMeta | undefined,
): boolean {
  return Boolean(meta?.pinned || (session as SessionSummary & { pinned?: boolean }).pinned);
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
  onWidthChange,
  onWidthCommit,
  className,
  onAnimationEnd,
}: {
  onToggleSidebar: () => void;
  sidebarToggleShortcut: string;
  sidebarWidth: number;
  onWidthChange: (width: number) => void;
  onWidthCommit: (width: number) => void;
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
  const page = useAppStore((s) => s.page);
  const settings = useAppStore((s) => s.settings);
  const prefetchSession = useAppStore((s) => s.prefetchSession);
  const selectSession = useAppStore((s) => s.selectSession);
  const newSession = useAppStore((s) => s.newSession);
  const forkSessionAction = useAppStore((s) => s.forkSession);
  const openProject = useAppStore((s) => s.openProject);
  const refreshProject = useAppStore((s) => s.refreshProject);
  const clearProject = useAppStore((s) => s.clearProject);
  const activateProject = useAppStore((s) => s.activateProject);
  const closeProjectAction = useAppStore((s) => s.closeProject);
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
  const [renameProjectFor, setRenameProjectFor] = useState<ProjectEntry | null>(null);
  const [projectMenu, setProjectMenu] = useState<string | null>(null);
  const [sectionMenu, setSectionMenu] = useState<"sessions" | "projects" | null>(null);
  const [menuPosition, setMenuPosition] = useState<{
    top: number;
    left: number;
  } | null>(null);
  const [sessionHoverCard, setSessionHoverCard] = useState<SessionHoverCard | null>(null);
  const [expandedProjectSessions, setExpandedProjectSessions] = useState<Record<string, boolean>>({});
  const [draggingSessionId, setDraggingSessionId] = useState<string | null>(null);
  const [dropProjectKey, setDropProjectKey] = useState<string | null>(null);
  const [projectsDropActive, setProjectsDropActive] = useState(false);
  const [sidebarResizing, setSidebarResizing] = useState(false);
  const [draggingProjectKey, setDraggingProjectKey] = useState<string | null>(null);
  const [dropIndicator, setDropIndicator] = useState<{ key: string; insertAfter: boolean } | null>(null);
  const menuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const menuFirstItemRef = useRef<HTMLButtonElement | null>(null);
  const sessionPrefetchTimerRef = useRef<number | undefined>(undefined);
  const sessionHoverTimerRef = useRef<number | undefined>(undefined);
  const sessionHoverTargetRef = useRef<HTMLElement | null>(null);
  const sidebarResizeRef = useRef<SidebarResizeState | null>(null);
  const projectReorderRef = useRef<ProjectReorderPointerState | null>(null);
  const suppressProjectTitleClickRef = useRef(false);
  const projectEntriesRef = useRef<ProjectEntry[]>([]);
  const reorderProjectEntriesRef = useRef<(
    sourceKey: string,
    targetKey: string,
    insertAfter: boolean,
  ) => void>(() => {});

  const finishSidebarResize = useCallback((cancelled: boolean) => {
    const state = sidebarResizeRef.current;
    if (!state) return;
    if (cancelled) {
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
  }, [onWidthChange, onWidthCommit]);

  const startSidebarResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || sidebarResizeRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.focus({ preventScroll: true });
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
  }, [sidebarWidth]);

  const moveSidebarResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const state = sidebarResizeRef.current;
    if (!state || state.pointerId !== event.pointerId) return;
    const nextWidth = clampSidebarWidth(state.startWidth + event.clientX - state.startX);
    state.currentWidth = nextWidth;
    if (state.frame) return;
    state.frame = requestAnimationFrame(() => {
      if (sidebarResizeRef.current !== state) return;
      state.frame = 0;
      onWidthChange(state.currentWidth);
    });
  }, [onWidthChange]);

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
    const currentWidth = clampSidebarWidth(sidebarWidth);
    const nextWidth = event.key === "Home"
      ? SIDEBAR_WIDTH_MIN
      : event.key === "End"
        ? SIDEBAR_WIDTH_MAX
        : clampSidebarWidth(
            currentWidth + (event.key === "ArrowRight" ? SIDEBAR_RESIZE_STEP : -SIDEBAR_RESIZE_STEP),
          );
    if (nextWidth === currentWidth) return;
    onWidthCommit(nextWidth);
  }, [onWidthCommit, sidebarWidth]);

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
    setMenuPosition({
      top: Math.max(
        VIEWPORT_PADDING,
        Math.min(rect.bottom + 4, window.innerHeight - 220),
      ),
      left: Math.max(VIEWPORT_PADDING, rect.right + 4),
    });
  }, []);

  // Body-level sidebar menus always anchor their left edge to the right side
  // of the trigger or pointer; they never flip to the left at the viewport edge.
  const placeMenuAtPoint = useCallback((x: number, y: number) => {
    setMenuPosition({
      top: Math.max(
        VIEWPORT_PADDING,
        Math.min(y + 4, window.innerHeight - 220),
      ),
      left: Math.max(VIEWPORT_PADDING, x + 4),
    });
  }, []);

  const openSessionRowMenu = useCallback(
    (sessionId: string, trigger: HTMLButtonElement | null) => {
      menuTriggerRef.current = trigger;
      setSortOpen(false);
      setProjectMenu(null);
      setSectionMenu(null);
      sessionHoverTargetRef.current = null;
      window.clearTimeout(sessionHoverTimerRef.current);
      setSessionHoverCard(null);
      setSessionMenu(sessionId);
    },
    [],
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

  // Match WorkBuddy's hover-card cadence: half a second is long enough for
  // the pointer to settle on the row, but short enough that a deliberate
  // hover does not feel sluggish.
  const PROJECT_PATH_HOVER_DELAY_MS = 500;

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

  useEffect(() => {
    if (!sessionHoverCard) return;
    const hide = () => {
      window.clearTimeout(sessionHoverTimerRef.current);
      setSessionHoverCard(null);
    };
    window.addEventListener("resize", hide);
    return () => window.removeEventListener("resize", hide);
  }, [sessionHoverCard]);

  // Cancel any pending session hover-card reveal when the sidebar scrolls;
  // mirrors the project path tooltip behavior so the cards never anchor to a
  // row that has scrolled out from under the cursor.
  useEffect(() => {
    if (!sessionHoverCard) return;
    let frame = 0;
    const onScroll = () => {
      window.clearTimeout(sessionHoverTimerRef.current);
      if (!sessionHoverCard) return;
      frame = window.requestAnimationFrame(() => setSessionHoverCard(null));
    };
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.cancelAnimationFrame(frame);
    };
  }, [sessionHoverCard]);

  // Footer utility bar: settings / plugins / notifications + build chip.

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

  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeMenus();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"]:not(:disabled), [role="menuitemradio"]:not(:disabled), [role="menuitemcheckbox"]:not(:disabled)',
      ),
    );
    if (!items.length) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) %
            items.length;
    items[next]?.focus();
  };

  const taskTitle = useCallback((title?: string | null) => {
    const value = (title || "").trim();
    return isDefaultSessionTitle(value) ? t("chat.untitledTask") : value;
  }, [t]);

  const filtered = useMemo(() => {
    const candidates = showArchived
      ? sessions
      : sessions.filter(
          (session) => !sessionArchived(session, sessionMeta[session.id]),
        );
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

  // Locale-aware absolute timestamp matching the WorkBuddy card shape:
  // "2026-09-04 14:11:53" in zh-CN, "Sep 4, 2026, 2:11 PM" in en-US.
  const formatHoverCardTimestamp = useCallback(
    (value: string | undefined): string => {
      if (!value) return "—";
      const parsed = new Date(value);
      if (Number.isNaN(parsed.getTime())) return value;
      try {
        const locale = i18n.language || undefined;
        const usesAbsoluteDateTime =
          (locale || "").toLowerCase().startsWith("zh");
        const fmt = new Intl.DateTimeFormat(locale, {
          year: "numeric",
          month: usesAbsoluteDateTime ? "2-digit" : "short",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: !usesAbsoluteDateTime,
        });
        return fmt.format(parsed);
      } catch {
        return parsed.toLocaleString();
      }
    },
    [i18n],
  );

  const hideSessionHoverCard = useCallback(() => {
    sessionHoverTargetRef.current = null;
    window.clearTimeout(sessionHoverTimerRef.current);
    setSessionHoverCard(null);
  }, []);

  const showSessionHoverCard = useCallback(
    (
      session: SessionSummary,
      target: HTMLElement,
      temporary: boolean,
    ) => {
      // Clear any pending timer so back-to-back hovers don't flash the card.
      sessionHoverTargetRef.current = target;
      window.clearTimeout(sessionHoverTimerRef.current);
      sessionHoverTimerRef.current = window.setTimeout(async () => {
        // Skip if the row was torn down while we were waiting (project
        // closed, list filtered, etc.) — nothing meaningful to point at.
        if (!target.isConnected || sessionHoverTargetRef.current !== target) return;
        const projectPath = session.projectPath ?? "";
        let refreshedWorkspace: ProjectWorkspace | null = null;
        if (!temporary) {
          try {
            refreshedWorkspace = await refreshProject(projectPath);
          } catch {
            // Hover metadata is best effort; keep the last cached branch when
            // the host is unavailable or the project is no longer active.
          }
        }
        if (!target.isConnected || sessionHoverTargetRef.current !== target) return;
        const rect = target.getBoundingClientRect();
        const cardWidth = Math.min(320, window.innerWidth - 16);
        const cardHeight = 168; // estimated; used for flip-below detection
        const wantBelow = rect.bottom + cardHeight <= window.innerHeight;
        const normalizedProjectPath = normalizeProjectPath(projectPath);
        const spaceEntry = temporary
          ? null
          : projectEntriesByPath.get(normalizedProjectPath ?? "");
        const spaceName = temporary
          ? t("nav.hoverCardTemporarySpace")
          : (refreshedWorkspace?.name ?? spaceEntry?.name ?? projectName(projectPath));
        setSessionHoverCard({
          id: `session-hover-${session.id}`,
          top: wantBelow ? rect.bottom + 6 : Math.max(8, rect.top - cardHeight - 6),
          left: Math.max(
            8,
            Math.min(rect.left, window.innerWidth - cardWidth - 8),
          ),
          title: taskTitle(session.title),
          mode: session.mode,
          permissionMode: session.permissionMode,
          space: spaceName,
          branch: refreshedWorkspace ? refreshedWorkspace.branch : spaceEntry?.branch,
          updatedAt: formatHoverCardTimestamp(session.updatedAt),
          temporary,
        });
      }, PROJECT_PATH_HOVER_DELAY_MS);
    },
    [projectEntriesByPath, refreshProject, t, taskTitle, formatHoverCardTimestamp],
  );

  const temporarySessions = useMemo(
    () => filtered
      .filter((session) => !normalizeProjectPath(session.projectPath))
      .sort(compareSessions),
    [filtered, compareSessions],
  );
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

  useEffect(() => cancelSessionPrefetch, []);

  const setCollapsed = (path: string, value: boolean) => {
    const normalized = normalizeProjectPath(path) || path;
    setProjectCollapsed(normalized, value);
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
    setExpandedProjectSessions((prev) => ({ ...prev, [projectKey]: true }));
  };

  const toggleSessionPin = (session: SessionSummary) => {
    toggleSessionPinned(session.id);
    closeMenus();
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

  const openProjectFolder = async (entry: ProjectEntry) => {
    closeMenus(false);
    try {
      await api.openProjectFolder(entry.path);
    } catch (error) {
      reportError(error);
    }
  };

  const renameProjectEntry = async (entry: ProjectEntry, name: string) => {
    renameProject(entry.path, name);
  };

  const forkSession = async (session: SessionSummary) => {
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

  const openSessionPath = async (session: SessionSummary) => {
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

  const closeProject = async (entry: ProjectEntry) => {
    closeMenus();
    try {
      await closeProjectAction(entry.path);
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
    options?: { temporary?: boolean; projectPath?: string },
  ) => items.map((session) => {
    const meta = sessionMeta[session.id] ?? {};
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
    return (
      <div
        key={session.id}
        className={`thread-item ${active ? "active" : ""} ${archived ? "archived" : ""} ${draggingSessionId === session.id ? "is-dragging" : ""}`}
        data-sidebar-session-row={session.id}
        draggable={!running}
        onDragStart={(event) => {
          if (running) {
            event.preventDefault();
            return;
          }
          beginSessionDrag(event, session.id);
        }}
        onDragEnd={endSessionDrag}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
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
            showSessionHoverCard(session, event.currentTarget, options?.temporary ?? false)
          }
          onMouseLeave={hideSessionHoverCard}
          onFocusCapture={(event) =>
            showSessionHoverCard(session, event.currentTarget, options?.temporary ?? false)
          }
          onBlur={hideSessionHoverCard}
          onClick={() => {
            cancelSessionPrefetch();
            hideSessionHoverCard();
            void (options?.temporary
              ? selectTemporarySession(session.id)
              : selectProjectSession(session));
          }}
          aria-current={active ? "page" : undefined}
        >
          {sessionPinned(session, meta) ? (
            <IconPin size={11} className="thread-item-pin" aria-hidden />
          ) : null}
          <span className="thread-item-title">{taskTitle(session.title)}</span>
        </button>
        <div className="sidebar-row-actions">
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

    // Show the most recent MAX_VISIBLE_SESSIONS rows by default; the remaining
    // sessions stay folded behind the same load-more affordance used for the
    // time-grouped overflow and expand on click.
    const sessionsExpanded = expandedProjectSessions[entry.key] ?? false;
    const visibleSessions = sessionsExpanded
      ? entry.sessions
      : entry.sessions.slice(0, MAX_VISIBLE_SESSIONS);
    const hiddenCount = entry.sessions.length - visibleSessions.length;

    const renderTimeGroupedSessions = (sessions: SessionSummary[]) => {
      // Group the visible slice by time, preserving recency order.
      const grouped = new Map<TimeGroup, SessionSummary[]>();
      for (const session of sessions) {
        const group = getTimeGroup(session.updatedAt);
        if (!grouped.has(group)) grouped.set(group, []);
        grouped.get(group)!.push(session);
      }
      const result: React.ReactNode[] = [];
      for (const group of TIME_GROUP_ORDER) {
        const groupSessions = grouped.get(group);
        if (!groupSessions || groupSessions.length === 0) continue;

        // For today, don't show header (as per requirement)
        if (group !== "today") {
          const i18nKey =
            group === "yesterday" ? "nav.timeGroupYesterday" :
            group === "thisWeek" ? "nav.timeGroupThisWeek" :
            group === "older14d" ? "nav.timeGroupOlder14d" :
            "nav.timeGroupArchived";
          result.push(
            <div key={`group-header-${group}`} className="sidebar-time-group-header">
              {t(i18nKey)}
            </div>
          );
        }
        result.push(...renderSessionRows(groupSessions, { projectPath: entry.path }));
      }
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
        className={`sidebar-session-group project-group ${entry.active ? "active" : ""} ${entry.meta.archived ? "archived" : ""} ${dropProjectKey === entry.key ? "is-drop-target" : ""} ${draggingProjectKey === entry.key ? "is-dragging" : ""} ${dropIndicator?.key === entry.key ? (dropIndicator.insertAfter ? "is-drop-after" : "is-drop-before") : ""}`}
        aria-labelledby={projectId}
        data-sidebar-project-group={entry.key}
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
        <div
          className="sidebar-session-group-header"
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
            tooltip={entry.path}
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
            {entry.active ? <span className="sidebar-project-active-dot" aria-label={t("project.active", { defaultValue: "Active" })} /> : null}
          </TooltipButton>
          <span id={`${projectId}-path-description`} className="sr-only">
            {entry.path}
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
        >
          {entry.sessions.length > 0 ? renderTimeGroupedSessions(visibleSessions) : (
            <div className="sidebar-session-empty">{t("nav.noProjectSessions")}</div>
          )}
        </div>
      </section>
    );
  };

  const renderFloatingMenu = () => {
    if (
      !menuPosition ||
      typeof document === "undefined" ||
      (!sessionMenu && !projectMenu && !sectionMenu && !sortOpen)
    ) {
      return null;
    }
    if (sectionMenu) {
      const isSessions = sectionMenu === "sessions";
      const action = isSessions ? "new-standalone-session" : "new-project";
      const label = isSessions
        ? t("nav.newTemporarySession")
        : t("nav.newProject");
      const Icon = isSessions ? IconNewSession : IconNewProject;
      return createPortal(
        <div
          className="sidebar-row-menu sidebar-floating-menu sidebar-section-menu"
          role="menu"
          data-sidebar-section-menu={sectionMenu}
          onKeyDown={onMenuKeyDown}
          style={{
            top: menuPosition.top,
            left: menuPosition.left,
          }}
        >
          <button
            ref={menuFirstItemRef}
            type="button"
            role="menuitem"
            data-action={action}
            onClick={() => {
              closeMenus(false);
              if (isSessions) void createSession({ projectPath: null });
              else void openProjectPicker();
            }}
          >
            <Icon size={14} />
            <span>{label}</span>
          </button>
        </div>,
        document.body,
      );
    }
    if (sortOpen) {
      return createPortal(
        <div
          className="sidebar-popover sidebar-sort-menu sidebar-floating-menu"
          role="menu"
          onKeyDown={onMenuKeyDown}
          style={{
            top: menuPosition.top,
            left: menuPosition.left,
          }}
        >
          <div className="sidebar-popover-title">
            {t("nav.sortSessions", { defaultValue: "Sort sessions" })}
          </div>
          {(["recent", "oldest", "name", "created"] as const).map((value, index) => (
            <button ref={index === 0 ? menuFirstItemRef : undefined} key={value} type="button" role="menuitemradio" aria-checked={displaySessionSort === value} className={displaySessionSort === value ? "selected" : ""} data-sort={value} onClick={() => setSort(value)}>
              <span>{value === "recent" ? t("nav.sortRecent", { defaultValue: "Recently updated" }) : value === "oldest" ? t("nav.sortOldest", { defaultValue: "Oldest first" }) : value === "name" ? t("nav.sortName", { defaultValue: "Name" }) : t("nav.sortCreated", { defaultValue: "Created date" })}</span>
              {displaySessionSort === value ? <span className="sidebar-sort-check">✓</span> : null}
            </button>
          ))}
          <div className="sidebar-popover-divider" />
          <button type="button" role="menuitemcheckbox" aria-checked={showArchived} data-action="toggle-show-archived" onClick={toggleShowArchived}>
            <span>{showArchived ? t("nav.hideArchived", { defaultValue: "Hide archived" }) : t("nav.showArchived", { defaultValue: "Show archived" })}</span>
            <span className={`sidebar-checkbox ${showArchived ? "checked" : ""}`}>{showArchived ? "✓" : ""}</span>
          </button>
        </div>,
        document.body,
      );
    }
    const session = sessionMenu
      ? sessions.find((item) => item.id === sessionMenu)
      : undefined;
    const entry = projectMenu
      ? projectEntries.find((item) => item.key === projectMenu)
      : undefined;
    if (!session && !entry) return null;
    return createPortal(
      <div
        className="sidebar-row-menu sidebar-floating-menu"
        role="menu"
        onKeyDown={onMenuKeyDown}
        style={{
          top: menuPosition.top,
          left: menuPosition.left,
        }}
      >
        {session ? (
          <>
            <button
              ref={menuFirstItemRef}
              type="button"
              role="menuitem"
              data-action="rename-session"
              onClick={() => {
                closeMenus(false);
                setRenameFor(session);
              }}
            >
              <IconPencil size={14} />
              {t("nav.renameTask", { defaultValue: "Rename task" })}
            </button>
            <button
              type="button"
              role="menuitem"
              data-action="toggle-session-pin"
              onClick={() => toggleSessionPin(session)}
            >
              <IconPin size={14} />
              {sessionPinned(session, sessionMeta[session.id])
                ? t("nav.unpinTask", { defaultValue: "Unpin" })
                : t("nav.pinTask", { defaultValue: "Pin" })}
            </button>
            <button
              type="button"
              role="menuitem"
              data-action="toggle-session-archive"
              onClick={() => void archiveSession(session)}
            >
              {sessionArchived(session, sessionMeta[session.id]) ? (
                <IconArchiveRestore size={14} />
              ) : (
                <IconArchive size={14} />
              )}
              {sessionArchived(session, sessionMeta[session.id])
                ? t("nav.restoreTask", { defaultValue: "Restore" })
                : t("nav.archiveTask", { defaultValue: "Archive" })}
            </button>
            <button
              type="button"
              role="menuitem"
              data-action="fork-session"
              disabled={Boolean(runningSessions[session.id])}
              onClick={() => void forkSession(session)}
            >
              <IconBranch size={14} />
              {t("nav.createBranch")}
            </button>
            {settings?.developerMode === true ? (
              <>
                <button
                  type="button"
                  role="menuitem"
                  data-action="copy-conversation-id"
                  onClick={() => void copyConversationId(session)}
                >
                  <IconCopy size={14} />
                  {t("nav.copyConversationId")}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  data-action="open-session-path"
                  onClick={() => void openSessionPath(session)}
                >
                  <IconFolder size={14} />
                  {t("nav.openSessionPath")}
                </button>
              </>
            ) : null}
            <button
              type="button"
              role="menuitem"
              className="danger"
              data-action="delete-session"
              onClick={() => void deleteSession(session)}
            >
              <IconX size={14} />
              {t("nav.deleteTask", { defaultValue: "Delete" })}
            </button>
          </>
        ) : null}
        {entry ? (
          <>
            <button
              ref={menuFirstItemRef}
              type="button"
              role="menuitem"
              data-action="open-project-folder"
              onClick={() => void openProjectFolder(entry)}
            >
              <IconFolder size={14} />
              {t("project.openFolder", { defaultValue: "Open folder" })}
            </button>
            <button
              type="button"
              role="menuitem"
              data-action="rename-project"
              onClick={() => {
                closeMenus(false);
                setRenameProjectFor(entry);
              }}
            >
              <IconPencil size={14} />
              {t("project.rename", { defaultValue: "Rename project" })}
            </button>
            <button
              type="button"
              role="menuitem"
              data-action="toggle-project-pin"
              onClick={() => toggleProjectPin(entry)}
            >
              <IconPin size={14} />
              {entry.meta.pinned ? t("project.unpin") : t("project.pin")}
            </button>
            <button
              type="button"
              role="menuitem"
              data-action="toggle-project-archive"
              onClick={() => void archiveProject(entry)}
            >
              {entry.meta.archived ? (
                <IconArchiveRestore size={14} />
              ) : (
                <IconArchive size={14} />
              )}
              {entry.meta.archived
                ? t("project.restore", { defaultValue: "Restore project" })
                : t("project.archive", { defaultValue: "Archive project" })}
            </button>
            {entry.open ? (
              <button
                type="button"
                role="menuitem"
                onClick={() => void closeProject(entry)}
              >
                <IconX size={14} />
                {t("project.close")}
              </button>
            ) : null}
          </>
        ) : null}
      </div>,
      document.body,
    );
  };

  // Map a session mode to the secondary tag label. We only show one tag in
  // addition to the always-on "Local task" badge so the row stays compact.
  const modeTagLabel = (mode: Mode, permission: PermissionMode): string => {
    if (mode === "plan") return t("chat.modePlan");
    if (mode === "goal") return t("chat.modeGoal");
    if (permission === "auto") return t("chat.permissionAuto");
    if (permission === "accept-edits") return t("chat.permissionAcceptEdits");
    if (permission === "ask") return t("chat.permissionAsk");
    return t("chat.modeAgent");
  };

  const renderSessionHoverCard = () => {
    if (!sessionHoverCard || typeof document === "undefined") return null;
    return createPortal(
      <div
        id={sessionHoverCard.id}
        className="sidebar-session-hover-card"
        role="tooltip"
        style={{ top: sessionHoverCard.top, left: sessionHoverCard.left }}
      >
        <div className="sidebar-session-hover-card-title">
          {sessionHoverCard.title}
        </div>
        <div className="sidebar-session-hover-card-tags">
          <span className="sidebar-session-hover-card-tag">
            <IconBranch size={12} aria-hidden />
            {t("nav.hoverCardLocalTask")}
          </span>
          <span className="sidebar-session-hover-card-tag sidebar-session-hover-card-tag-accent">
            {modeTagLabel(sessionHoverCard.mode, sessionHoverCard.permissionMode)}
          </span>
        </div>
        <div className="sidebar-session-hover-card-meta">
          <div className="sidebar-session-hover-card-meta-row">
            <span className="sidebar-session-hover-card-meta-icon" aria-hidden>
              <IconFolder size={12} />
            </span>
            <span className="sidebar-session-hover-card-meta-label">
              {t("nav.hoverCardSpace")}
            </span>
            <span className="sidebar-session-hover-card-meta-value">
              {sessionHoverCard.space}
            </span>
          </div>
          {sessionHoverCard.branch ? (
            <div className="sidebar-session-hover-card-meta-row">
              <span className="sidebar-session-hover-card-meta-icon" aria-hidden>
                <IconBranch size={12} />
              </span>
              <span
                className="sidebar-session-hover-card-meta-value"
                aria-label={t("nav.hoverCardBranchAria", {
                  name: sessionHoverCard.branch,
                })}
              >
                {sessionHoverCard.branch}
              </span>
            </div>
          ) : null}
          <div className="sidebar-session-hover-card-meta-row">
            <span className="sidebar-session-hover-card-meta-icon" aria-hidden>
              <IconClock size={12} />
            </span>
            <span className="sidebar-session-hover-card-meta-label">
              {t("nav.hoverCardUpdatedAt", {
                when: sessionHoverCard.updatedAt,
              })}
            </span>
          </div>
        </div>
      </div>,
      document.body,
    );
  };

  return (
    <aside
      className={cx("sidebar", className)}
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
            className="icon-btn"
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
            {temporarySessions.length > 0 ? renderSessionRows(temporarySessions, { temporary: true }) : (
              <div className="sidebar-session-empty">{t("nav.noTemporarySessions")}</div>
            )}
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
            >
              <IconSettings size={14} aria-hidden />
            </TooltipButton>
            <TooltipButton
              type="button"
              className={`footer-action ${page === "plugins" ? "active" : ""}`}
              data-nav="plugins"
              tooltip={t("nav.plugins")}
              ariaLabel={t("nav.plugins")}
              onClick={() => setPage("plugins")}
            >
              <IconPlug size={14} aria-hidden />
            </TooltipButton>
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
      {renderSessionHoverCard()}
      {renameFor ? (
        <SessionRenameDialog
          session={renameFor}
          onClose={() => setRenameFor(null)}
          onSave={(title) => renameSession(renameFor.id, title)}
          onError={reportError}
        />
      ) : null}
      {renameProjectFor ? (
        <ProjectRenameDialog
          project={renameProjectFor}
          onClose={() => setRenameProjectFor(null)}
          onSave={(name) => renameProjectEntry(renameProjectFor, name)}
          onError={reportError}
        />
      ) : null}
      <div
        className={cx("sidebar-resize-handle no-drag", sidebarResizing && "is-resizing")}
        role="separator"
        aria-orientation="vertical"
        aria-label={t("nav.resizeSidebar")}
        aria-valuemin={SIDEBAR_WIDTH_MIN}
        aria-valuemax={SIDEBAR_WIDTH_MAX}
        aria-valuenow={clampSidebarWidth(sidebarWidth)}
        aria-valuetext={t("nav.sidebarWidth", { width: clampSidebarWidth(sidebarWidth) })}
        tabIndex={0}
        onPointerDown={startSidebarResize}
        onPointerMove={moveSidebarResize}
        onPointerUp={endSidebarResize}
        onPointerCancel={cancelSidebarResize}
        onLostPointerCapture={cancelSidebarResize}
        onKeyDown={handleSidebarResizeKeyDown}
      />
    </aside>
  );
}
