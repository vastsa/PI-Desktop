import type { ProjectWorkspace, SessionSummary } from "@pi-desktop/shared";

/** Local copy keeps this pure module runnable in Node's TS test loader. */
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

export type SessionSort = "recent" | "created" | "oldest" | "name" | "manual";
export type ProjectSort = "recent" | "created" | "oldest" | "name" | "manual";
export type SessionMeta = { pinned?: boolean; archived?: boolean; order?: number };
export type ProjectMeta = {
  pinned?: boolean;
  archived?: boolean;
  collapsed?: boolean;
  order?: number;
};
export type SidebarPreferences = {
  sessionMeta: Record<string, SessionMeta>;
  projectMeta: Record<string, ProjectMeta>;
  projectSort: ProjectSort;
  sessionView: { sort: SessionSort; archived: boolean };
  openProjectPaths: string[];
};

export const SIDEBAR_PREFERENCES_KEY = "pi.desktop.sidebarPreferences";
export const SIDEBAR_WIDTH_KEY = "pi.desktop.sidebarWidth";
export const SIDEBAR_WIDTH_MIN = 240;
export const SIDEBAR_WIDTH_DEFAULT = 275;
export const SIDEBAR_WIDTH_MAX = 520;

export function clampSidebarWidth(value: number): number {
  if (!Number.isFinite(value)) return SIDEBAR_WIDTH_DEFAULT;
  return Math.round(Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, value)));
}

function storage(): Storage | null {
  try {
    return typeof globalThis !== "undefined" && "localStorage" in globalThis
      ? globalThis.localStorage
      : null;
  } catch {
    return null;
  }
}
function read(key: string): unknown {
  const store = storage();
  if (!store) return undefined;
  try {
    const value = store.getItem(key);
    return value ? JSON.parse(value) : undefined;
  } catch {
    return undefined;
  }
}
function write(key: string, value: unknown): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(key, JSON.stringify(value));
  } catch {
    // Preferences are best effort and must never block the app.
  }
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function bool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}
function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function cleanSessionMeta(value: unknown): Record<string, SessionMeta> {
  if (!object(value)) return {};
  const output: Record<string, SessionMeta> = {};
  for (const [id, raw] of Object.entries(value)) {
    if (!id || !object(raw)) continue;
    const item: SessionMeta = {};
    const pinned = bool(raw.pinned);
    const archived = bool(raw.archived);
    const order = number(raw.order);
    if (pinned !== undefined) item.pinned = pinned;
    if (archived !== undefined) item.archived = archived;
    if (order !== undefined) item.order = order;
    if (Object.keys(item).length) output[id] = item;
  }
  return output;
}
function cleanProjectMeta(value: unknown): Record<string, ProjectMeta> {
  if (!object(value)) return {};
  const output: Record<string, ProjectMeta> = {};
  for (const [rawPath, raw] of Object.entries(value)) {
    const path = normalizeProjectPath(rawPath);
    if (!path || !object(raw)) continue;
    const item: ProjectMeta = {};
    const pinned = bool(raw.pinned);
    const archived = bool(raw.archived);
    const collapsed = bool(raw.collapsed);
    const order = number(raw.order);
    if (pinned !== undefined) item.pinned = pinned;
    if (archived !== undefined) item.archived = archived;
    if (collapsed !== undefined) item.collapsed = collapsed;
    if (order !== undefined) item.order = order;
    if (Object.keys(item).length) output[path] = item;
  }
  return output;
}
function cleanPaths(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const output: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const path = normalizeProjectPath(item);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    output.push(item.trim());
  }
  return output;
}
function sessionSort(value: unknown): SessionSort {
  return value === "created" || value === "oldest" || value === "name" || value === "manual"
    ? value
    : "recent";
}
function projectSort(value: unknown): ProjectSort {
  return value === "created" || value === "oldest" || value === "name" || value === "manual"
    ? value
    : "recent";
}

export function loadSidebarPreferences(): SidebarPreferences {
  const raw = read(SIDEBAR_PREFERENCES_KEY);
  const root = object(raw) ? raw : {};
  const view = object(root.sessionView) ? root.sessionView : {};
  const result: SidebarPreferences = {
    sessionMeta: cleanSessionMeta(root.sessionMeta),
    projectMeta: cleanProjectMeta(root.projectMeta),
    projectSort: projectSort(root.projectSort),
    sessionView: {
      sort: sessionSort(view.sort),
      archived:
        typeof view.archived === "boolean"
          ? view.archived
          : typeof view.showArchived === "boolean"
            ? view.showArchived
            : false,
    },
    openProjectPaths: cleanPaths(root.openProjectPaths),
  };
  // Migrate the old pin-only preferences once. Do not re-apply them after
  // the new record has been written, otherwise an explicit unpin is lost.
  if (!object(raw)) {
    const oldSessionPins = read("pi.desktop.pinnedSessions");
    if (Array.isArray(oldSessionPins)) {
      for (const id of oldSessionPins) {
        if (typeof id === "string" && id) {
          result.sessionMeta[id] = { ...result.sessionMeta[id], pinned: true };
        }
      }
    }
    const oldProjectPins = read("pi.desktop.pinnedProjects");
    if (Array.isArray(oldProjectPins)) {
      for (const rawPath of oldProjectPins) {
        if (typeof rawPath !== "string") continue;
        const path = normalizeProjectPath(rawPath);
        if (path) result.projectMeta[path] = { ...result.projectMeta[path], pinned: true };
      }
    }
  }
  return result;
}

export function saveSidebarPreferences(value: SidebarPreferences): void {
  write(SIDEBAR_PREFERENCES_KEY, {
    sessionMeta: cleanSessionMeta(value.sessionMeta),
    projectMeta: cleanProjectMeta(value.projectMeta),
    projectSort: projectSort(value.projectSort),
    sessionView: {
      sort: sessionSort(value.sessionView.sort),
      archived: value.sessionView.archived === true,
    },
    openProjectPaths: cleanPaths(value.openProjectPaths),
  });
}

export function loadSidebarWidth(): number {
  const value = read(SIDEBAR_WIDTH_KEY);
  return typeof value === "number" ? clampSidebarWidth(value) : SIDEBAR_WIDTH_DEFAULT;
}

export function saveSidebarWidth(value: number): void {
  write(SIDEBAR_WIDTH_KEY, clampSidebarWidth(value));
}

export function sessionIsPinned(id: string, meta: Record<string, SessionMeta>): boolean {
  return meta[id]?.pinned === true;
}
export function sessionIsArchived(id: string, meta: Record<string, SessionMeta>): boolean {
  return meta[id]?.archived === true;
}
export function projectIsPinned(path: string, meta: Record<string, ProjectMeta>): boolean {
  const key = normalizeProjectPath(path);
  return !!key && meta[key]?.pinned === true;
}
export function projectIsArchived(path: string, meta: Record<string, ProjectMeta>): boolean {
  const key = normalizeProjectPath(path);
  return !!key && meta[key]?.archived === true;
}
export function projectIsCollapsed(path: string, meta: Record<string, ProjectMeta>): boolean {
  const key = normalizeProjectPath(path);
  return !!key && meta[key]?.collapsed === true;
}
function timestamp(value?: string): number {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

export function sortSessions(
  sessions: SessionSummary[],
  meta: Record<string, SessionMeta>,
  sort: SessionSort = "recent",
  includeArchived = false,
): SessionSummary[] {
  const rows = includeArchived
    ? sessions
    : sessions.filter((session) => !sessionIsArchived(session.id, meta));
  return [...rows].sort((a, b) => {
    const archived = Number(sessionIsArchived(a.id, meta)) - Number(sessionIsArchived(b.id, meta));
    if (archived) return archived;
    const pinned = Number(sessionIsPinned(b.id, meta)) - Number(sessionIsPinned(a.id, meta));
    if (pinned) return pinned;
    if (sort === "name") {
      const byName = a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
      if (byName) return byName;
    } else if (sort === "created") {
      const byCreated = compareOptionalNumber(
        timestamp(a.createdAt) || undefined,
        timestamp(b.createdAt) || undefined,
        true,
      );
      if (byCreated) return byCreated;
    } else if (sort === "oldest") {
      const byCreated = compareOptionalNumber(
        timestamp(a.createdAt) || undefined,
        timestamp(b.createdAt) || undefined,
        false,
      );
      if (byCreated) return byCreated;
    } else if (sort === "manual") {
      const byOrder = (meta[a.id]?.order ?? Number.MAX_SAFE_INTEGER) -
        (meta[b.id]?.order ?? Number.MAX_SAFE_INTEGER);
      if (byOrder) return byOrder;
    } else {
      const byUpdated = compareOptionalNumber(
        timestamp(a.updatedAt) || undefined,
        timestamp(b.updatedAt) || undefined,
        true,
      );
      if (byUpdated) return byUpdated;
    }
    return compareOptionalNumber(
      timestamp(a.updatedAt) || undefined,
      timestamp(b.updatedAt) || undefined,
      true,
    ) || a.id.localeCompare(b.id);
  });
}

export type SidebarProject = Pick<ProjectWorkspace, "path" | "name" | "branch"> & {
  openedAt?: number;
  createdAt?: number;
};
function compareOptionalNumber(
  a: number | undefined,
  b: number | undefined,
  descending: boolean,
): number {
  const hasA = typeof a === "number" && Number.isFinite(a);
  const hasB = typeof b === "number" && Number.isFinite(b);
  if (!hasA && !hasB) return 0;
  if (!hasA) return 1;
  if (!hasB) return -1;
  return descending ? (b as number) - (a as number) : (a as number) - (b as number);
}
export function sortProjects<T extends SidebarProject>(
  projects: T[],
  meta: Record<string, ProjectMeta>,
  sort: ProjectSort = "recent",
): T[] {
  return [...projects].sort((a, b) => {
    const pinned = Number(projectIsPinned(b.path, meta)) - Number(projectIsPinned(a.path, meta));
    if (pinned) return pinned;
    const ak = normalizeProjectPath(a.path) || a.path;
    const bk = normalizeProjectPath(b.path) || b.path;
    if (sort === "name") {
      const byName = (a.name || a.path).localeCompare(b.name || b.path, undefined, {
        sensitivity: "base",
      });
      if (byName) return byName;
    } else if (sort === "created") {
      const byCreated = compareOptionalNumber(a.createdAt, b.createdAt, true);
      if (byCreated) return byCreated;
    } else if (sort === "oldest") {
      const byCreated = compareOptionalNumber(a.createdAt, b.createdAt, false);
      if (byCreated) return byCreated;
    } else if (sort === "manual") {
      const byOrder = (meta[ak]?.order ?? Number.MAX_SAFE_INTEGER) -
        (meta[bk]?.order ?? Number.MAX_SAFE_INTEGER);
      if (byOrder) return byOrder;
    } else {
      const byOpened = compareOptionalNumber(a.openedAt, b.openedAt, true);
      if (byOpened) return byOpened;
    }
    return ak.localeCompare(bk, undefined, { sensitivity: "base" });
  });
}
export function projectWorkspaceFromPath(path: string): ProjectWorkspace {
  const normalized = normalizeProjectPath(path) || path;
  const parts = normalized.split("/").filter(Boolean);
  return { path, name: parts[parts.length - 1] || path };
}
