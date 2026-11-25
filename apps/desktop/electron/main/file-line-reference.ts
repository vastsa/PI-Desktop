import { realpathSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import { normalizeProjectPath, parseFileLineReference, type FileLineReference } from "@pi-desktop/shared";
import type { HostProcess } from "./host-process";
import type { PluginRuntime } from "./plugin-runtime";
import type { PluginViewHost } from "./plugin-view-host";
import type { PluginSessionContext } from "./services/plugin-session-context";
import { projectFolderPaths } from "./workspace-roots.ts";

export const FILE_LINES_VIEW_KEY = "pi.file-manager/manager";

type LoadedPlugin = NonNullable<ReturnType<PluginRuntime["getLoaded"]>>;

export function canUseFileLineView(loaded: LoadedPlugin | undefined): loaded is LoadedPlugin {
  return !!loaded && !loaded.development && !loaded.disposing &&
    loaded.permissions.has("fs.read") && loaded.permissions.has("ui.view");
}

export type FileManagerComposerContext = {
  plugins: Pick<PluginRuntime, "getLoaded">;
  pluginViews: Pick<PluginViewHost, "isVisibleViewSender">;
  pluginSession: Pick<PluginSessionContext, "snapshot">;
  pluginActiveInProject: (pluginId: string, projectPath: string | null) => boolean;
  getHost: () => Pick<HostProcess, "call"> | null;
  getWorkspacePath: () => string | null;
};

type FileLineBridge = FileManagerComposerContext & {
  publish: (selection: { sessionId: string; reference: FileLineReference }) => void;
};

export function fileManagerComposerTarget(
  bridge: FileManagerComposerContext,
  senderId: number | undefined,
  workspace: string,
) {
  const pluginId = "pi.file-manager";
  const loaded = bridge.plugins.getLoaded(pluginId);
  const selected = bridge.pluginSession.snapshot();
  if (
    !selected || !canUseFileLineView(loaded) ||
    !bridge.pluginViews.isVisibleViewSender(senderId, FILE_LINES_VIEW_KEY) ||
    !bridge.pluginActiveInProject(pluginId, selected.projectPath) ||
    normalizeProjectPath(workspace) !== normalizeProjectPath(bridge.getWorkspacePath())
  ) return null;
  return { loaded, selected };
}

export async function checkFileManagerComposerRegistry(
  bridge: FileManagerComposerContext,
  loaded: LoadedPlugin,
) {
  const host = bridge.getHost();
  if (!host) {
    throw Object.assign(new Error("HOST_UNAVAILABLE: The Host is unavailable. Try again when it reconnects."), {
      code: "HOST_UNAVAILABLE",
    });
  }
  const registry = await host.call<{
    plugins: Array<{ id: string; enabled: boolean; version: string }>;
  }>("plugins.list", undefined, 5_000);
  if (!registry?.plugins.some(item => item.id === "pi.file-manager" && item.enabled && item.version === loaded.manifest.version)) {
    throw new Error("The File Manager is not enabled in the Host registry.");
  }
  return host;
}

export async function addFileLinesFromView(
  pluginId: string,
  senderId: number | undefined,
  payload: unknown,
  bridge: FileLineBridge,
): Promise<{ ok: true }> {
  const reference = parseFileLineReference(payload);
  if (!reference) throw new Error("Invalid file line selection.");
  const currentTarget = () => pluginId === "pi.file-manager"
    ? fileManagerComposerTarget(bridge, senderId, reference.workspace)
    : null;
  const target = currentTarget();
  if (!target) throw new Error("The File Manager view or target session is no longer active.");
  if (!fileLinePathInProject(reference.path, target.selected.projectPath)) {
    throw new Error("The file selection is outside the active project.");
  }

  const host = await checkFileManagerComposerRegistry(bridge, target.loaded);
  const current = currentTarget();
  if (
    bridge.getHost() !== host || !current || current.loaded !== target.loaded ||
    current.selected.sessionId !== target.selected.sessionId ||
    current.selected.projectPath !== target.selected.projectPath
  ) throw new Error("The File Manager or target session is no longer active.");
  if (!fileLinePathInProject(reference.path, current.selected.projectPath)) {
    throw new Error("The file selection is outside the active project.");
  }

  bridge.publish({ sessionId: target.selected.sessionId, reference });
  return { ok: true };
}

export function fileLinePathInProject(path: string, projectPath: string | null, canonicalPath?: string): boolean {
  if (typeof path !== "string" || !isAbsolute(path) || path.length > 4096 || /[\0\r\n]/.test(path)) return false;
  const canonical = (value: string) => {
    try { return realpathSync(value); } catch { return value; }
  };
  const target = canonicalPath ?? canonical(path);
  return projectFolderPaths(projectPath).some(root => {
    const contains = (base: string, candidate: string) => {
      const child = relative(base, candidate);
      return child !== "" && child !== ".." && !/^\.\.[/\\]/.test(child) && !isAbsolute(child);
    };
    return contains(root, path) && contains(canonical(root), target);
  });
}
