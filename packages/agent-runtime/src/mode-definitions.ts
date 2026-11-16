/**
 * Where mode definitions come from (ADR mode-definitions).
 *
 * Two sources, mirroring `subagent-definitions.ts`: the modes PI-Desktop
 * ships, inline as Markdown documents, and the user's global
 * `~/.pi/modes/<dir>/mode.md` documents, which Electron main reads and hands
 * in. Workspaces never provide modes. Builtin ids are reserved: a user
 * document that claims one is reported in the catalog and never loaded, so a
 * copy has to live under a new name.
 *
 * Both sources go through the same strict reader: YAML frontmatter is parsed
 * with unique keys and the core schema, and anchors, aliases, explicit tags
 * and merge keys reject the document instead of being interpreted.
 */

import { isAlias, isPair, isScalar, parseDocument, visit } from "yaml";
import {
  BUILTIN_MODE_IDS,
  MODE_LIMITS,
  parseModeDefinition,
  type ModeCatalogEntry,
  type ModeDefinition,
  type ModeDiagnostic,
} from "@pi-desktop/shared";
import {
  AGENT_MODE_SYSTEM_PROMPT,
  GOAL_MODE_SYSTEM_PROMPT,
  GOAL_WORK_STAGE_PROMPT,
  PLAN_MODE_SYSTEM_PROMPT,
} from "./mode-prompts.js";

/** User modes beyond this many are reported, not loaded. */
export const MAX_USER_MODES = 32;

/**
 * One `~/.pi/modes/<dirName>/mode.md` document read by Electron main.
 * `templates` holds `templates/<name>.md` files keyed by that relative path.
 * An empty `source` means the file was unreadable or larger than the limit.
 */
export type UserModeDocument = {
  dirName: string;
  filePath: string;
  source: string;
  templates: Record<string, string>;
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

/** Markdown source of a builtin mode, for read-only display; undefined otherwise. */
export function builtinModeSource(id: string): string | undefined {
  return isBuiltinModeId(id) ? BUILTIN_MODE_SOURCES[id] : undefined;
}

type SplitDocument =
  | { ok: true; frontmatter?: string; body: string }
  | { ok: false; error: string };

/** Frontmatter sits between a leading `---` line and the next `---` line. */
export function splitModeDocument(source: string): SplitDocument {
  const text = source.replace(/^\uFEFF/, "");
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trimEnd() !== "---") return { ok: true, body: text };
  const end = lines.findIndex((line, index) => index > 0 && line.trimEnd() === "---");
  if (end === -1) return { ok: false, error: "frontmatter: missing the closing --- line" };
  return { ok: true, frontmatter: lines.slice(1, end).join("\n"), body: lines.slice(end + 1).join("\n") };
}

type YamlResult = { ok: true; value: unknown; warnings: string[] } | { ok: false; errors: string[] };

/**
 * Strict YAML: duplicate keys, anchors, aliases, explicit tags and merge keys
 * reject the frontmatter. A mode document is configuration, not a program, so
 * nothing in it may reshape what the validator sees.
 */
export function parseStrictModeYaml(source: string): YamlResult {
  const doc = parseDocument(source, { uniqueKeys: true, schema: "core", merge: false });
  const errors = doc.errors.map((error) => `frontmatter: ${error.message.split("\n")[0]}`);
  const structural = new Set<string>();
  visit(doc, {
    Pair(_key, pair) {
      if (isPair(pair) && isScalar(pair.key) && pair.key.value === "<<") {
        structural.add("frontmatter: merge keys (<<) are not supported");
      }
    },
    Node(_key, node) {
      if (isAlias(node)) {
        structural.add("frontmatter: aliases (*name) are not supported");
        return;
      }
      if (node.anchor) structural.add("frontmatter: anchors (&name) are not supported");
      if (node.tag) structural.add("frontmatter: explicit tags (!tag) are not supported");
    },
  });
  errors.push(...structural);
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: doc.toJS({ maxAliasCount: 0 }),
    warnings: doc.warnings.map((warning) => `frontmatter: ${warning.message.split("\n")[0]}`),
  };
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

/**
 * Builtins plus every valid user mode. Load failures degrade to catalog
 * entries marked unavailable and diagnostics: one malformed document must
 * not cost the user their other modes.
 */
export function loadModeDefinitions(options: { userDocuments: readonly UserModeDocument[] }): LoadedModeDefinitions {
  const definitions: ModeDefinition[] = [];
  const catalog: ModeCatalogEntry[] = [];
  const diagnostics: ModeDiagnostic[] = [];

  for (const id of BUILTIN_MODE_IDS) {
    const parsed = parseModeDocument(BUILTIN_MODE_SOURCES[id], { source: "builtin", fallbackName: id });
    if (parsed.ok) {
      definitions.push(parsed.definition);
      catalog.push(catalogEntry(parsed.definition));
    } else {
      diagnostics.push({ modeId: id, errors: parsed.errors, warnings: parsed.warnings });
    }
  }

  const loadedIds = new Set<string>();
  let userModes = 0;
  for (const document of options.userDocuments) {
    const { dirName, filePath } = document;
    if (!document.source) {
      catalog.push(unavailableEntry(dirName, filePath));
      diagnostics.push({
        modeId: dirName,
        filePath,
        errors: [`mode.md: unreadable or larger than ${MODE_LIMITS.fileBytes} bytes`],
        warnings: [],
      });
      continue;
    }
    const parsed = parseModeDocument(document.source, {
      source: "user",
      fallbackName: dirName,
      templates: document.templates,
    });
    const id = parsed.ok ? parsed.definition.id : parsed.declaredName ?? dirName;
    const reservedId = isBuiltinModeId(dirName) ? dirName : isBuiltinModeId(id) ? id : undefined;
    if (reservedId !== undefined) {
      catalog.push(unavailableEntry(reservedId, filePath, {
        reserved: true,
        ...(parsed.ok ? {
          label: parsed.definition.label,
          description: parsed.definition.description,
          staged: parsed.definition.stages.length > 0,
        } : {}),
      }));
      diagnostics.push({
        modeId: reservedId,
        filePath,
        errors: [`name: "${reservedId}" is a builtin mode; copy it under another name to customize it`],
        warnings: [],
      });
      continue;
    }
    if (!parsed.ok) {
      catalog.push(unavailableEntry(id, filePath));
      diagnostics.push({ modeId: id, filePath, errors: parsed.errors, warnings: parsed.warnings });
      continue;
    }
    const { definition } = parsed;
    let refusal: string | undefined;
    if (loadedIds.has(definition.id)) refusal = `name: another mode already uses the id "${definition.id}"`;
    else if (userModes >= MAX_USER_MODES) refusal = `at most ${MAX_USER_MODES} user modes are loaded`;
    if (refusal) {
      catalog.push({ ...catalogEntry(definition, filePath), available: false });
      diagnostics.push({ modeId: definition.id, filePath, errors: [refusal], warnings: parsed.warnings });
      continue;
    }
    loadedIds.add(definition.id);
    userModes += 1;
    definitions.push(definition);
    catalog.push(catalogEntry(definition, filePath));
    if (parsed.warnings.length) {
      diagnostics.push({ modeId: definition.id, filePath, errors: [], warnings: parsed.warnings });
    }
  }
  return { definitions, catalog, diagnostics };
}

/** Parsed builtin definition, or undefined for a non-builtin id. */
export function builtinModeDefinition(id: string): ModeDefinition | undefined {
  if (!isBuiltinModeId(id)) return undefined;
  const parsed = parseModeDocument(BUILTIN_MODE_SOURCES[id], { source: "builtin", fallbackName: id });
  return parsed.ok ? parsed.definition : undefined;
}
