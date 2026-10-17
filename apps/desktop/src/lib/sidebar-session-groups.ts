import type { SessionSummary } from "@pi-desktop/shared";
import { isRemoteSession } from "./remote-session-safety.ts";
import type { ProjectMeta, SessionMeta } from "./sidebar-preferences";

export function normalizeProjectPath(projectPath?: string | null): string | null {
  const value = projectPath?.trim();
  if (!value) return null;

  let normalized = value.replace(/\\/g, "/");
  // Strip the Windows extended-length prefix (`//?/C:/...` → `C:/...`)
  if (/^\/\/\?\/[A-Za-z]:\//.test(normalized)) {
    normalized = normalized.slice(4);
  }
  // Remove trailing slashes but keep the one after a drive letter (e.g. `C:/`)
  normalized = normalized.replace(/(?<![A-Za-z]:)\/+$/, "");
  return normalized || "/";
}

export function sessionMatchesProject(
  session: Pick<SessionSummary, "projectPath"> & Partial<Pick<SessionSummary, "source" | "id">>,
  projectPath?: string | null,
): boolean {
  if (session.source === "remote" || session.id?.startsWith("remote:")) return false;
  return normalizeProjectPath(session.projectPath) === normalizeProjectPath(projectPath);
}

/** Return normalized project paths belonging to sessions added by a refresh. */
export function projectPathsForNewSessions(
  previousSessions: readonly Pick<SessionSummary, "id">[],
  nextSessions: readonly (Pick<SessionSummary, "id" | "projectPath"> & Partial<Pick<SessionSummary, "source">>)[],
): string[] {
  const previousIds = new Set(previousSessions.map((session) => session.id));
  const paths = new Set<string>();
  for (const session of nextSessions) {
    if (isRemoteSession(session)) continue;
    if (previousIds.has(session.id)) continue;
    const path = normalizeProjectPath(session.projectPath);
    if (path) paths.add(path);
  }
  return [...paths];
}

export function groupSidebarSessions(
  sessions: SessionSummary[],
  projectPath?: string | null,
): {
  projectSessions: SessionSummary[];
  temporarySessions: SessionSummary[];
} {
  const normalizedProjectPath = normalizeProjectPath(projectPath);

  return {
    projectSessions: normalizedProjectPath
      ? sessions.filter(
          (session) => normalizeProjectPath(session.projectPath) === normalizedProjectPath,
        )
      : [],
    temporarySessions: sessions.filter(
      (session) => normalizeProjectPath(session.projectPath) === null,
    ),
  };
}

export function sessionArchived(session: SessionSummary, meta: SessionMeta | undefined): boolean {
  return Boolean(meta?.archived || (session as SessionSummary & { archived?: boolean }).archived);
}

export function sessionPinned(session: SessionSummary, meta: SessionMeta | undefined): boolean {
  return Boolean(meta?.pinned || (session as SessionSummary & { pinned?: boolean }).pinned);
}

/** Pins are global shortcuts; project retention and dates do not limit discovery. */
export function getGlobalPinnedSessions(
  sessions: SessionSummary[],
  sessionMeta: Record<string, SessionMeta>,
  projectMeta: Record<string, ProjectMeta>,
  showArchived: boolean,
): SessionSummary[] {
  return sessions.filter((session) => {
    if (!sessionPinned(session, sessionMeta[session.id])) return false;
    const path = normalizeProjectPath(session.projectPath);
    const project = path ? (projectMeta[path] ?? projectMeta[session.projectPath!]) : undefined;
    return (
      showArchived || (!sessionArchived(session, sessionMeta[session.id]) && !project?.archived)
    );
  });
}
