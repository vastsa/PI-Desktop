import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type AnimationEventHandler as ReactAnimationEventHandler,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { cx } from "./ui";

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
  sidebarSessionStatus,
  type SidebarSessionStatus,
} from "../lib/sidebar-session-status";
import type { ProjectWorkspace, SessionSummary } from "@pi-desktop/shared";
import type {
  ProjectMeta,
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
import { SessionRenameDialog } from "./SessionRenameDialog";
import { useUpdateState } from "../lib/use-update-state";
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
  IconSearch,
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
};

type ProjectPathTooltip = {
  id: string;
  path: string;
  top: number;
  left: number;
};

const VIEWPORT_PADDING = 8;
const SIDEBAR_RESIZE_STEP = 16;

type SidebarResizeState = {
  pointerId: number;
  startX: number;
  startWidth: number;
  currentWidth: number;
  frame: number;
  handle: HTMLDivElement;
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
  onOpenSearch,
  onToggleSidebar,
  sidebarToggleShortcut,
  sidebarWidth,
  onWidthChange,
  onWidthCommit,
  className,
  onAnimationEnd,
}: {
  onOpenSearch: () => void;
  onToggleSidebar: () => void;
  sidebarToggleShortcut: string;
  sidebarWidth: number;
  onWidthChange: (width: number) => void;
  onWidthCommit: (width: number) => void;
  className?: string;
  onAnimationEnd?: ReactAnimationEventHandler<HTMLElement>;
}) {
  const { t } = useTranslation();
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
  const clearProject = useAppStore((s) => s.clearProject);
  const activateProject = useAppStore((s) => s.activateProject);
  const closeProjectAction = useAppStore((s) => s.closeProject);
  const toggleSessionPinned = useAppStore((s) => s.toggleSessionPinned);
  const archiveSessionAction = useAppStore((s) => s.archiveSession);
  const restoreSession = useAppStore((s) => s.restoreSession);
  const renameSession = useAppStore((s) => s.renameSession);
  const deleteSessionAction = useAppStore((s) => s.deleteSession);
  const setSessionSort = useAppStore((s) => s.setSessionSort);
  const setSessionArchiveVisibility = useAppStore((s) => s.setSessionArchiveVisibility);
  const toggleProjectPinned = useAppStore((s) => s.toggleProjectPinned);
  const archiveProjectAction = useAppStore((s) => s.archiveProject);
  const restoreProject = useAppStore((s) => s.restoreProject);
  const setProjectCollapsed = useAppStore((s) => s.setProjectCollapsed);
  const setProjectSort = useAppStore((s) => s.setProjectSort);
  const showToast = useAppStore((s) => s.showToast);
  const version = useAppStore((s) => s.version);
  const setSettingsTab = useAppStore((s) => s.setSettingsTab);
  const setSettingsAnchor = useAppStore((s) => s.setSettingsAnchor);
  const update = useUpdateState();

  const [sortOpen, setSortOpen] = useState(false);
  const [sessionMenu, setSessionMenu] = useState<string | null>(null);
  const [renameFor, setRenameFor] = useState<SessionSummary | null>(null);
  const [projectMenu, setProjectMenu] = useState<string | null>(null);
  const [sectionMenu, setSectionMenu] = useState<"sessions" | "projects" | null>(null);
  const [menuPosition, setMenuPosition] = useState<{
    top: number;
    left: number;
  } | null>(null);
  const [projectPathTooltip, setProjectPathTooltip] = useState<ProjectPathTooltip | null>(null);
  const [expandedProjectSessions, setExpandedProjectSessions] = useState<Record<string, boolean>>({});
  const [sidebarResizing, setSidebarResizing] = useState(false);
  const menuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const menuFirstItemRef = useRef<HTMLButtonElement | null>(null);
  const sessionPrefetchTimerRef = useRef<number | undefined>(undefined);
  const projectPathTimerRef = useRef<number | undefined>(undefined);
  const sidebarResizeRef = useRef<SidebarResizeState | null>(null);

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
  const displayProjectSort: Exclude<SessionSort, "manual"> =
    projectSort === "manual" ? "recent" : projectSort;
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
      setSessionMenu(sessionId);
    },
    [],
  );

  const openProjectRowMenu = useCallback(
    (projectKey: string, trigger: HTMLButtonElement | null) => {
      menuTriggerRef.current = trigger;
      window.clearTimeout(projectPathTimerRef.current);
      setProjectPathTooltip(null);
      setSortOpen(false);
      setSessionMenu(null);
      setSectionMenu(null);
      setProjectMenu(projectKey);
    },
    [],
  );

  const showProjectPath = useCallback(
    (entry: ProjectEntry, target: HTMLButtonElement) => {
      // Clear any existing timer
      window.clearTimeout(projectPathTimerRef.current);
      
      // Set a new timer for 1.5 seconds
      projectPathTimerRef.current = window.setTimeout(() => {
        const rect = target.getBoundingClientRect();
        const tooltipWidth = Math.min(420, window.innerWidth - 16);
        setProjectPathTooltip({
          id: `${projectDomId(entry.key)}-path-tooltip`,
          path: entry.path,
          top:
            rect.bottom + 48 <= window.innerHeight
              ? rect.bottom + 6
              : Math.max(8, rect.top - 42),
          left: Math.max(8, Math.min(rect.left, window.innerWidth - tooltipWidth - 8)),
        });
      }, 400);
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

  useEffect(() => {
    if (!projectPathTooltip) return;
    const hideTooltip = () => {
      window.clearTimeout(projectPathTimerRef.current);
      setProjectPathTooltip(null);
    };
    window.addEventListener("resize", hideTooltip);
    return () => window.removeEventListener("resize", hideTooltip);
  }, [projectPathTooltip]);

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
    const add = (rawPath: string, name?: string, open = false) => {
      const normalized = normalizeProjectPath(rawPath);
      if (!normalized) return;
      const existing = byPath.get(normalized);
      if (existing) {
        existing.open ||= open;
        if (name && existing.name === projectName(existing.path)) existing.name = name;
        return;
      }
      byPath.set(normalized, {
        path: rawPath,
        key: normalized,
        name: projectName(rawPath, name),
        sessions: [],
        open,
        active: normalized === activeProjectPath,
        meta: projectMetaFor(rawPath, projectMeta),
      });
    };
    for (const path of openProjectPaths) {
      const record = openProjects.find(
        (project) => normalizeProjectPath(project.path) === path,
      );
      add(path, record?.name, true);
    }
    if (workspace?.path) add(workspace.path, workspace.name, true);
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
      if (displayProjectSort === "name") {
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

  const forkSession = async (session: SessionSummary) => {
    closeMenus(false);
    try {
      await forkSessionAction(session.id);
      focusComposer();
    } catch (error) {
      reportError(error);
    }
  };

  const copySessionPath = async (session: SessionSummary) => {
    try {
      const result = await api.getSessionScratchPath(session.id);
      await navigator.clipboard.writeText(result.path);
      showToast(t("chat.copied"));
    } catch (error) {
      reportError(error);
    }
    closeMenus();
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
        className={`thread-item ${active ? "active" : ""} ${archived ? "archived" : ""}`}
        data-sidebar-session-row={session.id}
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
          onClick={() => {
            cancelSessionPrefetch();
            void (options?.temporary
              ? selectTemporarySession(session.id)
              : selectProjectSession(session));
          }}
          title={taskTitle(session.title)}
          aria-current={active ? "page" : undefined}
        >
          {sessionPinned(session, meta) ? (
            <IconPin size={11} className="thread-item-pin" aria-hidden />
          ) : null}
          <span className="thread-item-title">{taskTitle(session.title)}</span>
        </button>
        <div className="sidebar-row-actions">
          <button
            type="button"
            className="thread-item-more"
            data-action="session-menu"
            aria-label={t("nav.sessionActions", { defaultValue: "Session actions" })}
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
          </button>
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
        className={`sidebar-session-group project-group ${entry.active ? "active" : ""} ${entry.meta.archived ? "archived" : ""}`}
        aria-labelledby={projectId}
        data-sidebar-project-group={entry.key}
      >
        <div
          className="sidebar-session-group-header"
          onContextMenu={(event) => {
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
          <button
            type="button"
            id={projectId}
            className="sidebar-session-group-title project-toggle"
            aria-label={entry.name}
            aria-describedby={`${projectId}-path-description`}
            aria-expanded={!collapsedProject}
            aria-controls={`${projectId}-sessions`}
            data-action="toggle-project-collapse"
            onMouseEnter={(event) => showProjectPath(entry, event.currentTarget)}
            onMouseLeave={() => {
              window.clearTimeout(projectPathTimerRef.current);
              setProjectPathTooltip(null);
            }}
            onFocus={(event) => showProjectPath(entry, event.currentTarget)}
            onBlur={() => {
              window.clearTimeout(projectPathTimerRef.current);
              setProjectPathTooltip(null);
            }}
            onClick={() => void (async () => {
              if (!entry.active && !(await selectProject(entry.path))) return;
              setCollapsed(entry.path, !collapsedProject);
            })()}
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
          </button>
          <span id={`${projectId}-path-description`} className="sr-only">
            {entry.path}
          </span>
          <div className="sidebar-menu-wrap">
            <button
              type="button"
              className="thread-item-more project-more"
              aria-label={t("project.openActions", { name: entry.name })}
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
            </button>
          </div>
          <button
            type="button"
            className="sidebar-session-group-add"
            title={entry.active ? t("project.newTask") : t("project.openAndNewTask", { defaultValue: "Open project and create task" })}
            aria-label={entry.active ? t("project.newTask") : t("project.openAndNewTask", { defaultValue: "Open project and create task" })}
            onClick={() => void createProjectSession(entry.path)}
          >
            <IconNewSession size={13} />
          </button>
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
              <button
                type="button"
                role="menuitem"
                data-action="copy-session-path"
                onClick={() => void copySessionPath(session)}
              >
                <IconCopy size={14} />
                {t("nav.copySessionPath")}
              </button>
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
              onClick={() =>
                void selectProject(entry.path).then((ok) => {
                  if (ok) {
                    closeMenus(false);
                    focusComposer();
                  }
                })
              }
            >
              <IconFolder size={14} />
              {entry.active
                ? t("project.active", { defaultValue: "Active" })
                : t("project.switch", { defaultValue: "Switch" })}
            </button>
            <button
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

  const renderProjectPathTooltip = () => {
    if (!projectPathTooltip || typeof document === "undefined") return null;
    return createPortal(
      <div
        id={projectPathTooltip.id}
        className="sidebar-project-path-tooltip"
        role="tooltip"
        style={{ top: projectPathTooltip.top, left: projectPathTooltip.left }}
      >
        {projectPathTooltip.path}
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
        <button
          type="button"
          className="brand no-drag"
          data-nav="home"
          title={t("nav.home")}
          aria-label={t("nav.home")}
          onClick={() => setPage("chat")}
        >
          <BrandLogo size={20} />
          <span>{t("app.shellName")}</span>
        </button>
        <div className="sidebar-header-actions no-drag">
          <button
            type="button"
            className="icon-btn"
            title={t("nav.search")}
            aria-label={t("nav.search")}
            onClick={onOpenSearch}
          >
            <IconSearch size={15} />
          </button>
          <button
            type="button"
            className="icon-btn"
            title={`${t("nav.collapseSidebar")} (${sidebarToggleShortcut})`}
            aria-label={t("nav.collapseSidebar")}
            aria-expanded={true}
            data-nav="toggle-sidebar"
            onClick={onToggleSidebar}
          >
            <IconSidebar size={15} />
          </button>
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
                <button
                  type="button"
                  className={`sidebar-toolbar-button ${sortOpen ? "active" : ""}`}
                  data-action="session-sort"
                  aria-label={t("nav.sortSessions", { defaultValue: "Sort sessions" })}
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
                </button>
              </div>
              <button
                type="button"
                className="sidebar-toolbar-button"
                data-action="new-standalone-session"
                title={t("nav.newTemporarySession")}
                aria-label={t("nav.newTemporarySession")}
                onClick={() => void createSession({ projectPath: null })}
              >
                <IconNewSession size={14} />
              </button>
            </div>
          </div>
          <div
            className="sidebar-session-group-body standalone"
            onScroll={() => {
              window.clearTimeout(projectPathTimerRef.current);
              setProjectPathTooltip(null);
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
          <button
            type="button"
            className="sidebar-toolbar-button"
            data-action="new-project"
            title={t("nav.newProject")}
            aria-label={t("nav.newProject")}
            onClick={() => void openProjectPicker()}
          >
            <IconNewProject size={14} />
          </button>
        </div>

        <div
          className="sidebar-session-groups min-h-0 flex-1 overflow-auto px-0.5"
          onScroll={() => {
            window.clearTimeout(projectPathTimerRef.current);
            setProjectPathTooltip(null);
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
            <button
              type="button"
              className={`footer-action ${page === "settings" ? "active" : ""}`}
              data-nav="settings"
              title={t("nav.settings")}
              aria-label={t("nav.settings")}
              onClick={() => setPage("settings")}
            >
              <IconSettings size={14} aria-hidden />
            </button>
            <button
              type="button"
              className={`footer-action ${page === "plugins" ? "active" : ""}`}
              data-nav="plugins"
              title={t("nav.plugins")}
              aria-label={t("nav.plugins")}
              onClick={() => setPage("plugins")}
            >
              <IconPlug size={14} aria-hidden />
            </button>
            <NotificationCenter onBeforeOpen={() => closeMenus(false)} />
          </div>

          <button
            type="button"
            className={`footer-build ${updateReady ? "has-update" : ""}`}
            data-nav="build"
            title={buildTitle}
            aria-label={buildTitle}
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
          </button>
        </div>
      </div>
      {renderFloatingMenu()}
      {renderProjectPathTooltip()}
      {renameFor ? (
        <SessionRenameDialog
          session={renameFor}
          onClose={() => setRenameFor(null)}
          onSave={(title) => renameSession(renameFor.id, title)}
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
