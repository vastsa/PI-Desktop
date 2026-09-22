/**
 * Plugin skills: instruction documents a plugin contributes to the agent
 * through `contributes.skills`.
 *
 * Only the catalog — id, name, description — travels into the system prompt;
 * the model loads a body on demand with the `skill` tool (D174). Reading the
 * files therefore belongs entirely to Electron main, which owns the plugin
 * registry and the permission grants. This module owns the catalog shape and
 * the reuse digest so the sidecar and main agree on both.
 */

/** One catalog entry as the model sees it in the system prompt. */
export type PluginSkillDef = {
  /** `<pluginId>/<skillId>` — the exact id the `skill` tool expects. */
  id: string;
  name: string;
  description?: string;
};

/**
 * Stable fingerprint of a skill catalog.
 *
 * `AgentRuntime.matches()` compares this so enabling a plugin, revoking its
 * prompt permission, or editing a skill's front matter starts a fresh runtime
 * instead of reusing a session whose catalog is already stale. Bodies are not
 * part of it: they never enter the prompt, and the `skill` tool reads them
 * fresh from disk on every call.
 */
export function pluginSkillsDigest(skills?: PluginSkillDef[]): string {
  if (!skills?.length) return "";
  return skills
    .map((skill) => `${skill.id}:${skill.name}:${skill.description ?? ""}`)
    .join("|");
}
