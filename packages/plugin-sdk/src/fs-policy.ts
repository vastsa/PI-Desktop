/**
 * Scope policy for plugin file access.
 *
 * A permission answers "may this plugin touch files at all"; this module
 * answers "which files". The two are separate because the risks are not
 * symmetric: reading is only dangerous when the data can leave (see
 * `net-policy.ts`, which closes that half), while writing and deleting are
 * dangerous on their own and so must be declared narrowly up front.
 *
 * Pure string work only — the host resolves real paths and enforces
 * containment, because this module is also bundled into the renderer to
 * render the scopes in the install review.
 */

/** Where a rule's paths are rooted. */
export type PluginFsRoot = "workspace" | "userSelected";

export type PluginFsMode = "read" | "write" | "delete";

export const PLUGIN_FS_MODES = ["read", "write", "delete"] as const;

export type PluginFsRule = {
  root: PluginFsRoot;
  /** Globs relative to the root. Empty means "nothing without consent". */
  scope: string[];
  /**
   * Delete only: the plugin may delete paths it wrote itself, which needs no
   * scope and no prompt. Cleaning up your own output is the common case and
   * carries no risk the write already didn't.
   */
  own?: boolean;
};

export type PluginFsPolicy = {
  read?: PluginFsRule;
  write?: PluginFsRule;
  delete?: PluginFsRule;
};

/**
 * Directory names whose contents are refused under every root, scope and
 * grant. These hold credentials or history that no plugin has a reason to
 * read and that would be unrecoverable to lose.
 */
export const FS_DENY_DIR_SEGMENTS: readonly string[] = [
  ".git",
  ".ssh",
  ".aws",
  ".gnupg",
  ".kube",
  ".docker",
];

/** File names refused the same way, matched against the basename. */
export const FS_DENY_FILE_PATTERNS: readonly RegExp[] = [
  /^\.env$/i,
  /^\.env\./i,
  /^\.npmrc$/i,
  /^\.netrc$/i,
  /^\.pypirc$/i,
  /^\.git-credentials$/i,
  /^id_(?:rsa|dsa|ecdsa|ed25519)/i,
  /\.pem$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /\.keystore$/i,
];

/** Normalize a root-relative path to forward slashes with no leading slash. */
export function normalizeFsPath(value: string): string {
  return String(value ?? "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "");
}

/**
 * Whether `relPath` is refused outright. Checked per segment so nesting is
 * covered for free: `apps/web/.env` is as denied as `.env`.
 */
export function isDeniedFsPath(relPath: string): boolean {
  const segments = normalizeFsPath(relPath).split("/").filter(Boolean);
  if (!segments.length) return false;
  const deniedDirs = new Set(FS_DENY_DIR_SEGMENTS);
  // The last segment is checked as a directory too: `.git` itself is denied,
  // not only what is under it.
  if (segments.some((segment) => deniedDirs.has(segment.toLowerCase()))) return true;
  const basename = segments[segments.length - 1] ?? "";
  return FS_DENY_FILE_PATTERNS.some((pattern) => pattern.test(basename));
}

/**
 * Match a root-relative path against one glob. `**` crosses separators, `*`
 * does not. Shared with `pi.fs.glob` so a scope and a lookup agree on what a
 * pattern means.
 */
export function matchFsGlob(relPath: string, pattern: string): boolean {
  const normalizedPattern = normalizeFsPath(pattern);
  const normalizedPath = normalizeFsPath(relPath);
  if (isWholeTreePattern(normalizedPattern)) return true;
  // `**` is parked on a sentinel so the single-`*` pass cannot see its stars,
  // and so a literal space in a pattern is left alone.
  const source = normalizedPattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*")
    .replace(/\?/g, "[^/]");
  return new RegExp(`^${source}$`, "i").test(normalizedPath);
}

/** Whether any of `scope`'s globs admits `relPath`. */
export function isFsPathInScope(relPath: string, scope: readonly string[]): boolean {
  return scope.some((pattern) => matchFsGlob(relPath, pattern));
}

/**
 * Whether a pattern admits the entire root. Written as "strip the wildcards
 * and separators; if nothing is left, it matched everything" so `**`, `**\/*`,
 * `*\/**` and `./*` are all caught without enumerating them.
 */
export function isWholeTreePattern(pattern: string): boolean {
  const value = normalizeFsPath(pattern).trim();
  if (!value) return false;
  return value.replace(/[*/.]/g, "") === "";
}

function scopePatternError(pattern: unknown, mode: PluginFsMode): string | undefined {
  if (typeof pattern !== "string" || !pattern.trim()) {
    return `fs.${mode}.scope entries must be non-empty strings`;
  }
  const value = normalizeFsPath(pattern);
  if (/^[a-zA-Z]:/.test(pattern) || pattern.startsWith("/") || pattern.startsWith("\\")) {
    return `fs.${mode}.scope entry must be relative to the root: ${pattern}`;
  }
  if (value.split("/").includes("..")) {
    return `fs.${mode}.scope entry must not contain "..": ${pattern}`;
  }
  // Reading the whole tree is fine — egress is what makes a read dangerous,
  // and it is closed elsewhere. Writing or deleting the whole tree is the
  // thing this field exists to prevent, and no real plugin needs it.
  if (mode !== "read" && isWholeTreePattern(value)) {
    return `fs.${mode}.scope must not cover the whole root: ${pattern}`;
  }
  return undefined;
}

function parseRule(
  raw: unknown,
  mode: PluginFsMode,
): { ok: true; rule: PluginFsRule } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: `fs.${mode} must be an object` };
  }
  const entry = raw as { root?: unknown; scope?: unknown; own?: unknown };

  let root: PluginFsRoot = "workspace";
  if (entry.root !== undefined) {
    if (entry.root !== "workspace" && entry.root !== "userSelected") {
      return {
        ok: false,
        error: `fs.${mode}.root must be "workspace" or "userSelected"`,
      };
    }
    root = entry.root;
  }

  const scope: string[] = [];
  if (entry.scope !== undefined) {
    if (!Array.isArray(entry.scope)) {
      return { ok: false, error: `fs.${mode}.scope must be an array` };
    }
    for (const pattern of entry.scope) {
      const error = scopePatternError(pattern, mode);
      if (error) return { ok: false, error };
      const value = normalizeFsPath(pattern as string);
      if (!scope.includes(value)) scope.push(value);
    }
  }

  if (entry.own !== undefined) {
    if (mode !== "delete") {
      return { ok: false, error: `fs.${mode} does not support "own"` };
    }
    if (typeof entry.own !== "boolean") {
      return { ok: false, error: "fs.delete.own must be a boolean" };
    }
  }

  const rule: PluginFsRule = { root, scope };
  if (mode === "delete" && entry.own === true) rule.own = true;
  return { ok: true, rule };
}

/**
 * Parse `manifest.fs`. An absent field is a valid empty policy, not an error:
 * a plugin with `fs.read` but no `fs` block simply has no standing scope, and
 * every access falls to consent.
 */
export function parseFsPolicy(raw: unknown): {
  ok: boolean;
  policy?: PluginFsPolicy;
  error?: string;
} {
  if (raw === undefined || raw === null) return { ok: true, policy: {} };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "fs must be an object" };
  }
  const entry = raw as Record<string, unknown>;
  for (const key of Object.keys(entry)) {
    if (!(PLUGIN_FS_MODES as readonly string[]).includes(key)) {
      return { ok: false, error: `fs.${key} is not a recognized mode` };
    }
  }
  const policy: PluginFsPolicy = {};
  for (const mode of PLUGIN_FS_MODES) {
    if (entry[mode] === undefined) continue;
    const parsed = parseRule(entry[mode], mode);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    policy[mode] = parsed.rule;
  }
  return { ok: true, policy };
}

/**
 * Permission names that predate scopes, and the mode each becomes. The old
 * names granted the whole workspace; §"migration" below decides what they are
 * worth now.
 */
export const LEGACY_FS_PERMISSIONS: Readonly<Record<string, PluginFsMode>> = {
  "fs.read.workspace": "read",
  "fs.write.workspace": "write",
  "fs.delete.workspace": "delete",
};

/**
 * What a legacy permission is worth without a declared scope. Reading keeps
 * the whole workspace — egress is closed, so a broad read is no longer the
 * dangerous half. Writing and deleting are cut back to the plugin's own
 * output, which is the part no user would be surprised by; a plugin that
 * wants more has to say where in its manifest.
 */
function legacyRule(mode: PluginFsMode): PluginFsRule {
  if (mode === "read") return { root: "workspace", scope: ["**/*"] };
  if (mode === "delete") return { root: "workspace", scope: [], own: true };
  return { root: "workspace", scope: [] };
}

export type ResolvedFsAccess = {
  /** Declared permissions with legacy fs names rewritten to their new form. */
  permissions: string[];
  /** The scope actually enforced, after legacy names are accounted for. */
  policy: PluginFsPolicy;
  /** Legacy names found, so the UI can tell the user the plugin was cut back. */
  legacy: string[];
};

/**
 * Fold declared permissions and `manifest.fs` into the access the host
 * enforces. An explicit rule always wins over the legacy default, so a plugin
 * upgrades by adding scope rather than by renaming anything.
 */
export function resolveFsAccess(input: {
  permissions?: readonly string[];
  fs?: unknown;
}): ResolvedFsAccess {
  const parsed = parseFsPolicy(input.fs);
  const declared = parsed.ok ? (parsed.policy ?? {}) : {};
  const policy: PluginFsPolicy = { ...declared };
  const permissions: string[] = [];
  const legacy: string[] = [];

  for (const name of input.permissions ?? []) {
    const mode = LEGACY_FS_PERMISSIONS[name];
    if (!mode) {
      if (!permissions.includes(name)) permissions.push(name);
      continue;
    }
    legacy.push(name);
    const migrated = `fs.${mode}`;
    if (!permissions.includes(migrated)) permissions.push(migrated);
    if (!policy[mode]) policy[mode] = legacyRule(mode);
  }

  return { permissions, policy, legacy };
}
