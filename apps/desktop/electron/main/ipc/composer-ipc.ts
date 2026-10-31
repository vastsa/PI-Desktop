import { userMcpToolName } from "@pi-desktop/plugin-sdk";
import type { UserMcpRuntime } from "../user-mcp";
import { IPC, isActiveInProject, trustedExtensionCommandId, type ComposerCommand } from "@pi-desktop/shared";
import { builtinSkills } from "../builtin-skills";
import { builtinComposerCommands } from "../builtin-commands";
import type { AgentExtensionBridge } from "../agent-extensions";
import type { PluginRuntime } from "../plugin-runtime";
import type { IpcRegistrar } from "./types";

type ComposerTemplateSource = "user" | "project";

export type ComposerIpcDependencies = {
  registrar: IpcRegistrar;
  plugins: PluginRuntime;
  userMcp?: Pick<UserMcpRuntime, "listRecords" | "listStatuses" | "toolsForProject">;
  refreshUserMcp?: (root: string | null) => Promise<unknown>;
  agentExtensions: AgentExtensionBridge;
  optionalWorkspaceRoot: () => Promise<string | null>;
  activeUserSkills: (root?: string) => Promise<Array<{
    id: string;
    name: string;
    description?: string;
  }>>;
  disabledBuiltinSkills?: () => Promise<string[]>;
  pluginActiveInProject: (pluginId: string, projectPath: string | null | undefined) => boolean;
  loadComposerTemplatesCached: (root: string | null) => Promise<Array<{
    name: string;
    description?: string;
    argumentHint?: string;
    source?: ComposerTemplateSource;
  }>>;
};

export type ComposerCommandOptions = {
  /** The session runs on a remote host, so local-only builtin skills are left out. */
  remote?: boolean;
};

export type ComposerCommandService = {
  buildComposerCommands: (
    root: string | null,
    options?: ComposerCommandOptions,
  ) => Promise<ComposerCommand[]>;
};

export function createComposerCommandService({
  plugins,
  userMcp,
  refreshUserMcp,
  agentExtensions,
  activeUserSkills,
  disabledBuiltinSkills = async () => [],
  pluginActiveInProject,
  loadComposerTemplatesCached,
}: Omit<ComposerIpcDependencies, "registrar" | "optionalWorkspaceRoot">): ComposerCommandService {
  const loadComposerSkillCommands = async (
    root: string | null,
    remote: boolean,
  ): Promise<ComposerCommand[]> => {
    const builtins = builtinSkills({
      workspacePath: root,
      remote,
      pluginPaths: plugins.listLoaded().map((loaded) => loaded.path),
      disabledIds: await disabledBuiltinSkills(),
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
          name: `skill:${skill.id}`,
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
    options: ComposerCommandOptions = {},
  ): Promise<ComposerCommand[]> => {
    await refreshUserMcp?.(root);
    await userMcp?.toolsForProject(root);
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
    const skillCommands = await loadComposerSkillCommands(root, options.remote === true).catch(() => []);
    const statuses = userMcp?.listStatuses() ?? [];
    const ready = new Set(statuses
      .filter((status) => status.state === "ready" && status.toolCount > 0)
      .map((status) => status.serverId));
    const mcpCommands: ComposerCommand[] = (userMcp?.listRecords() ?? [])
      .filter((record) => ready.has(record.id) && isActiveInProject(record, root))
      .flatMap((record) => {
        const server: ComposerCommand = {
          name: `mcp:${encodeURIComponent(record.id)}`,
          kind: "mcp",
          title: record.label,
          mcpServerId: record.id,
        };
        const names = statuses.find(status => status.serverId === record.id)?.toolNames ?? [];
        return [server, ...[...new Set(names)].map(toolName => ({
          ...server,
          name: `${server.name}:${encodeURIComponent(toolName)}`,
          mcpToolName: userMcpToolName(record.id, toolName),
        }))];
      });
    const merged = new Map<string, ComposerCommand>();
    for (const command of [
      ...builtinComposerCommands(),
      ...templateCommands,
      ...pluginCommands,
      ...extensionCommands,
      ...mcpCommands,
      ...skillCommands,
    ]) {
      if (!merged.has(command.name)) merged.set(command.name, command);
    }
    return [...merged.values()];
  };

  return { buildComposerCommands };
}

export function registerComposerIpc({
  registrar,
  optionalWorkspaceRoot,
  ...serviceDependencies
}: ComposerIpcDependencies): ComposerCommandService {
  const service = createComposerCommandService(serviceDependencies);
  registrar.handle(IPC.invoke.composerCommands, async () => {
    const root = await optionalWorkspaceRoot();
    return { commands: await service.buildComposerCommands(root) };
  });
  return service;
}
