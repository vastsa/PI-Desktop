/**
 * Pure parsing helpers for host-side application discovery (issue #2085).
 *
 * Everything here is string-in / string-out so the discovery scan in
 * `local-apps.ts` stays unit-testable without touching a real filesystem.
 * Path helpers are separator agnostic on purpose: the Windows scan sees `\`
 * paths while the macOS/Linux scans see `/` paths, and one test process
 * exercises all three platform readers.
 */
import { createHash } from "node:crypto";

/** Prefix of every discovered application id handed to the renderer. */
export const LOCAL_APP_ID_PREFIX = "app:";

/** A freedesktop `.desktop` entry, reduced to the fields the launcher needs. */
export interface ParsedDesktopEntry {
  name: string;
  exec: string;
  noDisplay: boolean;
  hidden: boolean;
  type: string;
}

/**
 * Field codes defined by the Desktop Entry Specification. They are
 * placeholders substituted by the launcher, never literal arguments, so they
 * must be removed before the executable is resolved.
 */
const DESKTOP_FIELD_CODE = /%[fFuUdDnNickvm]/g;

/** Shortcut / bundle names that are never launchable user applications. */
const NOISE_MARKERS = ["uninstall", "readme", "help", "documentation", "卸载"] as const;

/**
 * Parse the `[Desktop Entry]` group of a `.desktop` file.
 *
 * Returns `null` when the entry cannot describe a launchable application
 * (`Name` or `Exec` missing). `NoDisplay` / `Hidden` / `Type` are reported
 * verbatim so the caller decides visibility; see `isLaunchableDesktopEntry`.
 */
export function parseDesktopEntry(text: string): ParsedDesktopEntry | null {
  const values = new Map<string, string>();
  let parsedGroupHeader = false;
  let inMainGroup = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    if (line.startsWith("[")) {
      parsedGroupHeader = true;
      inMainGroup = line === "[Desktop Entry]";
      continue;
    }
    if (parsedGroupHeader && !inMainGroup) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    // Localized keys such as `Name[de]` never override the unlocalized value,
    // and the first occurrence of a key wins.
    if (key.includes("[") || values.has(key)) continue;
    values.set(key, line.slice(separator + 1).trim());
  }
  const name = values.get("Name") ?? "";
  const exec = values.get("Exec") ?? "";
  if (name.length === 0 || exec.length === 0) return null;
  return {
    name,
    exec,
    noDisplay: (values.get("NoDisplay") ?? "").toLowerCase() === "true",
    hidden: (values.get("Hidden") ?? "").toLowerCase() === "true",
    type: values.get("Type") ?? "",
  };
}

/** `true` when the parsed entry should appear in the launcher. */
export function isLaunchableDesktopEntry(entry: ParsedDesktopEntry): boolean {
  if (entry.noDisplay || entry.hidden) return false;
  return entry.type.toLowerCase() === "application";
}

/** Remove desktop field codes (`%f`, `%U`, `%i`, `%c`, `%k`, ...). */
export function stripFieldCodes(exec: string): string {
  return exec
    .replace(DESKTOP_FIELD_CODE, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** First whitespace-delimited token, honouring double-quoted tokens. */
export function firstToken(command: string): string {
  const trimmed = command.trim();
  if (trimmed.startsWith('"')) {
    const closing = trimmed.indexOf('"', 1);
    if (closing > 0) return trimmed.slice(1, closing);
  }
  const space = trimmed.search(/\s/);
  return space < 0 ? trimmed : trimmed.slice(0, space);
}

/**
 * Resolve the executable of an `Exec` line: the first token after field-code
 * removal is either an absolute path or a bare command name looked up on
 * `PATH`. Returns `null` when nothing is left.
 */
export function desktopExecutable(exec: string): string | null {
  const token = firstToken(stripFieldCodes(exec));
  return token.length > 0 ? token : null;
}

/** Last path segment, for both `/` and `\` separated paths. */
export function basename(target: string): string {
  const normalized = target.replace(/\\/g, "/").replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");
  return index < 0 ? normalized : normalized.slice(index + 1);
}

/** Strip a known, case-insensitive suffix such as `.lnk` or `.app`. */
export function stripExtension(name: string, extension: string): string {
  return name.toLowerCase().endsWith(extension.toLowerCase())
    ? name.slice(0, name.length - extension.length)
    : name;
}

/** Strip the final `.ext` of a file name; dotfiles are left untouched. */
export function stripFileExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/** Join two path segments while keeping the separator style of `base`. */
export function joinPath(base: string, name: string): string {
  if (base.length === 0) return name;
  if (base.endsWith("/") || base.endsWith("\\")) return `${base}${name}`;
  const separator = base.includes("\\") && !base.includes("/") ? "\\" : "/";
  return `${base}${separator}${name}`;
}

/** `true` for POSIX absolute paths, drive-letter paths and UNC shares. */
export function isAbsolutePath(target: string): boolean {
  return (
    target.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(target) ||
    target.startsWith("\\\\")
  );
}

/** Lowercase slug usable inside an application id. */
export function slugIdPart(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "app";
}

/**
 * Stable application id: `app:<executable>-<sha1(seed)[0..8]>`.
 *
 * The seed is the absolute launch target (or bundle / desktop-file path), so
 * an id survives renaming the visible entry but changes when the installed
 * executable moves.
 */
export function localAppId(executableName: string, seed: string): string {
  const digest = createHash("sha1").update(seed).digest("hex").slice(0, 8);
  return `${LOCAL_APP_ID_PREFIX}${slugIdPart(executableName)}-${digest}`;
}

/**
 * Uninstallers, readme files and help documents are shipped next to the real
 * shortcuts but are not applications; match case-insensitively on either the
 * shortcut name or the resolved target.
 */
export function isNoiseShortcut(...candidates: string[]): boolean {
  return candidates.some((candidate) => {
    const lowered = candidate.toLowerCase();
    return NOISE_MARKERS.some((marker) => lowered.includes(marker));
  });
}
