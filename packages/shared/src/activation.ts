/**
 * Activation scope: where an extension is allowed to run.
 *
 * Plugins, user MCP servers and user skills all answer the same two questions —
 * is it on at all, and does it apply to the project in front of me. Keeping one
 * shape for both answers means the three kinds share a single control in the UI,
 * a single filter in Electron main and a single serialized form in host-core.
 *
 * `enabled` is the master switch and lives next to the scope on each record, so
 * turning an extension off never loses the project list it was scoped to.
 */

export type ActivationMode = "global" | "projects";

export type ActivationScope = {
  mode: ActivationMode;
  /**
   * Absolute project paths this extension is limited to. Only read when
   * `mode === "projects"`; kept when the mode changes so toggling back restores
   * the previous selection.
   */
  projects: string[];
};

/** What the UI shows on the three-state control. */
export type ActivationState = "off" | "projects" | "global";

/** Default for anything installed before scopes existed, and for new installs. */
export const GLOBAL_SCOPE: ActivationScope = { mode: "global", projects: [] };

/** Anything carrying an activation decision: plugin, MCP server, user skill. */
export type Activatable = {
  enabled: boolean;
  scope?: ActivationScope;
};

/**
 * Storage spelling of a project path: forward slashes, no trailing separator.
 *
 * Mirrors `normalize_project_path` in host-core's `db.rs` so a path chosen in
 * the scope picker compares equal to the one recorded in the `projects` table.
 */
export function normalizeProjectPath(path: string | null | undefined): string {
  const trimmed = (path ?? "").trim();
  if (!trimmed) return "";
  let normalized = trimmed.replace(/\\/g, "/");
  while (normalized.length > 1 && normalized.endsWith("/") && !normalized.endsWith(":/")) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

const scopePlatform = typeof process !== "undefined"
  ? process.platform
  : typeof navigator !== "undefined" && /^Linux\b/.test(navigator.platform) ? "linux" : undefined;

/** Project identity for scope selection, storage and dispatch. Linux case variants are distinct. */
export function scopeProjectKey(path: string | null | undefined, platform: string | undefined = scopePlatform): string {
  const normalized = normalizeProjectPath(path);
  return platform === "linux" ? normalized : normalized.toLowerCase();
}

/**
 * True when `child` is `parent` or sits underneath it.
 *
 * Scoping a plugin to a monorepo root should cover sessions opened on a package
 * inside it — the alternative is asking the user to list every subdirectory.
 */
export function projectPathMatches(entry: string, projectPath: string, platform?: string): boolean {
  const scoped = scopeProjectKey(entry, platform);
  const target = scopeProjectKey(projectPath, platform);
  if (!scoped || !target) return false;
  const prefix = scoped.endsWith("/") ? scoped : `${scoped}/`;
  return target === scoped || target.startsWith(prefix);
}

/** Normalize a possibly-missing scope from storage into a usable one. */
export function resolveScope(
  scope: ActivationScope | undefined | null,
  platform?: string,
): ActivationScope {
  if (!scope || (scope.mode !== "global" && scope.mode !== "projects")) return GLOBAL_SCOPE;
  const projects = Array.isArray(scope.projects) ? scope.projects : [];
  const seen = new Set<string>();
  const cleaned: string[] = [];
  for (const raw of projects) {
    const path = normalizeProjectPath(typeof raw === "string" ? raw : "");
    if (!path) continue;
    const key = scopeProjectKey(path, platform);
    if (seen.has(key)) continue;
    seen.add(key);
    cleaned.push(path);
  }
  return { mode: scope.mode, projects: cleaned };
}

/**
 * Whether the extension applies to a session opened on `projectPath`.
 *
 * A project-scoped extension is inactive in a session with no project at all:
 * "these projects" is a statement about projects, and a chat with no workspace
 * is not one of them.
 */
export function isActiveInProject(
  item: Activatable,
  projectPath: string | null | undefined,
  platform?: string,
): boolean {
  if (!item.enabled) return false;
  const scope = resolveScope(item.scope, platform);
  if (scope.mode === "global") return true;
  return projectPath != null &&
    scope.projects.some((entry) => projectPathMatches(entry, projectPath, platform));
}

/** Collapse `enabled` + scope into the value the three-state control renders. */
export function activationState(item: Activatable): ActivationState {
  if (!item.enabled) return "off";
  return item.scope?.mode === "projects" ? "projects" : "global";
}

/**
 * Add a project to a scope, switching it to project mode.
 *
 * Returns the same array identity semantics as `resolveScope`: always a fresh
 * object, so callers can compare before writing.
 */
export function withProject(
  scope: ActivationScope | undefined,
  projectPath: string,
  platform?: string,
): ActivationScope {
  const current = resolveScope(scope, platform);
  const path = normalizeProjectPath(projectPath);
  if (!path) return { mode: "projects", projects: current.projects };
  const key = scopeProjectKey(path, platform);
  const exists = current.projects.some((entry) => scopeProjectKey(entry, platform) === key);
  return {
    mode: "projects",
    projects: exists ? current.projects : [...current.projects, path],
  };
}

/** Remove a project from a scope, leaving the mode alone. */
export function withoutProject(
  scope: ActivationScope | undefined,
  projectPath: string,
  platform?: string,
): ActivationScope {
  const current = resolveScope(scope, platform);
  const key = scopeProjectKey(projectPath, platform);
  return {
    mode: current.mode,
    projects: current.projects.filter((entry) => scopeProjectKey(entry, platform) !== key),
  };
}
