import { projectCapabilityAllowed } from "@pi-desktop/shared";
import type { LocalToolHandler } from "@pi-desktop/host-runtime";
import { assertBuiltinSkillEnabled, loadBuiltinSkillBody } from "./builtin-skills";
import { formatSkillToolContent, type LoadedSkillDocument } from "./skill-document";

export type SkillToolDependencies = {
  sessionProjects: ReadonlyMap<string, string | null>;
  disabledBuiltinSkills: () => Promise<string[]>;
  loadUserSkillBody: (id: string, projectPath: string | null) => Promise<LoadedSkillDocument | null>;
  activeUserSkills: (projectPath: string | undefined) => Promise<readonly { id: string }[]>;
  selectedSkillIds?: (projectPath: string | null) => Promise<readonly string[] | undefined>;
  plugins: {
    getSkills: () => readonly { id: string; pluginId: string }[];
    loadSkillBody: (id: string) => LoadedSkillDocument;
  };
  pluginActiveInProject: (pluginId: string, projectPath: string | null | undefined) => boolean;
};

/** Main owns document resolution; children use the same session-scoped bridge. */
export function createSkillToolHandler(input: SkillToolDependencies): LocalToolHandler {
  return async ({ args, sessionId }) => {
    const id = String((args as { id?: unknown })?.id ?? "").trim();
    if (!id) return { ok: false, isError: true,
      content: "Skill: `id` is required. Use an id from the Skills section." };
    const projectPath = input.sessionProjects.get(sessionId) ?? null;
    const assertCurrentProject = () => {
      if ((input.sessionProjects.get(sessionId) ?? null) !== projectPath) {
        throw new Error("Session project changed while loading a skill");
      }
    };
    try {
      const selected = await input.selectedSkillIds?.(projectPath);
      if (!projectCapabilityAllowed(selected, id)) throw new Error("Skill is not selected for this project");
      await assertBuiltinSkillEnabled(id, input.disabledBuiltinSkills);
      assertCurrentProject();
      let skill = loadBuiltinSkillBody(id) ?? await input.loadUserSkillBody(id, projectPath);
      assertCurrentProject();
      if (!skill) {
        const definition = input.plugins.getSkills().find((candidate) => candidate.id === id);
        if (!definition || !input.pluginActiveInProject(definition.pluginId, projectPath)) {
          throw new Error("Skill is not available in this project");
        }
        skill = input.plugins.loadSkillBody(id);
      }
      const currentSelection = await input.selectedSkillIds?.(projectPath);
      assertCurrentProject();
      if (!projectCapabilityAllowed(currentSelection, id)) throw new Error("Skill is no longer selected for this project");
      return { ok: true, content: formatSkillToolContent(skill) };
    } catch (error) {
      const hintProject = input.sessionProjects.get(sessionId) ?? null;
      const selected = await input.selectedSkillIds?.(hintProject).catch(() => []);
      const userIds = (await input.activeUserSkills(hintProject ?? undefined)).map((skill) => skill.id);
      const pluginIds = input.plugins.getSkills()
        .filter((skill) => input.pluginActiveInProject(skill.pluginId, hintProject)).map((skill) => skill.id);
      const available = (input.sessionProjects.get(sessionId) ?? null) === hintProject
        ? [...userIds, ...pluginIds].filter((key) => projectCapabilityAllowed(selected, key)).join(", ") : "";
      return { ok: false, isError: true,
        content: `Skill: ${error instanceof Error ? error.message : String(error)}.${available ? ` Available skills: ${available}.` : ""}` };
    }
  };
}
