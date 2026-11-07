import type { PluginWorkspaceInfo } from "@pi-desktop/shared";

export type PluginWorkspaceServices = {
  getWorkspacePath: () => string | null;
  getWorkspacePathForSession?: (sessionId: string) => string | null;
  getWorkspaceInfo?: (workspacePath?: string | null) => PluginWorkspaceInfo | null;
};

/** The same host-owned project identity drives discovery and filesystem roots. */
export function pluginWorkspacePath(services: PluginWorkspaceServices, sessionId?: string): string | null {
  const scoped = sessionId ? services.getWorkspacePathForSession?.(sessionId) : null;
  return scoped ?? services.getWorkspacePath();
}

const singleRoot = (path: string | null): PluginWorkspaceInfo | null => path
  ? { path, name: path.split(/[\\/]/).filter(Boolean).at(-1) || path }
  : null;

export function pluginWorkspaceForCall(services: PluginWorkspaceServices, sessionId?: string): PluginWorkspaceInfo | null {
  const scoped = sessionId ? services.getWorkspacePathForSession?.(sessionId) : null;
  if (scoped != null) {
    const info = services.getWorkspaceInfo?.(scoped);
    // Older providers may ignore the path argument. Never project the visible
    // project's group metadata onto a different background tool session.
    return info?.path === scoped ? info : singleRoot(scoped);
  }
  const info = services.getWorkspaceInfo?.();
  return info !== undefined ? info : singleRoot(services.getWorkspacePath());
}
