/**
 * Where mode definitions come from (ADR mode-definitions).
 *
 * Two sources, mirroring `subagent-definitions.ts`: the modes PI-Desktop
 * ships, inline as Markdown documents, and the user's global
 * `~/.pi/modes/<dir>/mode.md` documents, which Electron main reads and hands
 * in. Workspaces never provide modes. A document in a builtin's own folder
 * (`~/.pi/modes/goal/mode.md`) overrides that builtin when it is valid and
 * keeps the structure the builtin's Host semantics rely on; an invalid one
 * is reported and the shipped definition stays in effect. Any other document
 * that claims a builtin id is reported and never loaded.
 *
 * Both sources go through the same strict reader: YAML frontmatter is parsed
 * with unique keys and the core schema, and anchors, aliases, explicit tags
 * and merge keys reject the document instead of being interpreted.
 */

import {
  BUILTIN_MODE_IDS,
  MODE_LIMITS,
  parseModeDefinition,
  type ModeCatalogEntry,
  type ModeDefinition,
  type ModeDiagnostic,
} from "@pi-desktop/shared";
import { parseStrictModeYaml, splitModeDocument, type SplitDocument, type YamlResult } from "./mode-yaml.js";
export { parseStrictModeYaml, splitModeDocument } from "./mode-yaml.js";
export type { SplitDocument, YamlResult } from "./mode-yaml.js";
import {
  parseModeBundle,
  readModeBundleReferences,
  type ModeBundleFile,
} from "./mode-definitions-bundle.js";
import {
  AGENT_MODE_SYSTEM_PROMPT,
  GOAL_MODE_SYSTEM_PROMPT,
  GOAL_WORK_STAGE_PROMPT,
  PLAN_MODE_SYSTEM_PROMPT,
} from "./mode-prompts.js";

/** User modes beyond this many are reported, not loaded. */
export const MAX_USER_MODES = 32;

/** One referenced file, read by Electron main; `text: null` carries the reason. */
export type UserModeBundleFile = {
  /** The reference exactly as it appears in `mode.yaml`. */
  path: string;
  /** Absolute path, for diagnostics only. */
  filePath?: string;
  text: string | null;
  problem?: string;
};

/**
 * One mode directory read by Electron main.
 *
 * Either `bundle` (new format) or `source` (legacy `mode.md`) is set, never
 * both: the presence of `mode.yaml` decides which reader runs, and a bundle
 * whose files could not be read reports an error instead of falling back.
 */
export type UserModeDocument = {
  dirName: string;
  filePath: string;
  /** Legacy `mode.md` text. Empty means unreadable or larger than the limit. */
  source: string;
  templates: Record<string, string>;
  /** Set when the directory carries a `mode.yaml`. */
  bundle?: UserModeBundle;
};

/** A `mode.yaml` and the files it references, as Electron main read them. */
export type UserModeBundle = {
  /** Absolute path of `mode.yaml`. */
  filePath: string;
  /** `mode.yaml` text, or `null` when it could not be read. */
  source: string | null;
  /** Why `source` is null. */
  problem?: string;
  /** Prompt document named by `promptFile`. */
  prompt?: UserModeBundleFile;
  /** Private subagent documents named by `subagents[]`, in order. */
  subagents: UserModeBundleFile[];
};

export type LoadedModeDefinitions = {
  definitions: ModeDefinition[];
  catalog: ModeCatalogEntry[];
  diagnostics: ModeDiagnostic[];
};

function indentBlock(text: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return text.split("\n").map((line) => (line ? `${pad}${line}` : "")).join("\n");
}

const BUILTIN_MODE_SOURCES: Readonly<Record<(typeof BUILTIN_MODE_IDS)[number], string>> = {
  agent: `---
name: agent
label: Agent
description: Carry out the work directly with the full tool set
permission: agent
---

${AGENT_MODE_SYSTEM_PROMPT}
`,
  plan: `---
name: plan
label: Plan
description: Agree on an implementation plan before anything changes
permission: contract
---

${PLAN_MODE_SYSTEM_PROMPT}
`,
  goal: `---
name: goal
label: Goal
description: Work across turns until the objective is verified
artifacts:
  goal:
    path: ".pi/goals/{{run.id}}.md"
    requiredHeadings: [Objective, Acceptance criteria, Evidence]
budget:
  maxTurns: 20
stages:
  work:
    permission: agent
    loop: true
    prompt: |
${indentBlock(GOAL_WORK_STAGE_PROMPT, 6)}
    on:
      compaction:
        - inject: artifact:goal
    exit:
      - require: artifact:goal
---

${GOAL_MODE_SYSTEM_PROMPT}
`,
};

function isBuiltinModeId(id: string): id is (typeof BUILTIN_MODE_IDS)[number] {
  return (BUILTIN_MODE_IDS as readonly string[]).includes(id);
}

/** Shipped Markdown source of a builtin mode; undefined otherwise. */
export function builtinModeSource(id: string): string | undefined {
  return isBuiltinModeId(id) ? BUILTIN_MODE_SOURCES[id] : undefined;
}

type ParsedDocument =
  | { ok: true; definition: ModeDefinition; warnings: string[] }
  | { ok: false; errors: string[]; warnings: string[]; declaredName?: string };

function declaredNameOf(frontmatter: unknown): string | undefined {
  if (typeof frontmatter !== "object" || frontmatter === null || Array.isArray(frontmatter)) return undefined;
  const name = (frontmatter as Record<string, unknown>).name;
  return typeof name === "string" && name.trim() ? name.trim() : undefined;
}

function parseModeDocument(
  source: string,
  options: { source: "builtin" | "user"; fallbackName?: string; templates?: Readonly<Record<string, string>> },
): ParsedDocument {
  const split = splitModeDocument(source);
  if (!split.ok) return { ok: false, errors: [split.error], warnings: [] };
  let frontmatter: unknown;
  let warnings: string[] = [];
  if (split.frontmatter !== undefined) {
    const yaml = parseStrictModeYaml(split.frontmatter);
    if (!yaml.ok) return { ok: false, errors: yaml.errors, warnings: [] };
    frontmatter = yaml.value;
    warnings = yaml.warnings;
  }
  const parsed = parseModeDefinition(frontmatter, split.body, options);
  if (!parsed.ok) {
    const declaredName = declaredNameOf(frontmatter);
    return {
      ok: false,
      errors: parsed.errors,
      warnings: [...warnings, ...parsed.warnings],
      ...(declaredName ? { declaredName } : {}),
    };
  }
  return { ok: true, definition: parsed.definition, warnings: [...warnings, ...parsed.warnings] };
}

/**
 * A bundle reference the parser rejected means the mapped `mode.yaml` itself
 * is unusable; nothing else in that document can rescue it.
 */
function bundleFile(file: UserModeBundleFile): ModeBundleFile {
  return {
    path: file.path,
    ...(file.filePath ? { filePath: file.filePath } : {}),
    text: file.text,
    ...(file.problem ? { problem: file.problem } : {}),
  };
}

/**
 * Read one mode directory: the new-format bundle when `mode.yaml` exists, the
 * legacy `mode.md` document otherwise.
 *
 * The two formats never mix. A directory with a `mode.yaml` that cannot be
 * read, parsed or resolved reports an error and loads nothing, because a
 * partial bundle would silently change which delegates and skills the mode may
 * use; `mode.md` is not consulted, not merged and not used as a fallback.
 */
export function parseUserModeDocument(
  document: UserModeDocument,
  options: { source: "user" | "builtin"; fallbackName: string },
): ParsedDocument {
  const bundle = document.bundle;
  if (!bundle) {
    return parseModeDocument(document.source, {
      source: options.source,
      fallbackName: options.fallbackName,
      templates: document.templates,
    });
  }
  if (bundle.source === null) {
    return {
      ok: false,
      errors: [`mode.yaml: ${bundle.problem ?? "unreadable"}`],
      warnings: [],
    };
  }
  const references = readModeBundleReferences(bundle.source);
  if (!references.ok) {
    return { ok: false, errors: references.errors, warnings: references.warnings };
  }
  const parsed = parseModeBundle({
    references: references.references,
    frontmatter: references.frontmatter,
    prompt: bundle.prompt ? bundleFile(bundle.prompt) : undefined,
    subagents: bundle.subagents.map(bundleFile),
    source: options.source,
    fallbackName: options.fallbackName,
    ...(Object.keys(document.templates).length ? { templates: document.templates } : {}),
  });
  if (!parsed.ok) {
    return {
      ok: false,
      errors: parsed.errors,
      warnings: [...references.warnings, ...parsed.warnings],
      ...(parsed.declaredName ? { declaredName: parsed.declaredName } : {}),
    };
  }
  return { ok: true, definition: parsed.definition, warnings: [...references.warnings, ...parsed.warnings] };
}

/** Entry point the directory's document lives at, for diagnostics. */
export function modeDocumentPath(document: UserModeDocument): string {
  return document.bundle?.filePath ?? document.filePath;
}

/**
 * What an override must keep from its builtin. Agent and Plan stay simple
 * modes at their permission level, and Goal stays a staged mode that returns
 * to Agent: the Host, Electron main and the renderer key those behaviors on
 * the id, so a different shape could not run as the user expects.
 */
export function builtinOverrideProblems(id: string, definition: ModeDefinition): string[] {
  const errors: string[] = [];
  if (definition.id !== id) errors.push(`name: a document in the "${id}" folder must keep name: ${id}`);
  if (id === "goal") {
    if (definition.stages.length === 0) errors.push(`stages: the builtin "goal" mode must keep at least one stage`);
    if (definition.returnTo !== "agent") errors.push(`returnTo: the builtin "goal" mode must return to "agent"`);
    return errors;
  }
  const permission = id === "agent" ? "agent" : "contract";
  if (definition.stages.length > 0) errors.push(`stages: the builtin "${id}" mode cannot declare stages`);
  if (definition.permission !== permission) errors.push(`permission: the builtin "${id}" mode must keep "${permission}"`);
  return errors;
}

function catalogEntry(definition: ModeDefinition, filePath?: string): ModeCatalogEntry {
  return {
    id: definition.id,
    label: definition.label,
    description: definition.description,
    source: definition.source,
    staged: definition.stages.length > 0,
    available: true,
    ...(filePath ? { filePath } : {}),
  };
}

function unavailableEntry(id: string, filePath: string, extra: Partial<ModeCatalogEntry> = {}): ModeCatalogEntry {
  return { id, label: id, description: "", source: "user", staged: false, available: false, filePath, ...extra };
}

type BuiltinSlot = {
  definition?: ModeDefinition;
  entry?: ModeCatalogEntry;
};

/**
 * Builtins plus every valid user mode. Load failures degrade to catalog
 * entries marked unavailable and diagnostics: one malformed document must
 * not cost the user their other modes, and a broken override never costs
 * the user the builtin itself.
 */
export function loadModeDefinitions(options: { userDocuments: readonly UserModeDocument[] }): LoadedModeDefinitions {
  const userDefinitions: ModeDefinition[] = [];
  const userCatalog: ModeCatalogEntry[] = [];
  const diagnostics: ModeDiagnostic[] = [];
  const builtins = new Map<string, BuiltinSlot>();

  for (const id of BUILTIN_MODE_IDS) {
    const parsed = parseModeDocument(BUILTIN_MODE_SOURCES[id], { source: "builtin", fallbackName: id });
    if (parsed.ok) {
      builtins.set(id, { definition: parsed.definition, entry: catalogEntry(parsed.definition) });
    } else {
      builtins.set(id, {});
      diagnostics.push({ modeId: id, errors: parsed.errors, warnings: parsed.warnings });
    }
  }

  const loadedIds = new Set<string>();
  let userModes = 0;
  for (const document of options.userDocuments) {
    const { dirName } = document;
    const filePath = modeDocumentPath(document);
    if (isBuiltinModeId(dirName)) {
      applyBuiltinOverride(builtins.get(dirName), document, diagnostics);
      continue;
    }
    // A legacy `mode.md` that could not be read is reported, not parsed: the
    // loader cannot tell an oversized document from an absent one otherwise.
    if (!document.bundle && !document.source) {
      userCatalog.push(unavailableEntry(dirName, filePath));
      diagnostics.push({
        modeId: dirName,
        filePath,
        errors: [`mode.md: unreadable or larger than ${MODE_LIMITS.fileBytes} bytes`],
        warnings: [],
      });
      continue;
    }
    const parsed = parseUserModeDocument(document, { source: "user", fallbackName: dirName });
    const id = parsed.ok ? parsed.definition.id : parsed.declaredName ?? dirName;
    if (isBuiltinModeId(id)) {
      userCatalog.push(unavailableEntry(id, filePath, {
        reserved: true,
        ...(parsed.ok ? {
          label: parsed.definition.label,
          description: parsed.definition.description,
          staged: parsed.definition.stages.length > 0,
        } : {}),
      }));
      diagnostics.push({
        modeId: id,
        filePath,
        errors: [`name: "${id}" is a builtin mode; edit it in ~/.pi/modes/${id}/mode.md or copy it under another name`],
        warnings: [],
      });
      continue;
    }
    if (!parsed.ok) {
      userCatalog.push(unavailableEntry(id, filePath));
      diagnostics.push({ modeId: id, filePath, errors: parsed.errors, warnings: parsed.warnings });
      continue;
    }
    const { definition } = parsed;
    let refusal: string | undefined;
    if (loadedIds.has(definition.id)) refusal = `name: another mode already uses the id "${definition.id}"`;
    else if (userModes >= MAX_USER_MODES) refusal = `at most ${MAX_USER_MODES} user modes are loaded`;
    if (refusal) {
      userCatalog.push({ ...catalogEntry(definition, filePath), available: false });
      diagnostics.push({ modeId: definition.id, filePath, errors: [refusal], warnings: parsed.warnings });
      continue;
    }
    loadedIds.add(definition.id);
    userModes += 1;
    userDefinitions.push(definition);
    userCatalog.push(catalogEntry(definition, filePath));
    if (parsed.warnings.length) {
      diagnostics.push({ modeId: definition.id, filePath, errors: [], warnings: parsed.warnings });
    }
  }
  const definitions: ModeDefinition[] = [];
  const catalog: ModeCatalogEntry[] = [];
  for (const id of BUILTIN_MODE_IDS) {
    const slot = builtins.get(id);
    if (slot?.definition) definitions.push(slot.definition);
    if (slot?.entry) catalog.push(slot.entry);
  }
  return {
    definitions: [...definitions, ...userDefinitions],
    catalog: [...catalog, ...userCatalog],
    diagnostics,
  };
}

/**
 * `~/.pi/modes/<builtin>/mode.yaml` (or the legacy `mode.md`): a valid
 * document replaces the shipped definition; an invalid one is reported against
 * the builtin, which keeps running as shipped. Either way the entry records the
 * override file, so a broken override is visible as a diagnostic rather than
 * as a mode that quietly reverted.
 */
function applyBuiltinOverride(
  slot: BuiltinSlot | undefined,
  document: UserModeDocument,
  diagnostics: ModeDiagnostic[],
): void {
  const { dirName: id } = document;
  const filePath = modeDocumentPath(document);
  if (!slot?.entry) return;
  slot.entry = { ...slot.entry, customized: true, filePath };
  if (!document.bundle && !document.source) {
    diagnostics.push({
      modeId: id,
      filePath,
      errors: [`mode.md: unreadable or larger than ${MODE_LIMITS.fileBytes} bytes`],
      warnings: [],
    });
    return;
  }
  const parsed = parseUserModeDocument(document, { source: "user", fallbackName: id });
  if (!parsed.ok) {
    diagnostics.push({ modeId: id, filePath, errors: parsed.errors, warnings: parsed.warnings });
    return;
  }
  const problems = builtinOverrideProblems(id, parsed.definition);
  if (problems.length) {
    diagnostics.push({ modeId: id, filePath, errors: problems, warnings: parsed.warnings });
    return;
  }
  slot.definition = parsed.definition;
  slot.entry = {
    ...catalogEntry(parsed.definition, filePath),
    source: "builtin",
    customized: true,
  };
  if (parsed.warnings.length) diagnostics.push({ modeId: id, filePath, errors: [], warnings: parsed.warnings });
}

/** Parsed builtin definition, or undefined for a non-builtin id. */
export function builtinModeDefinition(id: string): ModeDefinition | undefined {
  if (!isBuiltinModeId(id)) return undefined;
  const parsed = parseModeDocument(BUILTIN_MODE_SOURCES[id], { source: "builtin", fallbackName: id });
  return parsed.ok ? parsed.definition : undefined;
}
