/**
 * Argument names models reach for instead of ours, mapped to the canonical
 * name. Every strong model has `file_path`/`query` burned in from pretraining
 * and sends them regardless of what the schema says, so the schema accepts both
 * spellings and `normalizeToolParams` folds the alias away before the host sees
 * the call (D273). Weaker models — issue #454 pinned longcat 2.0 — reach for
 * `filepath` / `filename` / `filePath` / `file` instead; folding those the same
 * way rescues the turn before the model gives up on the tool and silently falls
 * back to Bash.
 */
const PATH_ARG_ALIASES = {
  file_path: "path",
  filepath: "path",
  filePath: "path",
  filename: "path",
  fileName: "path",
  file: "path",
} as const;

export const TOOL_PARAM_ALIASES: Record<string, Record<string, string>> = {
  Read: { ...PATH_ARG_ALIASES },
  Write: { ...PATH_ARG_ALIASES },
  Edit: { ...PATH_ARG_ALIASES },
  BrowserPreview: { ...PATH_ARG_ALIASES },
  Glob: { query: "pattern" },
  Grep: { query: "pattern" },
};

/** Longest argument value quoted back in a diagnostic. */
const MAX_QUOTED_VALUE_CHARS = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidArgument(message: string): Error {
  return Object.assign(new Error(message), { errorCode: "INVALID_ARGUMENT" });
}

function quoted(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length > MAX_QUOTED_VALUE_CHARS
    ? `${text.slice(0, MAX_QUOTED_VALUE_CHARS)}…`
    : text;
}

/**
 * Fails a call that names one argument under several spellings with different
 * values, e.g. `{"path": "src/a.tsx here?", "file_path": "src/a.tsx"}` (#2552).
 * Folding would have to pick one and silently drop the other, and either guess
 * can run the operation on a path the model did not mean; naming both values
 * lets the next call send exactly one. Identical values are one argument and
 * pass. Runs on the raw arguments, before `normalizeToolParams` drops aliases.
 */
export function rejectConflictingAliasedParams(toolName: string, params: unknown): void {
  const aliases = TOOL_PARAM_ALIASES[toolName];
  if (!aliases || !isRecord(params)) return;
  for (const canonical of new Set(Object.values(aliases))) {
    const spellings = [
      canonical,
      ...Object.keys(aliases).filter((alias) => aliases[alias] === canonical),
    ].filter((name) => params[name] !== undefined);
    const first = spellings[0];
    if (first === undefined) continue;
    const differing = spellings.filter((name) => !Object.is(params[name], params[first]));
    if (differing.length === 0) continue;
    const named = [first, ...differing]
      .map((name) => `\`${name}\` = ${quoted(params[name])}`)
      .join(", ");
    throw invalidArgument(
      `Invalid arguments for ${toolName}: ${named} name the same argument with different values. Send only \`${canonical}\`, with the exact intended value. Example: {"${canonical}": "..."}.`,
    );
  }
}

/**
 * Fails a call that named neither the canonical argument nor its alias. Without
 * this the now-optional canonical argument would reach the host as `undefined`
 * and surface as a confusing host-side error instead of a schema one.
 */
export function requireAliasedParams(toolName: string, params: unknown): void {
  const aliases = TOOL_PARAM_ALIASES[toolName];
  if (!aliases || !isRecord(params)) return;
  for (const canonical of new Set(Object.values(aliases))) {
    if (params[canonical] !== undefined) continue;
    // A weaker model that keeps hitting this error gives up on the tool and
    // silently switches to Bash (issue #454). Naming the accepted spellings and
    // showing a minimal example lets the next call self-correct instead of the
    // whole turn falling back to shell.
    const acceptedAliases = Object.keys(aliases).filter(
      (alias) => aliases[alias] === canonical,
    );
    const aliasHint =
      acceptedAliases.length > 0
        ? ` (the alias${acceptedAliases.length > 1 ? "es" : ""} ${acceptedAliases
            .map((name) => `\`${name}\``)
            .join(", ")} ${acceptedAliases.length > 1 ? "are" : "is"} also accepted)`
        : "";
    throw invalidArgument(
      `Invalid arguments for ${toolName}: \`${canonical}\` is required${aliasHint}. Example: {"${canonical}": "..."}.`,
    );
  }
}
