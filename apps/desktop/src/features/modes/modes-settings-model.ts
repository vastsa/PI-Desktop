import {
  BUILTIN_MODE_IDS,
  isModeId,
  type ModeCatalog,
  type ModeCatalogEntry,
  type ModeDocumentValidation,
} from "@pi-desktop/shared";

/**
 * Pure rules of Settings → Modes (ADR mode-definitions). Electron main owns
 * the files and the parser; these helpers only decide what the page offers
 * and how a new or duplicated document starts.
 */

/** Builtins first in their fixed order, then the user's documents by id. */
export function settingsModeEntries(catalog: ModeCatalog | null | undefined): ModeCatalogEntry[] {
  if (!catalog) return [];
  const builtins = BUILTIN_MODE_IDS.map((id) =>
    catalog.modes.find((entry) => entry.id === id && entry.source === "builtin"),
  ).filter((entry): entry is ModeCatalogEntry => !!entry);
  const user = catalog.modes
    .filter((entry) => entry.source === "user")
    .sort((left, right) => left.id.localeCompare(right.id));
  return [...builtins, ...user];
}

/** Stable list key: a reserved user document shares its id with a builtin. */
export function modeEntryKey(entry: Pick<ModeCatalogEntry, "id" | "source">): string {
  return `${entry.source}:${entry.id}`;
}

export function modeEntryDiagnostic(
  catalog: ModeCatalog | null | undefined,
  entry: Pick<ModeCatalogEntry, "id" | "source">,
): { errors: string[]; warnings: string[] } {
  if (!catalog || entry.source !== "user") return { errors: [], warnings: [] };
  const diagnostic = catalog.diagnostics.find((item) => item.modeId === entry.id);
  return { errors: diagnostic?.errors ?? [], warnings: diagnostic?.warnings ?? [] };
}

export type NewModeIdProblem = "invalid" | "reserved" | "taken";

/** Why `id` cannot name a new document, or null when it can. */
export function newModeIdProblem(id: string, catalog: ModeCatalog | null | undefined): NewModeIdProblem | null {
  if (!isModeId(id)) return "invalid";
  if ((BUILTIN_MODE_IDS as readonly string[]).includes(id)) return "reserved";
  if (catalog?.modes.some((entry) => entry.id === id)) return "taken";
  return null;
}

/** `code-review` → `Code review`. */
export function labelFromModeId(id: string): string {
  const words = id.split("-").filter(Boolean).join(" ");
  return words ? words[0]!.toUpperCase() + words.slice(1) : id;
}

/**
 * A simple mode: identity and permission in the frontmatter, the prompt in
 * the body. Text values are written as YAML double-quoted scalars (JSON
 * strings are valid ones), so localized copy cannot break the frontmatter.
 */
export function simpleModeTemplate(
  id: string,
  copy: { description: string; prompt: string },
): string {
  return [
    "---",
    `name: ${id}`,
    `label: ${JSON.stringify(labelFromModeId(id))}`,
    `description: ${JSON.stringify(copy.description)}`,
    "permission: agent",
    "---",
    copy.prompt,
    "",
  ].join("\n");
}

/**
 * A copy of `source` saved as `id`: the frontmatter `name:` becomes the new
 * id (the document is otherwise unchanged), and a document without one gets
 * it as its first key.
 */
export function duplicateModeSource(source: string, id: string): string {
  const text = source.replace(/^\uFEFF/, "");
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trimEnd() !== "---") return ["---", `name: ${id}`, "---", text].join("\n");
  const end = lines.findIndex((line, index) => index > 0 && line.trimEnd() === "---");
  if (end === -1) return ["---", `name: ${id}`, "---", text].join("\n");
  const nameLine = lines.findIndex((line, index) => index > 0 && index < end && /^name\s*:/.test(line));
  if (nameLine === -1) {
    lines.splice(1, 0, `name: ${id}`);
  } else {
    lines[nameLine] = `name: ${id}`;
  }
  return lines.join("\n");
}

/** Errors the Host sent back with `MODE_DEFINITION_INVALID`, if any. */
export function rejectedValidation(error: unknown): ModeDocumentValidation | null {
  if (!error || typeof error !== "object") return null;
  const details = (error as { details?: unknown }).details;
  if (!details || typeof details !== "object") return null;
  const { errors, warnings } = details as { errors?: unknown; warnings?: unknown };
  if (!Array.isArray(errors)) return null;
  const list = (value: unknown) =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  return { ok: false, errors: list(errors), warnings: list(warnings) };
}
