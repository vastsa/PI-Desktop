import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSkillFrontmatter } from "@pi-desktop/plugin-sdk";
import { GEN_UI_SKILL_ID } from "@pi-desktop/shared";
import type { PluginSkillDef } from "@pi-desktop/agent-runtime";
import type { LoadedSkillDocument } from "./skill-document";
import { getModuleDirectory } from "./module-path";

/**
 * Skills PI-Desktop ships itself.
 *
 * These ride the same catalog-plus-`Skill`-tool path as plugin-contributed
 * skills (D174), so a first-party skill and a third-party one are
 * indistinguishable to the model — but they need no permission grant, because
 * the host is not a plugin.
 */

/** Bundled skill teaching the plugin-development loop. */
export const PLUGIN_DEV_SKILL_FILE = "plugin-development.md";
export const PLUGIN_DEV_SKILL_ID = "pi-desktop/plugin-development";
export const IMAGE_GENERATION_SKILL_ID = "pi-desktop/imagegen";
const IMAGE_GENERATION_SKILL_FILE = "image-generation.md";
/** Inline visualization contract (ADR gen-ui-inline-visualization). */
export const VISUALIZE_SKILL_ID = GEN_UI_SKILL_ID;
const VISUALIZE_SKILL_FILE = "visualize.md";

/** electron-builder copies `resources/skills` to `<resources>/skills`. */
function resolveBuiltinSkillPath(fileName: string): string | null {
  const moduleDir = getModuleDirectory(import.meta.url);
  const candidates = [
    join(process.resourcesPath || "", "skills", fileName),
    join(moduleDir, "../../resources/skills", fileName),
    join(moduleDir, "../../../resources/skills", fileName),
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * True when this workspace looks like plugin development: a plugin manifest at
 * the root, or a plugin already loaded from inside it.
 *
 * The gate matters. A plugin-authoring primer in every session would burn
 * context for the vast majority of sessions that never write a plugin; the
 * three plugin tools stay registered regardless, and calling one puts a
 * manifest in the workspace, which activates the skill on the next prompt.
 */
export function isPluginWorkspace(
  workspacePath: string | null | undefined,
  pluginPaths: string[] = [],
): boolean {
  if (!workspacePath) return false;
  const manifestPath = join(workspacePath, "manifest.json");
  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (
        manifest &&
        typeof manifest === "object" &&
        typeof manifest.schemaVersion === "number" &&
        typeof manifest.main === "string"
      ) {
        return true;
      }
    } catch {
      // An unparseable manifest is not evidence either way.
    }
  }
  const prefix = workspacePath.endsWith("/") ? workspacePath : `${workspacePath}/`;
  return pluginPaths.some((path) => path === workspacePath || path.startsWith(prefix));
}

/** Front matter carries the skill's title and applicability line. */
function readBuiltinSkill(fileName: string): { path: string; raw: string } | null {
  const path = resolveBuiltinSkillPath(fileName);
  if (!path) return null;
  try {
    return { path, raw: readFileSync(path, "utf8") };
  } catch {
    return null;
  }
}

export type BuiltinSkillInput = {
  workspacePath?: string | null;
  /** Directories of currently loaded plugins, used to detect a dev workspace. */
  pluginPaths?: string[];
  /** User-disabled ids are withheld from the agent and composer catalog. */
  disabledIds?: readonly string[];
  /**
   * The session runs on a remote host. Its tools write on that machine, which
   * Electron Main cannot serve, so visualizations are not offered.
   */
  remote?: boolean;
};

const BUILTIN_SKILL_FILES = [
  [IMAGE_GENERATION_SKILL_ID, IMAGE_GENERATION_SKILL_FILE],
  [VISUALIZE_SKILL_ID, VISUALIZE_SKILL_FILE],
  [PLUGIN_DEV_SKILL_ID, PLUGIN_DEV_SKILL_FILE],
] as const;

function builtinSkillFile(id: string): string | null {
  return BUILTIN_SKILL_FILES.find(([skillId]) => skillId === id)?.[1] ?? null;
}

/** All bundled skill entries, including ones whose applicability is conditional. */
export function builtinSkillCatalog(): PluginSkillDef[] {
  return BUILTIN_SKILL_FILES.flatMap(([id, file]) => {
    const raw = readBuiltinSkill(file);
    if (!raw?.raw.trim()) return [];
    const parsed = parseSkillFrontmatter(raw.raw);
    return parsed.body ? [{ id, name: parsed.name ?? id, description: parsed.description }] : [];
  });
}

/**
 * Catalog entries for the built-in skills that apply to the given session, read
 * fresh so a packaged update takes effect without a restart.
 */
export function builtinSkills(input: BuiltinSkillInput): PluginSkillDef[] {
  const ids: string[] = [IMAGE_GENERATION_SKILL_ID];
  if (!input.remote) ids.push(VISUALIZE_SKILL_ID);
  if (isPluginWorkspace(input.workspacePath, input.pluginPaths)) ids.push(PLUGIN_DEV_SKILL_ID);
  const activeIds = new Set(ids);
  const disabled = new Set(input.disabledIds ?? []);
  return builtinSkillCatalog().filter(
    (skill) => activeIds.has(skill.id) && !disabled.has(skill.id),
  );
}

/**
 * Built-in ids this process must withhold: the host-owned activation state plus
 * the inline-visualization switch, which owns the `visualize` skill.
 *
 * The switch is opt-in, so an absent or unreadable setting withholds the skill.
 * Keeping this in one place means a launch, the `/` menu, and the on-demand
 * `Skill` tool cannot disagree about whether the feature exists.
 */
export function effectiveDisabledBuiltinSkills(
  disabled: readonly string[],
  visualizations: boolean,
): string[] {
  if (visualizations || disabled.includes(VISUALIZE_SKILL_ID)) return [...disabled];
  return [...disabled, VISUALIZE_SKILL_ID];
}

/** Refuse a stale on-demand load after a bundled skill has been switched off. */
export async function assertBuiltinSkillEnabled(
  id: string,
  loadDisabledIds: () => Promise<string[]>,
): Promise<void> {
  if (!builtinSkillFile(id)) return;
  if ((await loadDisabledIds()).includes(id)) {
    throw new Error(`Built-in skill "${id}" is disabled in Settings`);
  }
}

/**
 * Load a built-in skill body for the `Skill` tool. Returns null for any id the
 * host does not ship, which is the caller's cue to try the plugin registry.
 */
export function loadBuiltinSkillBody(id: string): LoadedSkillDocument | null {
  const file = builtinSkillFile(id);
  if (!file) return null;
  const raw = readBuiltinSkill(file);
  if (!raw?.raw.trim()) return null;
  const parsed = parseSkillFrontmatter(raw.raw);
  if (!parsed.body) return null;
  return {
    id,
    name: parsed.name ?? id,
    body: parsed.body,
    location: raw.path,
  };
}
