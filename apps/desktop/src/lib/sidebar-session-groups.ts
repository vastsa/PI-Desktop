import type { SessionSummary } from "@pi-desktop/shared";

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
  session: Pick<SessionSummary, "projectPath">,
  projectPath?: string | null,
): boolean {
  return normalizeProjectPath(session.projectPath) === normalizeProjectPath(projectPath);
}

/** Return normalized project paths belonging to sessions added by a refresh. */
export function projectPathsForNewSessions(
  previousSessions: readonly Pick<SessionSummary, "id">[],
  nextSessions: readonly Pick<SessionSummary, "id" | "projectPath">[],
): string[] {
  const previousIds = new Set(previousSessions.map((session) => session.id));
  const paths = new Set<string>();
  for (const session of nextSessions) {
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
