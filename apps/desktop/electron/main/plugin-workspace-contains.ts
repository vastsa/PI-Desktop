/**
 * Containment for the plugin-workspace probe. The two spellings come from
 * different worlds — the plugin folder from a native dialog (backslashes on
 * Windows), the workspace from the host (which may persist `//?/X:/…` or a
 * forward-slash variant) — so both are unified before comparing: separators
 * fold to `/`, the Windows verbatim prefix (`\\?\X:\` in either spelling)
 * drops away, and comparison stays case-sensitive only on Linux, matching the
 * worktree ref folding. A filesystem root (`/`, `C:/`) keeps its meaning
 * through the fold, so a workspace opened at a root still contains its plugin
 * folders. Kept dependency free so its test can drive it directly.
 */
export function pluginWorkspaceContains(
  workspacePath: string,
  pluginPath: string,
): boolean {
  const fold = (value: string) => {
    const unified = value.replace(/\\/g, "/").replace(/^\/\/\?\/(?=[a-z]:\/)/i, "");
    const trimmed = unified.replace(/\/+$/, "");
    // A path of separators only is the filesystem root, not an empty path:
    // trimming it must not turn it into "nothing contains nothing".
    const rooted = trimmed === "" && unified.startsWith("/") ? "/" : trimmed;
    return process.platform === "linux" ? rooted : rooted.toLowerCase();
  };
  const workspace = fold(workspacePath);
  if (!workspace) return false;
  const plugin = fold(pluginPath);
  // The POSIX root contains every absolute path; `${workspace}/` would spell
  // "//" and match none of them. Windows drive roots keep their shape
  // (`c:` + `/…`), so they need no special case.
  if (workspace === "/") return plugin.startsWith("/");
  return plugin === workspace || plugin.startsWith(`${workspace}/`);
}
