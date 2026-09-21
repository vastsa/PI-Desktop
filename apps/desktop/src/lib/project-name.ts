import { MAX_PROJECT_NAME_CHARS } from "./sidebar-preferences";

/**
 * Default display names for the Create project dialog. A local pick is named
 * after its first (primary) folder and a git source after its repository, so a
 * user never has to type a title before Create becomes available. A typed name
 * always wins, and every derived name is cut to the length the name field and
 * the persisted sidebar preference accept.
 */

/** The last segment of a local path, in either slash direction. */
export function folderNameFromPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? path.trim();
}

/**
 * Cut a derived name to the character budget the name field enforces. The
 * field counts UTF-16 units in `maxLength` and in its own counter, so the cut
 * happens there too, and a trailing high surrogate is dropped rather than left
 * as half a character. Both downstream checks (the sidebar preference and the
 * host's `chars().count()`) count code points, which such a cut still satisfies.
 */
export function clampProjectName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length <= MAX_PROJECT_NAME_CHARS) return trimmed;
  const cut = trimmed.slice(0, MAX_PROJECT_NAME_CHARS);
  const last = cut.charCodeAt(cut.length - 1);
  const splitPair = last >= 0xd800 && last <= 0xdbff;
  return splitPair ? cut.slice(0, -1) : cut;
}

/**
 * The name the dialog offers for the current source: the first selected
 * folder, or the parsed repository name for a git checkout.
 */
export function defaultProjectName(input: {
  source: "local" | "git";
  folders: readonly string[];
  repositoryName?: string | null;
}): string {
  const raw =
    input.source === "git"
      ? (input.repositoryName ?? "")
      : folderNameFromPath(input.folders[0] ?? "");
  return clampProjectName(raw);
}

/** A typed name wins; an empty field falls back to the derived default. */
export function resolveProjectName(typed: string, fallback: string): string {
  return typed.trim() || fallback.trim();
}
