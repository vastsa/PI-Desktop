/**
 * Pure rules of the grouped mode settings page (issue #2544).
 *
 * The page shows one mode at a time in Definition, Prompt, Subagents and Skills.
 * inside the existing settings container. Nothing here reads files or talks to
 * IPC: the renderer only decides which tab is offered for the mode that is
 * open, what the tab's rows are, and how an edit maps onto the bundle the host
 * writes.
 *
 * Two shapes meet here:
 *
 * - a `mode.yaml` bundle, whose prompt and private role documents are separate
 *   files. Its rows are derived from the map text plus the documents the host
 *   returned, keyed by the relative reference each document is stored under;
 * - a legacy `mode.md`, one Markdown document. It has no private roles and no
 *   mode-level switches, so the Subagents and Skills tabs are not offered for
 *   it at all rather than shown empty. The document stays editable exactly as
 *   before.
 */
import type {
  ModeBundleContents,
  ModeCatalog,
  ModeCatalogEntry,
  ModeDocumentReadResult,
  ModeSkillsResult,
} from "@pi-desktop/shared";
import { parseRoleDocument } from "./mode-role-document";

/** Sections of a bundle editor, in navigation order. */
export const MODE_SETTINGS_TABS = ["mode", "prompt", "subagents", "skills"] as const;
export type ModeSettingsTab = (typeof MODE_SETTINGS_TABS)[number];

/** Tabs offered for a document. A legacy mode has only its own document. */
export function modeSettingsTabs(format: ModeDocumentFormat): ModeSettingsTab[] {
  return format === "bundle" ? [...MODE_SETTINGS_TABS] : ["mode"];
}

/** Which entry point a mode directory uses. */
export type ModeDocumentFormat = "bundle" | "legacy";

/**
 * The entry-point filename decides the format. Without an override, a builtin
 * keeps the format of its shipped source; a new draft starts as a bundle.
 */
export function modeDocumentFormat(document: {
  filePath?: string;
  builtin: boolean;
  source: string;
}): ModeDocumentFormat {
  if (document.filePath?.endsWith("mode.yaml")) return "bundle";
  if (document.filePath?.endsWith("mode.md")) return "legacy";
  // No file yet: the shipped source decides what a save of *this* text means.
  return isBundleText(document.source) ? "bundle" : "legacy";
}

/**
 * Whether a source is a `mode.yaml` map rather than a Markdown document.
 *
 * Mirrors the host's own test: a legacy document starts with frontmatter or
 * with prose, while a bundle starts with a top-level `key:` line. Deciding both
 * sides the same way is what keeps "what the editor shows" and "what a save
 * writes" the same format.
 */
export function isBundleText(source: string): boolean {
  const text = source.replace(/^\uFEFF/, "").replace(/^\s+/, "");
  if (!text) return false;
  if (text.startsWith("---")) return false;
  return /^[A-Za-z][A-Za-z0-9_]*\s*:(\s|$)/.test(text);
}

/** A top-level `key: value` scalar from a bundle map, unquoted. */
export function bundleScalar(source: string, key: string): string | undefined {
  const pattern = new RegExp(`^${key}\\s*:\\s*(.*)$`);
  for (const line of source.replace(/\r\n/g, "\n").split("\n")) {
    const match = pattern.exec(line);
    if (!match) continue;
    return unquote(match[1]);
  }
  return undefined;
}

/** A top-level block or single-line flow list from a bundle map, in file order. */
export function bundleList(source: string, key: string): string[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((line) => new RegExp(`^${key}\\s*:`).test(line));
  if (start === -1) return [];
  // An inline list (`key: [a, b]`) is the compact spelling of the same value.
  const inline = lines[start].replace(new RegExp(`^${key}\\s*:\\s*`), "").trim();
  const flow = /^\[(.*)\](?:\s+#.*)?$/.exec(inline);
  if (flow) {
    return flow[1]
      .split(",")
      .map((entry) => unquote(entry))
      .filter(Boolean);
  }
  const list: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item) list.push(unquote(item[1]));
    else if (/^\s+\S/.test(line)) continue;
    else break;
  }
  return list;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && (trimmed[0] === '"' || trimmed[0] === "'") && trimmed[0] === trimmed[trimmed.length - 1]) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** One private role the mode brings, as the Subagents tab lists it. */
export type ModeRoleRow = {
  /** Relative reference inside the mode directory; the identity used on save. */
  reference: string;
  /** The role document text, exactly as it was read. */
  source: string;
  /** Delegate handle the document declares, or its file name when it declares none. */
  name: string;
  description: string;
  /** False when the document declares a model pin of its own. */
  inheritsModel: boolean;
  /** Thinking level of the pin, when the document declares one. */
  thinkingLevel?: string;
  fallbackCount: number;
};

/** `<dir>/agents/oracle.agent.md` → `oracle`, the same reduction the loader uses. */
export function roleHandleFromReference(reference: string): string {
  const segment = reference.split("/").pop() ?? reference;
  const [stem] = segment.split(".");
  return stem || segment;
}

/**
 * The roles a bundle brings, in the order `subagents:` declares them.
 *
 * A declared reference the host could not read is reported as a row with an
 * empty source so the page can name it, rather than disappearing: a mode whose
 * delegate silently vanished would be a mode whose `Task` catalog changed
 * without the user seeing why.
 */
export function modeRoleRows(source: string, agents: Record<string, string>): ModeRoleRow[] {
  const rows: ModeRoleRow[] = [];
  for (const reference of bundleList(source, "subagents")) {
    const text = agents[reference] ?? "";
    const role = parseRoleDocument(text);
    rows.push({
      reference,
      source: text,
      name: role.name || roleHandleFromReference(reference),
      description: role.description,
      inheritsModel: !role.model,
      ...(role.thinkingLevel ? { thinkingLevel: role.thinkingLevel } : {}),
      fallbackCount: role.fallbacks.length,
    });
  }
  return rows;
}

/** The scopes a mode directory keeps, keyed by what the tab shows. */
export type ModeBundleDraft = {
  source: string;
  prompt: string;
  agents: Record<string, string>;
};

/** Whole-bundle edit state for one open mode; `undefined` for a legacy mode. */
export function bundleDraftFrom(contents: ModeBundleContents): ModeBundleDraft {
  return { source: contents.source, prompt: contents.prompt, agents: { ...contents.agents } };
}

/** Whether the open bundle has unsaved changes. */
export function bundleDraftDirty(
  draft: ModeBundleDraft | null,
  saved: ModeBundleDraft | null,
): boolean {
  if (!draft || !saved) return false;
  if (draft.source !== saved.source || draft.prompt !== saved.prompt) return true;
  const keys = new Set([...Object.keys(draft.agents), ...Object.keys(saved.agents)]);
  for (const key of keys) {
    if ((draft.agents[key] ?? "") !== (saved.agents[key] ?? "")) return true;
  }
  return false;
}

/**
 * Attach a newly declared private role to the draft.
 *
 * The reference is derived from the handle the document declares, so the map
 * and the file agree without the user typing a path. Extensions are appended
 * until the reference is free: a mode may legitimately carry two roles whose
 * handles differ only by a qualifier (`oracle`, `oracle.agent`), and the second
 * must not overwrite the first.
 */
export function addRoleReference(
  existing: readonly string[],
  handle: string,
): string {
  const slug = (handle.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "role").slice(0, 40);
  const base = `agents/${slug}.agent.md`;
  if (!existing.includes(base)) return base;
  for (let index = 2; index < 100; index += 1) {
    const candidate = `agents/${slug}-${index}.agent.md`;
    if (!existing.includes(candidate)) return candidate;
  }
  return `agents/${slug}-${existing.length + 1}.agent.md`;
}

/**
 * The `includeGlobalSubagents` switch.
 *
 * Absent means off: the issue makes a bundle's own roles the whole catalog by
 * default and merges globals only when the document says so.
 */
export function includeGlobalSubagents(source: string): boolean {
  return bundleScalar(source, "includeGlobalSubagents") === "true";
}

/** Local skill ids the mode switches off. */
export function disabledSkillIds(source: string): string[] {
  return bundleList(source, "disabledSkills");
}

/** Toggle only the identified skill, including when other disabled skills are not installed. */
export function disabledSkillsAfterToggle(source: string, id: string, enabled: boolean): string[] {
  const disabled = new Set(disabledSkillIds(source));
  if (enabled) disabled.delete(id);
  else disabled.add(id);
  return [...disabled];
}

/** Skills the Skills tab lists, with the toggle state the map produces. */
export function skillRows(state: ModeSkillsResult | null): ModeSkillsResult["skills"] {
  return state?.skills ?? [];
}

/**
 * What the mode selector offers: every mode the catalog can show, with the
 * reserved documents left out because they are reported, not loaded.
 *
 * A mode that is listed but unavailable stays selectable so its diagnostics can
 * be read; the page never edits it.
 */
export function modeSelectorEntries(catalog: ModeCatalog | null | undefined): ModeCatalogEntry[] {
  if (!catalog) return [];
  const builtins = catalog.modes.filter((entry) => entry.source === "builtin" && !entry.reserved);
  const user = catalog.modes
    .filter((entry) => entry.source === "user" && !entry.reserved)
    .sort((left, right) => left.id.localeCompare(right.id));
  return [...builtins, ...user];
}

/**
 * Label for the open document's file, or the id when the mode has no file yet.
 * The page shows this line so the user can see *which* file a save writes.
 */
export function openDocumentLabel(document: { id: string; filePath?: string }, format: ModeDocumentFormat): string {
  if (document.filePath) return document.filePath;
  return format === "bundle" ? `${document.id}/mode.yaml` : `${document.id}/mode.md`;
}

/**
 * Read-time snapshot of one mode, so a tab that is switched mid-read cannot
 * apply the previous mode's answer. `openKey` is the identity the caller guards
 * with: two reads for different modes never share one.
 */
export function openModeKey(id: string, generation: number): string {
  return `${id}#${generation}`;
}

/** A mode's read answer, tagged with the key it belongs to. */
export type OpenedMode = {
  key: string;
  document: ModeDocumentReadResult;
  format: ModeDocumentFormat;
};

/** Whether an answer still belongs to the open mode. */
export function openedModeIsCurrent(answer: OpenedMode | null, key: string): boolean {
  return answer !== null && answer.key === key;
}

/**
 * Set a top-level scalar in a bundle map, replacing it in place.
 *
 * The map is edited line by line rather than reparsed: a `mode.yaml` carries
 * nested stage maps the tabs never model, and a serializer round-trip would
 * rewrite them. A value that could not survive as a bare scalar is quoted, so a
 * description containing a colon cannot change the map's structure.
 */
export function setBundleScalar(source: string, key: string, value: string): string {
  const lines = sourceLines(source);
  const index = topLevelIndex(lines, key);
  const text = `${key}: ${quoteScalar(value)}`;
  if (index === -1) lines.push(text);
  else lines[index] = text;
  return joinSource(lines);
}

/** Replace a top-level block list, or remove it when the new list is empty. */
export function setBundleList(source: string, key: string, values: readonly string[]): string {
  const lines = sourceLines(source);
  const index = topLevelIndex(lines, key);
  const replacement = values.length ? [`${key}:`, ...values.map((value) => `  - ${quoteScalar(value)}`)] : [];
  if (index === -1) {
    lines.push(...replacement);
  } else {
    let end = index + 1;
    while (end < lines.length && /^\s+\S/.test(lines[end])) end += 1;
    lines.splice(index, end - index, ...replacement);
  }
  return joinSource(lines);
}
function sourceLines(source: string): string[] {
  const lines = source.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function joinSource(lines: string[]): string {
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

/** An unindented `key:` line; a nested key of the same name never matches. */
function topLevelIndex(lines: string[], key: string): number {
  return lines.findIndex((line) => new RegExp(`^${key}\\s*:`).test(line));
}

/** Bare when the text reads back as the same string, double-quoted otherwise. */
function quoteScalar(value: string): string {
  const bare = /^[A-Za-z0-9_./][A-Za-z0-9 _./-]*$/.test(value)
    && !/:\s|\s#/.test(value)
    && !/\s$/.test(value);
  return bare ? value : JSON.stringify(value);
}

/**
 * Delete a private role from the draft: the reference leaves the map and its
 * text leaves the draft.
 *
 * The role's own file is not deleted here. The host's bundle write decides what
 * a mode manages, and a reference the map no longer declares is what stops that
 * document being read — so an accidental delete in the page cannot take a file
 * the user still wants with it.
 */
export function removeRole(draft: ModeBundleDraft, reference: string): ModeBundleDraft {
  const agents = { ...draft.agents };
  delete agents[reference];
  const declared = bundleList(draft.source, "subagents").filter((item) => item !== reference);
  return { ...draft, agents, source: setBundleList(draft.source, "subagents", declared) };
}

/**
 * Add or replace one private role document and make sure the map declares it.
 *
 * Replacing keeps the reference's position in `subagents:`, so editing a role
 * never reorders the mode's role list.
 */
export function putRole(draft: ModeBundleDraft, reference: string, source: string): ModeBundleDraft {
  const declared = bundleList(draft.source, "subagents");
  const next = declared.includes(reference) ? declared : [...declared, reference];
  return {
    ...draft,
    agents: { ...draft.agents, [reference]: source },
    source: setBundleList(draft.source, "subagents", next),
  };
}

/** Point `promptFile` at a document and store that document's text. */
export function putPrompt(draft: ModeBundleDraft, reference: string, text: string): ModeBundleDraft {
  return { ...draft, prompt: text, source: setBundleScalar(draft.source, "promptFile", reference) };
}

/**
 * A `mode.yaml` for a mode that has never been saved.
 *
 * New modes start in the YAML format the issue asks for, with one prompt
 * document already named so the Mode tab has a file to write and every relative
 * reference in the map is valid from the first save.
 */
export function newBundleDraft(input: {
  id: string;
  label?: string;
  description?: string;
  promptFile?: string;
  prompt: string;
}): ModeBundleDraft {
  const promptFile = input.promptFile ?? "prompts/mode.md";
  const lines = [`name: ${input.id}`];
  if (input.label) lines.push(`label: ${quoteScalar(input.label)}`);
  if (input.description) lines.push(`description: ${quoteScalar(input.description)}`);
  lines.push("permission: agent", `promptFile: ${promptFile}`);
  return { source: `${lines.join("\n")}\n`, prompt: input.prompt, agents: {} };
}

/**
 * A saved bundle prepared for a new id: only `name:` changes.
 *
 * Every relative reference stays as it is, which is what makes the copy a
 * working mode rather than a directory of documents pointing at a prompt the
 * copy does not have.
 */
export function copyBundleForId(contents: ModeBundleContents, id: string): ModeBundleDraft {
  return { ...bundleDraftFrom(contents), source: setBundleScalar(contents.source, "name", id) };
}

/**
 * Whether a bundle write is enabled, and why not.
 *
 * A saved mode is written back through `writeBundle`, which only touches the
 * documents `mode.yaml` declares. An edit that changes which documents those
 * are — a new `promptFile`, an added or removed `subagents` reference — would
 * leave the previous documents in the directory, unreferenced and never read
 * again, while the new reference writes over whatever was already at that path.
 * On a copy that is how a user's curated `skills/` tree or a hand-written note
 * silently becomes a mode document.
 *
 * So the reference set is fixed for a saved mode: editing the documents is
 * free, changing the set is refused here and reported. A mode that has never
 * been saved has no previous set to keep, so it may declare whatever it likes
 * and the host creates the directory.
 */
export function bundleReferenceChange(
  draft: ModeBundleDraft,
  saved: ModeBundleDraft | null,
): { promptFile: boolean; subagents: boolean } {
  if (!saved) return { promptFile: false, subagents: false };
  const draftPrompt = bundleScalar(draft.source, "promptFile") ?? "";
  const savedPrompt = bundleScalar(saved.source, "promptFile") ?? "";
  const draftRoles = bundleList(draft.source, "subagents");
  const savedRoles = bundleList(saved.source, "subagents");
  return {
    promptFile: draftPrompt !== savedPrompt,
    // Order is part of the map, so a reorder counts as a change: writing the
    // same documents in a different order is still a different declaration.
    subagents:
      draftRoles.length !== savedRoles.length ||
      draftRoles.some((role, index) => role !== savedRoles[index]),
  };
}

/** True when a save would change which documents the mode directory manages. */
export function bundleReferencesChanged(draft: ModeBundleDraft, saved: ModeBundleDraft | null): boolean {
  const change = bundleReferenceChange(draft, saved);
  return change.promptFile || change.subagents;
}

/**
 * Whether a new mode may be saved at all.
 *
 * The first save writes the directory, so its references must be usable now: a
 * bundle needs a `promptFile`, and that document has to have text — otherwise
 * the host would create a mode that cannot load.
 */
export function newBundleProblem(draft: ModeBundleDraft): "noPromptFile" | "noPrompt" | null {
  if (!bundleScalar(draft.source, "promptFile")) return "noPromptFile";
  if (!draft.prompt.trim()) return "noPrompt";
  return null;
}
