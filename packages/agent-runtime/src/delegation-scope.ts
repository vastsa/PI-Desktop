/**
 * One-shot write scope of a delegation (issue #2544 §4).
 *
 * The scope is a per-delegation narrowing of the write rights the definition
 * already has. It is never persisted into a mode or definition, never changes
 * another delegation of the same role, and can only take capability away: a
 * read-only role stays read-only, and a scoped role cannot reach a path it could
 * not reach before.
 *
 * The authoritative enforcement lives in host-core, because only the Host owns
 * the symlink-aware path resolver and the state of the delegate's worktree.
 * This module owns parsing, value equality, and the tool policy that decides
 * which tools a scoped delegate may be offered at all: a tool that can write
 * without naming a path (`Bash`, plugin/MCP tools, desktop actions) cannot be
 * held to the same boundary, so a scoped delegation does not receive it.
 */

/** Tool names whose write target is a `path` the Host can resolve and check. */
const SCOPE_CONSTRAINABLE_TOOLS: ReadonlySet<string> = new Set([
  "Write",
  "Edit",
]);

/**
 * Tools that never write to the workspace, so a write scope leaves them alone.
 * Anything not listed here is withheld from a scoped delegation: an opaque tool
 * (plugin, MCP, desktop action) cannot be proven to stay inside the boundary.
 */
const SCOPE_SAFE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "Read",
  "Glob",
  "Grep",
  "BrowserPreview",
  "Write",
  "Edit",
  // Skill loads no files for writing, but the scoped tool selector also
  // requires trusted builtin provenance before exposing any safe name.
  "Skill",
]);

export type ParsedWriteScope =
  | { kind: "absent" }
  | { kind: "invalid"; reason: string }
  | { kind: "scoped"; entries: string[] };


/**
 * Read `Task.scope` into a normalized scope.
 * `{ write: [] }` is meaningful and distinct from an absent scope: it forbids
 * every write for this delegation. Blank or non-string entries are rejected
 * rather than silently dropped, because a scope the parent believes it passed
 * but which lost an entry is a wider boundary than it intended. Trailing
 * separators and backslashes are normalized, and exact duplicates collapse.
 */
export function parseWriteScope(scope: unknown): ParsedWriteScope {
  if (scope === undefined) return { kind: "absent" };
  if (scope === null || typeof scope !== "object" || Array.isArray(scope)) {
    return {
      kind: "invalid",
      reason:
        "`scope` must be an object like {\"write\": [\"src/parser/\"]}.",
    };
  }
  const record = scope as Record<string, unknown>;
  const unknownKeys = Object.keys(record).filter((key) => key !== "write");
  if (unknownKeys.length > 0) {
    return {
      kind: "invalid",
      reason: `\`scope\` accepts only \`write\`; unknown ${unknownKeys.length === 1 ? "key" : "keys"}: ${unknownKeys.join(", ")}.`,
    };
  }
  const write = record.write;
  if (write === undefined) {
    return { kind: "invalid", reason: "A `scope` object must include `write`. Omit `scope` to keep the role's existing tools." };
  }
  if (!Array.isArray(write)) {
    return {
      kind: "invalid",
      reason:
        "`scope.write` must be an array of paths, for example [\"src/parser/\"]. Pass an empty array to forbid every write.",
    };
  }
  const entries: string[] = [];
  for (const value of write) {
    if (typeof value !== "string" || !value.trim() || /\p{Cc}/u.test(value)) {
      return {
        kind: "invalid",
        reason:
          "`scope.write` entries must be non-empty path strings without control characters.",
      };
    }
    const path = value.trim().replaceAll("\\", "/");
    const entry = /^[a-z]:\/+$/i.test(path) ? `${path.slice(0, 2)}/` : path.replace(/\/+$/, "") || "/";
    if (!entries.includes(entry)) entries.push(entry);
  }
  return { kind: "scoped", entries };
}

/** Value equality of two frozen scopes, order-insensitive. */
export function sameWriteScope(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean {
  if (!left && !right) return true;
  if (!left || !right) return false;
  if (left.length !== right.length) return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((entry, index) => entry === b[index]);
}

/**
 * The tool names a scoped delegation may be offered. `withheld` is reported so
 * the parent learns what the boundary cost it instead of silently losing a
 * capability it asked for.
 */
export function scopeSafeToolNames(
  names: readonly string[],
  scope: readonly string[] | undefined,
): { kept: string[]; withheld: string[] } {
  if (!scope) return { kept: [...names], withheld: [] };
  const kept: string[] = [];
  const withheld: string[] = [];
  for (const name of names) {
    if (SCOPE_SAFE_TOOL_NAMES.has(name) && (scope.length || !isScopeConstrainableTool(name))) kept.push(name);
    else withheld.push(name);
  }
  return { kept, withheld };
}

/** True when a tool name can be held to a path boundary. */
export function isScopeConstrainableTool(name: string): boolean {
  return SCOPE_CONSTRAINABLE_TOOLS.has(name);
}
