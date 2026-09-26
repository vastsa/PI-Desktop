import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { SessionSummary } from "@pi-desktop/shared";
import { isDefaultSessionTitle, useAppStore } from "../../stores/app-store";
import {
  getGlobalPinnedSessions,
  normalizeProjectPath,
  sessionArchived,
  sessionPinned,
} from "../../lib/sidebar-session-groups";
import type { ProjectMeta, ProjectSort, SessionSort } from "../../lib/sidebar-preferences";

export type ProjectEntry = {
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

export function projectName(path: string, fallback?: string) {
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

export function projectMetaFor(
  path: string,
  projectMeta: Record<string, ProjectMeta>,
): ProjectMeta {
  return projectMeta[normalizeProjectPath(path) || path] ?? projectMeta[path] ?? {};
}

function firstSessionDate(
  sessions: SessionSummary[],
  field: "createdAt" | "updatedAt",
): number | null {
  const values = sessions.map((session) => timestamp(session[field])).filter((value) => value > 0);
  return values.length ? Math.min(...values) : null;
}

function lastSessionDate(
  sessions: SessionSummary[],
  field: "createdAt" | "updatedAt",
): number | null {
  const values = sessions.map((session) => timestamp(session[field])).filter((value) => value > 0);
  return values.length ? Math.max(...values) : null;
}

function compareOptionalDate(a: number | null, b: number | null, descending: boolean): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return descending ? b - a : a - b;
}

/** Shared ordering also determines which conversation replaces an archived/deleted one. */
export function useSessionNavigation() {
  const { t } = useTranslation();
  const sessions = useAppStore((s) => s.sessions);
  const workspace = useAppStore((s) => s.workspace);
  const openProjects = useAppStore((s) => s.openProjects);
  const projectMeta = useAppStore((s) => s.projectMeta);
  const sessionMeta = useAppStore((s) => s.sessionMeta);
  const sessionView = useAppStore((s) => s.sessionView);
  const projectSort = useAppStore((s) => s.projectSort);
  const openProjectPathsState = useAppStore((s) => s.openProjectPaths);
  const activeProjectPathState = useAppStore((s) => s.activeProjectPath);
  const showArchived = sessionView.archived;
  const sessionSort = sessionView.sort;
  const displaySessionSort: Exclude<SessionSort, "manual"> =
    sessionSort === "manual" ? "recent" : sessionSort;
  const displayProjectSort: ProjectSort = projectSort;
  const activeProjectPath = normalizeProjectPath(activeProjectPathState ?? workspace?.path);
  const openProjectPaths = useMemo(
    () =>
      openProjectPathsState
        .map((path) => normalizeProjectPath(path))
        .filter((path): path is string => Boolean(path)),
    [openProjectPathsState],
  );

  const taskTitle = useCallback(
    (title?: string | null) => {
      const value = (title || "").trim();
      return isDefaultSessionTitle(value) ? t("chat.untitledTask") : value;
    },
    [t],
  );

  const filtered = useMemo(() => {
    const candidates = showArchived
      ? sessions
      : sessions.filter((session) => !sessionArchived(session, sessionMeta[session.id]));
    // Empty sessions are durable sidebar rows now. Their message count, not
    // their title, controls New Task reuse, so a manual rename never changes
    // the empty-slot behavior.
    return candidates;
  }, [sessions, showArchived, sessionMeta]);

  const compareSessions = useCallback(
    (a: SessionSummary, b: SessionSummary) => {
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
    },
    [displaySessionSort, sessionMeta, taskTitle],
  );

  const pinnedSessions = useMemo(
    () =>
      getGlobalPinnedSessions(filtered, sessionMeta, projectMeta, showArchived).sort(
        compareSessions,
      ),
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
      const record = openProjects.find((project) => normalizeProjectPath(project.path) === path);
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
    const result = [...byPath.values()].filter((entry) => showArchived || !entry.meta.archived);
    for (const entry of result) entry.sessions.sort(compareSessions);
    result.sort((a, b) => {
      const archiveOrder = Number(!!a.meta.archived) - Number(!!b.meta.archived);
      if (archiveOrder !== 0) return archiveOrder;
      const pinOrder = Number(!!b.meta.pinned) - Number(!!a.meta.pinned);
      if (pinOrder !== 0) return pinOrder;
      if (displayProjectSort === "manual") {
        const byOrder =
          (a.meta.order ?? Number.MAX_SAFE_INTEGER) - (b.meta.order ?? Number.MAX_SAFE_INTEGER);
        if (byOrder !== 0) return byOrder;
      } else if (displayProjectSort === "name") {
        const byName = a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
        if (byName !== 0) return byName;
      } else if (displayProjectSort === "oldest" || displayProjectSort === "created") {
        const dateForProject = displayProjectSort === "oldest" ? firstSessionDate : lastSessionDate;
        const aCreated = dateForProject(a.sessions, "createdAt");
        const bCreated = dateForProject(b.sessions, "createdAt");
        const byCreated = compareOptionalDate(aCreated, bCreated, displayProjectSort === "created");
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
    () =>
      filtered
        .filter((session) => !normalizeProjectPath(session.projectPath))
        .sort(compareSessions),
    [filtered, compareSessions],
  );
  return { projectEntries, temporarySessions, pinnedSessions, pinnedSessionIds, taskTitle };
}
