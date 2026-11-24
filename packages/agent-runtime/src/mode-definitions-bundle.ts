/**
 * New-format mode bundles (issue #2544, ADR mode-definitions).
 *
 * A mode directory may carry `mode.yaml`: one plain YAML map that names the
 * mode's own prompt file, its private subagent documents and its skill
 * switches. It is a *bundle*, so the map itself holds no inline prompt and no
 * inline delegate: every document is a relative path inside the mode
 * directory, which is what makes the directory a copyable configuration unit.
 *
 * The split keeps the filesystem out of this module. `readModeBundleReferences`
 * proves the map is structurally sound and yields the paths to read;
 * `parseModeBundle` then assembles the definition from texts the caller read
 * (Electron main owns the disk, the link checks and the byte limits). A
 * `mode.yaml` that fails either stage is a hard error for that mode — it never
 * falls back to `mode.md`, because a half-read bundle would silently change
 * which delegates and skills a session may use.
 */

import {
  MODE_LIMITS,
  MODE_SKILL_ID_RE,
  normalizeModeBundlePath,
  parseModeDefinition,
  parseSubagentDefinition,
  type ModeDefinition,
  type SubagentDefinition,
} from "@pi-desktop/shared";
import { parseStrictModeYaml } from "./mode-yaml.js";

/**
 * Keys a `mode.yaml` may carry: the historical mode fields, plus the bundle
 * keys. Unknown keys reject the document rather than being ignored, so a typo
 * such as `includeGlobalSubagent` cannot quietly change visibility.
 */
export const MODE_BUNDLE_KEYS: ReadonlySet<string> = new Set([
  "name",
  "label",
  "description",
  "permission",
  "artifacts",
  "budget",
  "returnTo",
  "stages",
  "promptFile",
  "subagents",
  "includeGlobalSubagents",
  "disabledSkills",
]);

/** What a bundle map points at, once its structure has been accepted. */
export type ModeBundleReferences = {
  /** Relative path of the prompt document; required. */
  promptFile: string;
  /** Relative paths of the mode's private subagent documents, in order. */
  subagents: string[];
  includeGlobalSubagents: boolean;
  disabledSkills: string[];
};

export type ModeBundleReferencesResult =
  | {
      ok: true;
      /** The mode itself (`name`, `label`, `permission`, `stages`, ...) for `parseModeDefinition`. */
      frontmatter: Record<string, unknown>;
      references: ModeBundleReferences;
      warnings: string[];
    }
  | { ok: false; errors: string[]; warnings: string[] };

/** One referenced file as the caller read it; `text: null` carries the reason. */
export type ModeBundleFile = {
  /** The reference as written in `mode.yaml`. */
  path: string;
  /** Absolute path, for diagnostics; never resolved into another document. */
  filePath?: string;
  text: string | null;
  problem?: string;
};

export type ParsedModeBundle =
  | { ok: true; definition: ModeDefinition; warnings: string[] }
  | { ok: false; errors: string[]; warnings: string[]; declaredName?: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function declaredNameOf(frontmatter: Record<string, unknown>): string | undefined {
  const name = frontmatter.name;
  return typeof name === "string" && name.trim() ? name.trim() : undefined;
}

/** A reference list: strings only, bounded, deduplicated, each inside the directory. */
function readPathList(
  value: unknown,
  at: string,
  limit: number,
  ctx: { errors: string[] },
): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    ctx.errors.push(`${at}: expected a list of relative paths`);
    return [];
  }
  if (value.length > limit) {
    ctx.errors.push(`${at}: at most ${limit} entries`);
    return [];
  }
  const paths: string[] = [];
  value.forEach((entry, index) => {
    const normalized = normalizeModeBundlePath(entry);
    if (!normalized.ok) {
      ctx.errors.push(`${at}[${index}]: ${normalized.error}`);
      return;
    }
    if (paths.includes(normalized.path)) {
      ctx.errors.push(`${at}[${index}]: "${normalized.path}" is listed twice`);
      return;
    }
    paths.push(normalized.path);
  });
  return paths;
}

/**
 * Read the bundle keys of a `mode.yaml` and prove them sound.
 *
 * Everything that is not a bundle key is handed back untouched: the mode's own
 * fields keep exactly the validation they have in a legacy document, so a
 * bundle cannot smuggle in a field the mode parser would have rejected.
 */
export function readModeBundleReferences(source: string): ModeBundleReferencesResult {
  const yaml = parseStrictModeYaml(source);
  if (!yaml.ok) return { ok: false, errors: yaml.errors, warnings: [] };
  if (!isPlainObject(yaml.value)) {
    return { ok: false, errors: ["mode.yaml: expected a map of mode fields"], warnings: yaml.warnings };
  }
  const errors: string[] = [];
  const ctx = { errors };
  for (const key of Object.keys(yaml.value)) {
    if (!MODE_BUNDLE_KEYS.has(key)) errors.push(`${key}: unknown key in mode.yaml`);
  }

  let promptFile = "";
  if (yaml.value.promptFile === undefined) {
    errors.push("promptFile: required; name the mode's prompt document inside the mode directory");
  } else {
    const normalized = normalizeModeBundlePath(yaml.value.promptFile);
    if (normalized.ok) promptFile = normalized.path;
    else errors.push(`promptFile: ${normalized.error}`);
  }

  const subagents = readPathList(yaml.value.subagents, "subagents", MODE_LIMITS.bundleSubagents, ctx);

  let includeGlobalSubagents = false;
  if (yaml.value.includeGlobalSubagents !== undefined) {
    if (typeof yaml.value.includeGlobalSubagents !== "boolean") {
      errors.push("includeGlobalSubagents: expected true or false");
    } else {
      includeGlobalSubagents = yaml.value.includeGlobalSubagents;
    }
  }

  const disabledSkills: string[] = [];
  if (yaml.value.disabledSkills !== undefined) {
    if (!Array.isArray(yaml.value.disabledSkills)) {
      errors.push("disabledSkills: expected a list of skill ids");
    } else if (yaml.value.disabledSkills.length > MODE_LIMITS.bundleDisabledSkills) {
      errors.push(`disabledSkills: at most ${MODE_LIMITS.bundleDisabledSkills} entries`);
    } else {
      yaml.value.disabledSkills.forEach((entry, index) => {
        if (typeof entry !== "string" || !MODE_SKILL_ID_RE.test(entry.trim())) {
          errors.push(`disabledSkills[${index}]: expected a skill id such as "verify-delivery"`);
          return;
        }
        const id = entry.trim();
        if (disabledSkills.includes(id)) {
          errors.push(`disabledSkills[${index}]: "${id}" is listed twice`);
          return;
        }
        disabledSkills.push(id);
      });
    }
  }

  if (errors.length) return { ok: false, errors, warnings: yaml.warnings };
  const frontmatter: Record<string, unknown> = { ...yaml.value };
  delete frontmatter.promptFile;
  delete frontmatter.subagents;
  delete frontmatter.includeGlobalSubagents;
  delete frontmatter.disabledSkills;
  return {
    ok: true,
    frontmatter,
    references: { promptFile, subagents, includeGlobalSubagents, disabledSkills },
    warnings: yaml.warnings,
  };
}

/**
 * Role id a private document falls back to: its own file name, not the path.
 *
 * Delegate handles may not contain dots (`normalizeSubagentName` keeps them but
 * the name pattern rejects the result), so `agents/oracle.agent.md` falls back
 * to `oracle`: the final extension and any qualifier before it are dropped. Two
 * documents that reduce to one handle are reported by `parseModeBundle`, so the
 * loss of a qualifier can never make one role shadow another silently.
 */
function subagentFallbackName(path: string): string {
  const segment = path.split("/").pop() ?? path;
  const [stem] = segment.split(".");
  return stem || segment;
}

/**
 * Assemble the definition of a bundle once its referenced files are read.
 *
 * `prompt` and `subagents` must cover exactly the references the map declared;
 * a missing entry is reported, never substituted. Private documents are parsed
 * with the same reader as global user definitions, so tools, model pins,
 * fallbacks and thinking levels keep one meaning everywhere; only their
 * visibility differs, and that is decided by the caller.
 */
export function parseModeBundle(input: {
  references: ModeBundleReferences;
  frontmatter: Record<string, unknown>;
  prompt: ModeBundleFile | undefined;
  subagents: readonly ModeBundleFile[];
  source: "builtin" | "user";
  fallbackName?: string;
  templates?: Readonly<Record<string, string>>;
}): ParsedModeBundle {
  const errors: string[] = [];
  const warnings: string[] = [];
  const declaredName = declaredNameOf(input.frontmatter);

  let prompt = "";
  if (!input.prompt) {
    errors.push(`promptFile: "${input.references.promptFile}" was not read`);
  } else if (input.prompt.text === null) {
    errors.push(`promptFile: ${input.prompt.problem ?? `"${input.references.promptFile}" is unreadable`}`);
  } else {
    prompt = input.prompt.text;
  }

  const parsed = parseModeDefinition(input.frontmatter, prompt, {
    source: input.source,
    ...(input.fallbackName ? { fallbackName: input.fallbackName } : {}),
    ...(input.templates ? { templates: input.templates } : {}),
  });
  warnings.push(...parsed.warnings);
  if (!parsed.ok) {
    errors.push(...parsed.errors);
    return {
      ok: false,
      errors,
      warnings,
      ...(declaredName ? { declaredName } : {}),
    };
  }

  const roles: SubagentDefinition[] = [];
  const seen = new Set<string>();
  for (const [index, reference] of input.references.subagents.entries()) {
    const file = input.subagents.find((candidate) => candidate.path === reference);
    const labeled = `subagents[${index}] (${reference})`;
    if (!file) {
      errors.push(`${labeled}: was not read`);
      continue;
    }
    if (file.text === null) {
      errors.push(`${labeled}: ${file.problem ?? "unreadable"}`);
      continue;
    }
    const role = parseSubagentDefinition(file.text, {
      source: input.source,
      fallbackName: subagentFallbackName(reference),
      ...(file.filePath ? { filePath: file.filePath } : {}),
    });
    for (const warning of role.warnings) warnings.push(`${labeled}: ${warning}`);
    if (!role.ok) {
      for (const error of role.errors) errors.push(`${labeled}: ${error}`);
      continue;
    }
    if (seen.has(role.definition.name)) {
      // Two documents with one handle would let the mode's Task menu pick
      // whichever loaded first; the mode must name each role once.
      errors.push(`${labeled}: role "${role.definition.name}" is declared twice in this mode`);
      continue;
    }
    seen.add(role.definition.name);
    roles.push(role.definition);
  }

  if (errors.length) {
    return {
      ok: false,
      errors,
      warnings,
      ...(declaredName ? { declaredName } : {}),
    };
  }
  const definition: ModeDefinition = {
    ...parsed.definition,
    bundle: {
      subagents: roles,
      includeGlobalSubagents: input.references.includeGlobalSubagents,
      disabledSkills: [...input.references.disabledSkills],
    },
  };
  return { ok: true, definition, warnings };
}

/**
 * Rewrite the `name:` of a `mode.yaml` so a copied directory loads under its
 * new id.
 *
 * A copy keeps every relative reference unchanged, but a mode whose map still
 * said `name: sisyphus` would collide with the source: two directories would
 * claim one handle, and the loader would refuse the copy. Only the leading
 * top-level `name:` line is touched — nothing in a value or a nested map is a
 * mode id.
 */
export function renameModeBundle(source: string, id: string): string {
  const lines = source.replace(/^\uFEFF/, "").split(/\r?\n/);
  let replaced = false;
  const rewritten = lines.map((line) => {
    if (replaced) return line;
    const match = /^name[ \t]*:([ \t]*)(.*)$/.exec(line);
    if (!match) return line;
    replaced = true;
    const value = match[2].trim();
    const quoted = value.length >= 2 && (value[0] === '"' || value[0] === "'") && value[0] === value.at(-1);
    return `name: ${quoted ? `${value[0]}${id}${value[0]}` : id}`;
  });
  return rewritten.join("\n");
}
