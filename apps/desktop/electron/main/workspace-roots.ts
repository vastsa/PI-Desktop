import type {
  PluginWorkspaceInfo,
  PluginWorkspaceRoot,
  ProjectGroupRecord,
} from "@pi-desktop/shared";

/**
 * The project-group roots behind the one visible workspace (ADR 0249, ADR 0263).
 *
 * host-core owns the group records. Main keeps a snapshot of them so both the
 * synchronous `workspace:changed` broadcast and `pi.workspace.get` can answer
 * without awaiting the host on a path that must stay synchronous — the workspace
 * cache already has that shape, and this is the same idea one level up.
 *
 * `project.groups.list` is the only producer, and every group mutation refreshes
 * it, so the snapshot cannot drift while the app runs. A cold snapshot answers
 * an empty object rather than guessing, which is exactly the pre-group payload a
 * plugin already handles.
 */

let groups: ProjectGroupRecord[] | null = null;

export function rememberProjectGroups(
  next: readonly ProjectGroupRecord[] | null,
): void {
  groups = next ? [...next] : null;
}

export function knownProjectGroups(): ProjectGroupRecord[] | null {
  return groups;
}

/**
 * Compare folder spellings the way the project UI does: one separator, no
 * trailing slash, case-insensitive. Windows and macOS are case-insensitive in
 * practice and the stored spelling of a picked folder is not guaranteed to
 * match the spelling the workspace reports.
 */
function comparable(path: string): string {
  return path.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
}

/** The roots of `path`'s group in group order, primary first. */
function rootsOf(group: ProjectGroupRecord): PluginWorkspaceRoot[] {
  const primary = comparable(group.primaryPath);
  return [...group.roots]
    .sort((left, right) => left.position - right.position)
    .map((root) => ({
      path: root.path,
      name: root.name,
      primary: comparable(root.path) === primary,
    }));
}

/**
 * The project-group part of the workspace payload, or an empty object when the
 * path belongs to no known group (a standalone folder, or a cold snapshot).
 */
export function workspaceRootsFor(
  path: string | null,
): Pick<PluginWorkspaceInfo, "projectId" | "roots"> {
  if (!path || !groups) return {};
  const wanted = comparable(path);
  const group = groups.find((candidate) =>
    candidate.roots.some((root) => comparable(root.path) === wanted),
  );
  if (!group) return {};
  const roots = rootsOf(group);
  if (roots.length === 0) return {};
  return { projectId: group.id, roots };
}

/**
 * Every folder of the project `path` belongs to, primary first, falling back to
 * `path` itself as a single-folder project. Used where a caller needs the whole
 * containment family rather than the plugin-facing shape.
 */
export function projectFolderPaths(path: string | null): string[] {
  const { roots } = workspaceRootsFor(path);
  if (roots && roots.length > 0) return roots.map((root) => root.path);
  return path ? [path] : [];
}

/** The slice of the host-process handle this module needs. */
export type GroupHost = {
  isAvailable: () => boolean;
  call: (method: string, params?: unknown, timeoutMs?: number) => Promise<unknown>;
};

/**
 * Re-read the group records from host-core and report whether the snapshot
 * changed. Callers fire this when the snapshot is cold and after any mutation;
 * a host that is gone or answers nothing clears the snapshot rather than
 * keeping a stale one, so a plugin falls back to the single-root payload.
 */
export async function refreshProjectGroups(
  host: GroupHost | null,
): Promise<boolean> {
  if (!host || !host.isAvailable()) return false;
  let next: ProjectGroupRecord[] | null = null;
  try {
    const result = (await host.call("project.groups.list", undefined, 5_000)) as {
      groups?: ProjectGroupRecord[];
    };
    next = Array.isArray(result?.groups) ? result.groups : null;
  } catch {
    next = null;
  }
  const before = groups ? JSON.stringify(groups) : null;
  rememberProjectGroups(next);
  return before !== (next ? JSON.stringify(next) : null);
}

/**
 * The workspace as a plugin sees it: the primary path and name it has always
 * been given, plus the project group behind them when one resolves. The single
 * place both the `workspace:changed` broadcast and `pi.workspace.get` read, so
 * the event payload and the pull can never disagree.
 */
export function pluginWorkspaceInfo(path: string | null): PluginWorkspaceInfo | null {
  if (!path) return null;
  const name = path.split(/[\\/]/).filter(Boolean).at(-1) || path;
  return { path, name, ...workspaceRootsFor(path) };
}
