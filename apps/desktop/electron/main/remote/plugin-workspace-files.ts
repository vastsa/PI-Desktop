import type { ProjectGroupRecord, WorkspacePluginFilesRequest } from "@pi-desktop/shared";
import type { PluginRemoteFilesRead } from "../plugin-remote-files";

type Host = { call<T>(method: string, input?: unknown): Promise<T> };
type Boot = { workspacePluginFiles(hostKey: string, input: WorkspacePluginFilesRequest): Promise<unknown> };
const failure = (code: string, message: string) => Object.assign(new Error(message), { code });

/** The plugin supplies an admitted identity; only durable Host-owned records choose the machine. */
export function createPluginWorkspaceReader(deps: {
  getHost: () => Host | null;
  getBoot: () => Boot | null;
}): PluginRemoteFilesRead {
  return async ({ workspacePath, operation, ref, scope }) => {
    const owner = deps.getHost(); const boot = deps.getBoot();
    if (!owner || !boot) throw failure("HOST_UNAVAILABLE", "Remote workspace Host is unavailable");
    const currentBinding = async () => {
      const { groups } = await owner.call<{ groups: ProjectGroupRecord[] }>("project.groups.list");
      if (deps.getHost() !== owner || deps.getBoot() !== boot) throw failure("HOST_UNAVAILABLE", "Workspace Host was replaced");
      const remote = groups.find(group => group.primaryPath === workspacePath)?.remote;
      if (!workspacePath.startsWith("remote-project:") || !remote) throw failure("NOT_FOUND", "Remote workspace binding is unavailable");
      return { hostKey: remote.hostKey, path: remote.path };
    };
    const binding = await currentBinding();
    const result = await boot.workspacePluginFiles(binding.hostKey, { path: binding.path, operation, ref, scope });
    const next = await currentBinding();
    if (binding.hostKey !== next.hostKey || binding.path !== next.path) {
      throw failure("WORKSPACE_CHANGED", "Remote workspace binding changed during the file request");
    }
    return result;
  };
}
