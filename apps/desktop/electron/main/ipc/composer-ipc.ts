import { IPC, trustedExtensionCommandId, type ComposerAgent, type ComposerCommand } from "@pi-desktop/shared";
import { builtinSkills } from "../builtin-skills";
import { builtinComposerCommands } from "../builtin-commands";
import type { AgentExtensionBridge } from "../agent-extensions";
import type { PluginRuntime } from "../plugin-runtime";
import type { SubagentCatalogLoader } from "../subagent-catalog";
import type { IpcRegistrar } from "./types";

type ComposerTemplateSource = "user" | "project";

export type ComposerIpcDependencies = {
  registrar: IpcRegistrar;
  plugins: PluginRuntime;
  agentExtensions: AgentExtensionBridge;
  optionalWorkspaceRoot: () => Promise<string | null>;
  activeUserSkills: (root?: string) => Promise<Array<{
    id: string;
    name: string;
    description?: string;
  }>>;
  pluginActiveInProject: (pluginId: string, projectPath: string | null | undefined) => boolean;
  loadComposerTemplatesCached: (root: string | null) => Promise<Array<{
    name: string;
    description?: string;
    argumentHint?: string;
    source?: ComposerTemplateSource;
  }>>;
  /** The delegation catalog `Task` is built from; also backs the "@" menu. */
  loadSubagentCatalog: SubagentCatalogLoader;
};

export type ComposerCommandService = {
  buildComposerCommands: (root: string | null) => Promise<ComposerCommand[]>;
  /**
   * The delegates the "@" menu offers. Read from the same catalog `Task` is
   * built from, so the menu can never name a handle the runtime would reject.
   * A disabled builtin is absent, not greyed out: it is not delegable now.
   */
  buildComposerAgents: (root: string | null) => Promise<ComposerAgent[]>;
};

export function createComposerCommandService({
  plugins,
  agentExtensions,
  activeUserSkills,
  pluginActiveInProject,
  loadComposerTemplatesCached,
  loadSubagentCatalog,
}: Omit<
  ComposerIpcDependencies,
  "registrar" | "optionalWorkspaceRoot"
>): ComposerCommandService {
  /**
   * Agent mode is the only mode that registers `Task`, so the group is a list
   * of handles rather than a mode switch: it is filtered by the caller, and
   * Plan/Goal simply never ask for it.
   */
  const buildComposerAgents = async (
    root: string | null,
  ): Promise<ComposerAgent[]> => {
    const { subagents } = await loadSubagentCatalog(root ?? undefined);
    return subagents.map((definition) => ({
      name: definition.name,
      ...(definition.description ? { description: definition.description } : {}),
    }));
  };
  const loadComposerSkillCommands = async (
    root: string | null,
  ): Promise<ComposerCommand[]> => {
    const builtins = builtinSkills({
      workspacePath: root,
      pluginPaths: plugins.listLoaded().map((loaded) => loaded.path),
    });
    const pluginSkills = plugins
      .getSkills()
      .filter((skill) => pluginActiveInProject(skill.pluginId, root))
      .map((skill) => ({
        id: skill.id,
        name: skill.name,
        description: skill.description,
      }));
    const userSkills = (await activeUserSkills(root ?? undefined)).map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
    }));
    const seen = new Set<string>();
    return [...builtins, ...pluginSkills, ...userSkills].flatMap((skill) => {
      if (!skill.id || seen.has(skill.id)) return [];
      seen.add(skill.id);
      return [
        {
          name: skill.id,
          kind: "skill" as const,
          title: skill.name,
          ...(skill.description ? { description: skill.description } : {}),
          skillId: skill.id,
        },
      ];
    });
  };

  const buildComposerCommands = async (
    root: string | null,
  ): Promise<ComposerCommand[]> => {
    const templates = await loadComposerTemplatesCached(root).catch(() => []);
    const templateCommands = templates.map((template) => ({
      name: template.name,
      kind: "template" as const,
      title: template.name,
      ...(template.description ? { description: template.description } : {}),
      ...(template.argumentHint ? { argumentHint: template.argumentHint } : {}),
      source: template.source,
    }));
    const pluginCommands = plugins
      .getCommands()
      .filter((command) => pluginActiveInProject(command.pluginId, root))
      .map((command) => ({
        name: command.id,
        kind: "plugin" as const,
        title: command.title,
        ...(command.category ? { description: command.category } : {}),
        id: command.id,
      }));
    const extensionCommands = agentExtensions.allCommands().map((command) => ({
      name: command.name,
      kind: "extension" as const,
      title: `/${command.name}`,
      description: command.description ?? command.extensionLabel,
      id: trustedExtensionCommandId(command.name),
    }));
    const skillCommands = await loadComposerSkillCommands(root).catch(() => []);
    const merged = new Map<string, ComposerCommand>();
    for (const command of [
      ...builtinComposerCommands(),
      ...templateCommands,
      ...pluginCommands,
      ...extensionCommands,
      ...skillCommands,
    ]) {
      if (!merged.has(command.name)) merged.set(command.name, command);
    }
    return [...merged.values()];
  };

  return { buildComposerCommands, buildComposerAgents };
}

export function registerComposerIpc({
  registrar,
  optionalWorkspaceRoot,
  ...serviceDependencies
}: ComposerIpcDependencies): ComposerCommandService {
  const service = createComposerCommandService(serviceDependencies);
  registrar.handle(IPC.invoke.composerCommands, async () => {
    const root = await optionalWorkspaceRoot();
    // One read serves both menus. A catalog that cannot be read must not
    // blank the "/" list, which still works without delegation.
    const agents = await service.buildComposerAgents(root).catch(() => []);
    return { commands: await service.buildComposerCommands(root), agents };
  });
  return service;
}
