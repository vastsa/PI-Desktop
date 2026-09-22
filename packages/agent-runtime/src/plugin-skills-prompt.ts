import type { PluginSkillDef } from "./plugin-skills.js";

export type { PluginSkillDef };

/** Tool the model calls to pull a skill document into context on demand. */
export const SKILL_TOOL_NAME = "skill";

/**
 * Render the skill catalog for the system prompt (D174: skills are
 * model-invoked). Only id/name/description ship up front — the body is loaded
 * through the `skill` tool when the model decides a skill applies, so a long
 * document costs nothing until it is needed.
 */
export function pluginSkillsPrompt(skills: PluginSkillDef[]): string | undefined {
  if (!skills.length) return undefined;
  return [
    "# Skills",
    "",
    `Plugins have taught you the following skills. Each entry is a set of instructions you can load with the \`${SKILL_TOOL_NAME}\` tool by passing its exact id. When a task matches a skill's description, load the skill first and follow it; do not guess at its content. Load each skill at most once per task.`,
    "",
    ...skills.map((skill) => {
      const description = skill.description?.trim();
      return `- \`${skill.id}\` — ${skill.name}${description ? `: ${description}` : ""}`;
    }),
  ].join("\n");
}
