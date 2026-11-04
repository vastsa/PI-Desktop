import type { PluginSkillDef } from "./plugin-skills.js";

export type { PluginSkillDef };

/** Tool the model calls to pull a skill document into context on demand. */
export const SKILL_TOOL_NAME = "Skill";

/**
 * Render the skill catalog for the system prompt (D174: skills are
 * model-invoked). Only id/name/description ship up front — the body is loaded
 * through the `Skill` tool when the model decides a skill applies, so a long
 * document costs nothing until it is needed.
 */
const SKILLS_HEADER = [
  "# Skills",
  "",
  `Skills available to you, from plugins and from your own library. Each entry is a set of instructions you can load with the \`${SKILL_TOOL_NAME}\` tool by passing its exact id. When a task matches a skill's description, load the skill first and follow it; do not guess at its content. Load each skill at most once per task.`,
  "",
  "When a turn teaches you something reusable — a procedure, a pitfall, a decision rule — record it before you finish, with `skill_manage`: `create` for a new skill, `patch` to extend one you already have, or `write_file` to add `references/<topic>.md` beside it. Capture the rule rather than the afternoon, and prefer patching an existing skill over creating a near-duplicate.",
].join("\n");

export const SKILL_SECTION_PREFIX = "skill:";

function skillEntry(skill: PluginSkillDef): string {
  const description = skill.description?.trim();
  return `- \`${skill.id}\` — ${skill.name}${description ? `: ${description}` : ""}`;
}

/** Stable entry identities let Pi append only the changed or revoked skill. */
export function pluginSkillsPromptSections(skills: readonly PluginSkillDef[]): Record<string, string> {
  if (!skills.length) return {};
  return Object.fromEntries([
    ["skills", SKILLS_HEADER],
    ...[...skills].sort((a, b) => a.id.localeCompare(b.id))
      .map((skill) => [`${SKILL_SECTION_PREFIX}${skill.id}`, skillEntry(skill)]),
  ]);
}

export function pluginSkillsPrompt(skills: PluginSkillDef[]): string | undefined {
  if (!skills.length) return undefined;
  return `${SKILLS_HEADER}\n\n${skills.map(skillEntry).join("\n")}`;
}
