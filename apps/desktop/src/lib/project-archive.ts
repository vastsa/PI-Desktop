import type { ProjectMeta } from "./sidebar-preferences.ts";
import { normalizeProjectPath } from "./sidebar-preferences.ts";
import { projectColor, type RecentProject } from "./recent-projects.ts";

export const INITIAL_VISIBLE_SESSION_COUNT = 8;

export type SortMode = "recent" | "name";

/**
 * Section order for the always-visible index. Archived records are grouped last
 * rather than hidden, so the archive never needs a visibility toggle (D133).
 */
export type GroupId = "pinned" | "projects" | "archived";

export const GROUP_ORDER: GroupId[] = ["pinned", "projects", "archived"];

export const GROUP_LABEL_KEYS: Record<GroupId, string> = {
  pinned: "project.groupPinned",
  projects: "project.groupProjects",
  archived: "project.groupArchived",
};

export type ProjectRoot = {
  path: string;
  name: string;
  position: number;
};

export type ProjectIndexItem = RecentProject & {
  groupId: string;
  roots: ProjectRoot[];
  legacy: boolean;
  archived?: boolean;
};

export type DurableProjectGroup = {
  id: string;
  name: string;
  primaryPath: string;
  roots: ProjectRoot[];
  lastOpenedAt: number;
  pinned: boolean;
  legacy?: boolean;
};

export type SessionIndexRecord = {
  id: string;
  title: string;
  projectPath?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SessionProjectSeed = {
  path: string;
  name: string;
  updatedAt: number;
};

export type WorkspaceSeed = {
  path: string;
  name?: string;
  branch?: string | null;
};

export function shortenPath(path: string) {
  return path.replace(/^\/(?:Users|home)\/[^/]+/, "~");
}

export function sessionTimestamp(value: string): number {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function formatUpdated(ts?: number, locale?: string, neverLabel = "—") {
  if (!ts) return neverLabel;
  try {
    const elapsed = Date.now() - ts;
    const minutes = Math.round(elapsed / 60_000);
    if (minutes < 60 * 24 * 7) {
      const rtf = new Intl.RelativeTimeFormat(locale || undefined, {
        numeric: "auto",
      });
      if (minutes < 60) return rtf.format(-Math.max(minutes, 0), "minute");
      if (minutes < 60 * 24) return rtf.format(-Math.round(minutes / 60), "hour");
      return rtf.format(-Math.round(minutes / (60 * 24)), "day");
    }
    const sameYear = new Date(ts).getFullYear() === new Date().getFullYear();
    return new Intl.DateTimeFormat(locale || undefined, {
      month: "short",
      day: "numeric",
      year: sameYear ? undefined : "numeric",
    }).format(new Date(ts));
  } catch {
    return neverLabel;
  }
}

export function sessionMatchesQuery(
  session: Pick<SessionIndexRecord, "id" | "title">,
  query: string,
) {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return (
    !normalizedQuery ||
    session.title.toLocaleLowerCase().includes(normalizedQuery) ||
    session.id.toLocaleLowerCase().includes(normalizedQuery)
  );
}

export function sessionMatchesIndexProject(
  session: Pick<SessionIndexRecord, "projectPath">,
  project: Pick<ProjectIndexItem, "roots" | "path">,
) {
  const sessionPath = normalizeProjectPath(session.projectPath);
  return Boolean(
    sessionPath &&
      project.roots.some((root) => normalizeProjectPath(root.path) === sessionPath),
  );
}

export function projectMatchesQuery(project: ProjectIndexItem, query: string) {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return true;
  return (
    project.name.toLocaleLowerCase().includes(normalizedQuery) ||
    project.path.toLocaleLowerCase().includes(normalizedQuery) ||
    (project.branch || "").toLocaleLowerCase().includes(normalizedQuery)
  );
}

export function projectBucket(project: ProjectIndexItem): GroupId {
  if (project.archived === true) return "archived";
  if (project.pinned) return "pinned";
  return "projects";
}

/**
 * Row state of one project. Archived outranks both live states so a record can
 * never read as "active" while it sits in the Archived group, and the live
 * workspace outranks a merely retained project. `null` is a plain project.
 */
export type ProjectStatus = "active" | "open" | "archived";

export const PROJECT_STATUS_LABEL_KEYS: Record<ProjectStatus, string> = {
  active: "project.active",
  open: "project.openTag",
  archived: "project.archivedTag",
};

export function projectStatus(args: {
  project: Pick<ProjectIndexItem, "path" | "archived">;
  workspacePath?: string | null;
  openProjectPaths: readonly string[];
}): ProjectStatus | null {
  const { project, workspacePath, openProjectPaths } = args;
  if (project.archived === true) return "archived";
  if (normalizeProjectPath(workspacePath) === normalizeProjectPath(project.path)) {
    return "active";
  }
  if (
    openProjectPaths.some(
      (path) => normalizeProjectPath(path) === normalizeProjectPath(project.path),
    )
  ) {
    return "open";
  }
  return null;
}

/**
 * One row click, resolved: the row whose card is already open closes it, and
 * any other row opens its card. There is no separate selection to keep — the
 * open card *is* the current row — so nothing is expanded until the user asks
 * for it, and the disclosure indicator can mean exactly what it shows.
 */
export function nextArchiveOpenPath(
  openPath: string | null,
  clickedPath: string,
): string | null {
  return openPath === clickedPath ? null : clickedPath;
}

export function compareProjects(
  a: ProjectIndexItem,
  b: ProjectIndexItem,
  sort: SortMode,
  locale?: string,
) {
  if (sort === "name") {
    return (
      a.name.localeCompare(b.name, locale || undefined) || a.path.localeCompare(b.path)
    );
  }
  return b.openedAt - a.openedAt || a.path.localeCompare(b.path);
}

export function groupArchiveRows(
  filtered: readonly ProjectIndexItem[],
  sort: SortMode,
  locale?: string,
) {
  const buckets: Record<GroupId, ProjectIndexItem[]> = {
    pinned: [],
    projects: [],
    archived: [],
  };
  for (const project of filtered) buckets[projectBucket(project)].push(project);
  for (const id of GROUP_ORDER) {
    buckets[id].sort((a, b) => compareProjects(a, b, sort, locale));
  }
  return GROUP_ORDER.map((id) => ({ id, rows: buckets[id] })).filter(
    (group) => group.rows.length > 0,
  );
}

export function countProjectSessions(
  items: readonly ProjectIndexItem[],
  sessions: readonly SessionIndexRecord[],
) {
  const counts = new Map<string, number>();
  for (const project of items) {
    let matched = 0;
    for (const session of sessions) {
      if (sessionMatchesIndexProject(session, project)) matched += 1;
    }
    counts.set(project.path, matched);
  }
  return counts;
}

export function filterArchiveItems(
  items: readonly ProjectIndexItem[],
  sessions: readonly SessionIndexRecord[],
  query: string,
) {
  const q = query.trim();
  if (!q) return [...items];
  return items.filter(
    (project) =>
      projectMatchesQuery(project, q) ||
      sessions.some(
        (session) =>
          sessionMatchesIndexProject(session, project) && sessionMatchesQuery(session, q),
      ),
  );
}

export function relatedProjectSessions(
  sessions: readonly SessionIndexRecord[],
  project: Pick<ProjectIndexItem, "roots" | "path">,
) {
  return sessions
    .filter((session) => sessionMatchesIndexProject(session, project))
    .sort(
      (a, b) =>
        sessionTimestamp(b.updatedAt) - sessionTimestamp(a.updatedAt) ||
        sessionTimestamp(b.createdAt) - sessionTimestamp(a.createdAt) ||
        a.title.localeCompare(b.title) ||
        a.id.localeCompare(b.id),
    );
}

export function displayedProjectSessions(
  sessions: readonly SessionIndexRecord[],
  project: ProjectIndexItem,
  query: string,
) {
  const related = relatedProjectSessions(sessions, project);
  const matching = related.filter((session) => sessionMatchesQuery(session, query));
  const sessionSearchMatch = !projectMatchesQuery(project, query) && matching.length > 0;
  return {
    related,
    displayed: sessionSearchMatch ? matching : related,
    sessionSearchMatch,
  };
}

/**
 * The row `delta` steps from `currentPath` in the rendered order, clamped to
 * the ends. With no row current yet the first press lands on the first row
 * whichever way it points, so an arrow key always has somewhere to go.
 */
export function neighborPath(
  filtered: readonly ProjectIndexItem[],
  currentPath: string | null,
  delta: number,
) {
  if (filtered.length === 0) return null;
  const index = filtered.findIndex((project) => project.path === currentPath);
  const from = index >= 0 ? index : delta > 0 ? -1 : 0;
  const next = Math.min(filtered.length - 1, Math.max(0, from + delta));
  return filtered[next]?.path ?? null;
}

export function buildProjectIndex(args: {
  durableProjects: readonly DurableProjectGroup[];
  recents: readonly RecentProject[];
  sessionProjects: readonly SessionProjectSeed[];
  workspace?: WorkspaceSeed | null;
  projectMeta: Record<string, ProjectMeta>;
}): ProjectIndexItem[] {
  const { durableProjects, recents, sessionProjects, workspace, projectMeta } = args;
  const byPath = new Map<string, ProjectIndexItem>();
  const addGroup = (group: DurableProjectGroup, openedAt = group.lastOpenedAt) => {
    const key = normalizeProjectPath(group.primaryPath);
    if (!key) return;
    const existing = byPath.get(key);
    byPath.set(key, {
      path: group.primaryPath,
      name: group.name,
      openedAt: Math.max(existing?.openedAt ?? 0, openedAt),
      pinned: group.pinned,
      color: existing?.color ?? projectColor(group.primaryPath),
      groupId: group.id,
      roots: group.roots,
      legacy: group.legacy === true,
    });
  };
  const groupForPath = (path: string) => {
    const key = normalizeProjectPath(path);
    return durableProjects.find((group) =>
      group.roots.some((root) => normalizeProjectPath(root.path) === key),
    );
  };

  for (const group of durableProjects) addGroup(group);

  for (const project of recents) {
    const group = groupForPath(project.path);
    if (group) {
      addGroup(group, project.openedAt);
      continue;
    }
    const key = normalizeProjectPath(project.path);
    if (!key) continue;
    const existing = byPath.get(key);
    byPath.set(key, {
      path: existing?.path ?? project.path,
      name: existing?.name ?? project.name,
      branch: existing?.branch ?? project.branch,
      openedAt: Math.max(existing?.openedAt ?? 0, project.openedAt),
      pinned: project.pinned ?? existing?.pinned,
      color: existing?.color ?? project.color ?? projectColor(project.path),
      groupId: existing?.groupId ?? `legacy:${key}`,
      roots: existing?.roots ?? [{ path: project.path, name: project.name, position: 0 }],
      legacy: existing?.legacy ?? true,
    });
  }

  for (const project of sessionProjects) {
    const group = groupForPath(project.path);
    if (group) {
      addGroup(group, project.updatedAt);
      continue;
    }
    const key = normalizeProjectPath(project.path);
    if (!key) continue;
    const existing = byPath.get(key);
    byPath.set(key, {
      path: existing?.path ?? project.path,
      name: existing?.name ?? project.name,
      branch: existing?.branch,
      openedAt: Math.max(existing?.openedAt ?? 0, project.updatedAt),
      pinned: existing?.pinned,
      color: existing?.color ?? projectColor(project.path),
      groupId: existing?.groupId ?? `legacy:${key}`,
      roots: existing?.roots ?? [{ path: project.path, name: project.name, position: 0 }],
      legacy: existing?.legacy ?? true,
    });
  }

  if (workspace?.path) {
    const group = groupForPath(workspace.path);
    if (group) addGroup(group, Date.now());
    else {
      const key = normalizeProjectPath(workspace.path);
      if (key) {
        const existing = byPath.get(key);
        byPath.set(key, {
          path: workspace.path,
          name: workspace.name || existing?.name || workspace.path,
          branch: workspace.branch || existing?.branch,
          openedAt: Math.max(existing?.openedAt ?? 0, Date.now()),
          pinned: existing?.pinned,
          color: existing?.color ?? projectColor(workspace.path),
          groupId: existing?.groupId ?? `legacy:${key}`,
          roots:
            existing?.roots ?? [
              { path: workspace.path, name: workspace.name || workspace.path, position: 0 },
            ],
          legacy: existing?.legacy ?? true,
        });
      }
    }
  }

  return [...byPath.values()]
    .map((project) => {
      const meta = projectMeta[normalizeProjectPath(project.path) || project.path] ?? {};
      return {
        ...project,
        name: meta.name ?? project.name,
        pinned: meta.pinned ?? project.pinned,
        archived: meta.archived === true,
      };
    })
    .sort(
      (a, b) =>
        Number(!!b.pinned) - Number(!!a.pinned) ||
        b.openedAt - a.openedAt ||
        a.path.localeCompare(b.path),
    );
}
