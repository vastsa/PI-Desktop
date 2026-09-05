import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSkillFrontmatter } from "@pi-desktop/plugin-sdk";
import type { PluginSkillDef } from "@pi-desktop/agent-runtime";

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

/** Bundled skill teaching parent-to-parent A2A (ADR 0164, D324). */
export const A2A_CROSS_CONVERSATION_SKILL_FILE = "a2a-cross-conversation.md";
export const A2A_CROSS_CONVERSATION_SKILL_ID = "pi-desktop/a2a-cross-conversation";

const BUILTIN_SKILL_FILES: Record<string, string> = {
  [PLUGIN_DEV_SKILL_ID]: PLUGIN_DEV_SKILL_FILE,
  [A2A_CROSS_CONVERSATION_SKILL_ID]: A2A_CROSS_CONVERSATION_SKILL_FILE,
};

/** electron-builder copies `resources/skills` to `<resources>/skills`. */
function resolveBuiltinSkillPath(fileName: string): string | null {
  const candidates = [
    join(process.resourcesPath || "", "skills", fileName),
    join(__dirname, "../../resources/skills", fileName),
    join(__dirname, "../../../resources/skills", fileName),
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
function readBuiltinSkill(fileName: string): string | null {
  const path = resolveBuiltinSkillPath(fileName);
  if (!path) return null;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function catalogEntry(
  fileName: string,
  id: string,
  fallbackName: string,
): PluginSkillDef | null {
  const raw = readBuiltinSkill(fileName);
  if (!raw?.trim()) return null;
  const parsed = parseSkillFrontmatter(raw);
  if (!parsed.body) return null;
  return {
    id,
    name: parsed.name ?? fallbackName,
    description: parsed.description,
  };
}

export type BuiltinSkillInput = {
  workspacePath?: string | null;
  /** Directories of currently loaded plugins, used to detect a dev workspace. */
  pluginPaths?: string[];
};

/**
 * Catalog entries for the built-in skills that apply to the given session, read
 * fresh so a packaged update takes effect without a restart.
 *
 * Cross-conversation A2A is always catalogued: every Agent session has the
 * parent `A2A` tool. Plugin development stays workspace-gated.
 */
export function builtinSkills(input: BuiltinSkillInput): PluginSkillDef[] {
  const skills: PluginSkillDef[] = [];
  const a2a = catalogEntry(
    A2A_CROSS_CONVERSATION_SKILL_FILE,
    A2A_CROSS_CONVERSATION_SKILL_ID,
    "A2A cross-conversation",
  );
  if (a2a) skills.push(a2a);
  if (isPluginWorkspace(input.workspacePath, input.pluginPaths)) {
    const pluginDev = catalogEntry(
      PLUGIN_DEV_SKILL_FILE,
      PLUGIN_DEV_SKILL_ID,
      "PI-Desktop plugin development",
    );
    if (pluginDev) skills.push(pluginDev);
  }
  return skills;
}

/**
 * Load a built-in skill body for the `Skill` tool. Returns null for any id the
 * host does not ship, which is the caller's cue to try the plugin registry.
 */
export function loadBuiltinSkillBody(
  id: string,
): { id: string; name: string; body: string } | null {
  const fileName = BUILTIN_SKILL_FILES[id];
  if (!fileName) return null;
  const raw = readBuiltinSkill(fileName);
  if (!raw?.trim()) return null;
  const parsed = parseSkillFrontmatter(raw);
  if (!parsed.body) return null;
  const fallback =
    id === PLUGIN_DEV_SKILL_ID
      ? "PI-Desktop plugin development"
      : "A2A cross-conversation";
  return {
    id,
    name: parsed.name ?? fallback,
    body: parsed.body,
  };
}
