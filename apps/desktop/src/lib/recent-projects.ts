export type RecentProject = {
  path: string;
  name: string;
  branch?: string;
  openedAt: number;
  pinned?: boolean;
  color?: string;
};

const KEY = "pi.desktop.recentProjects";
const MAX = 24;

const COLORS = ["#6b6b6b", "#5d5d5d", "#4f4f4f", "#414141", "#383838", "#303030"];

function normalizedProjectPath(path: string): string {
  const normalized = path.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized || "/";
}

export function projectColor(path: string): string {
  let h = 0;
  for (let i = 0; i < path.length; i++) h = (h * 31 + path.charCodeAt(i)) >>> 0;
  return COLORS[h % COLORS.length];
}

export function loadRecentProjects(): RecentProject[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as RecentProject[];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((p) => p && typeof p.path === "string" && typeof p.name === "string")
      .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.openedAt - a.openedAt);
  } catch {
    return [];
  }
}

export function rememberProject(input: {
  path: string;
  name: string;
  branch?: string | null;
}): RecentProject[] {
  const list = loadRecentProjects().filter((p) => p.path !== input.path);
  const prev = loadRecentProjects().find((p) => p.path === input.path);
  list.unshift({
    path: input.path,
    name: input.name,
    branch: input.branch || undefined,
    openedAt: Date.now(),
    pinned: prev?.pinned,
    color: prev?.color || projectColor(input.path),
  });
  const next = list.slice(0, MAX);
  localStorage.setItem(KEY, JSON.stringify(next));
  return next;
}

export function setProjectPinned(path: string, pinned: boolean): RecentProject[] {
  const next = loadRecentProjects().map((p) => (p.path === path ? { ...p, pinned } : p));
  next.sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.openedAt - a.openedAt);
  localStorage.setItem(KEY, JSON.stringify(next));
  return next;
}

export function renameRecentProject(path: string, name: string): RecentProject[] {
  const key = normalizedProjectPath(path);
  const next = loadRecentProjects().map((project) => {
    const projectKey = normalizedProjectPath(project.path);
    return projectKey === key ? { ...project, name } : project;
  });
  localStorage.setItem(KEY, JSON.stringify(next));
  return next;
}

export function removeRecentProject(path: string): RecentProject[] {
  const next = loadRecentProjects().filter((p) => p.path !== path);
  localStorage.setItem(KEY, JSON.stringify(next));
  return next;
}
