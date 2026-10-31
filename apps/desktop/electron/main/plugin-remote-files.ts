import * as Value from "typebox/value";
import { WorkspacePluginFilesResultSchema,
  type WorkspacePluginFilesRequest, type WorkspacePluginFilesResult } from "@pi-desktop/shared";
import type { PluginFsReadOptions } from "@pi-desktop/plugin-sdk";

export type PluginRemoteFilesRequest = Omit<WorkspacePluginFilesRequest, "path"> & { workspacePath: string };
export type PluginRemoteFilesRead = (request: PluginRemoteFilesRequest) => Promise<unknown>;

const failure = (code: string, message: string) => Object.assign(new Error(message), { code });
export function pluginFsReadOptions(value: unknown): PluginFsReadOptions | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw failure("INVALID_ARGUMENT", "workspacePath must be a string");
  return { workspacePath: value };
}
export function assertLocalPluginRoot(root: string | null): void {
  if (root?.startsWith("remote-project:")) {
    throw failure("UNSUPPORTED", "This file operation does not support remote workspaces");
  }
}

/** Keep remote file admission and validation outside the plugin lifecycle orchestrator. */
export async function readRemotePluginFiles(context: {
  workspacePath: string | null;
  currentWorkspacePath: () => string | null;
  isActive: () => boolean;
  scope: readonly string[];
  read?: PluginRemoteFilesRead;
  audit: (entry: Record<string, unknown>) => void;
}, operation: "list" | "preview", ref: string, options?: PluginFsReadOptions): Promise<WorkspacePluginFilesResult | null> {
  const root = context.workspacePath;
  if (options !== undefined && (!options || typeof options !== "object" || typeof options.workspacePath !== "string")) {
    throw failure("INVALID_ARGUMENT", "workspacePath must be a string");
  }
  if (options && options.workspacePath !== root) throw failure("WORKSPACE_CHANGED", "The file view's workspace has changed");
  if (!root?.startsWith("remote-project:")) return null;
  const api = operation === "list" ? "fs.list" : "fs.readPreview";
  try {
    if (typeof ref !== "string" || /[\u0000-\u001f]/.test(ref) || /^(?:[\\/]|[a-zA-Z]:)/.test(ref)) {
      throw failure("INVALID_ARGUMENT", "Remote plugin paths must be root-relative");
    }
    const parts = ref.replaceAll("\\", "/").split("/").filter(part => part && part !== ".");
    if (parts.includes("..")) throw failure("INVALID_ARGUMENT", "Remote plugin paths must stay inside the workspace");
    const normalizedRef = parts.join("/");
    if (!context.read) throw failure("UNSUPPORTED", "Remote plugin file access is unavailable; upgrade Desktop and pi-host");
    const result = await context.read({ workspacePath: root, operation, ref: normalizedRef, scope: [...context.scope] });
    if (!context.isActive()) throw failure("PLUGIN_UNLOADED", "The plugin was unloaded during the file request");
    if (context.currentWorkspacePath() !== root) throw failure("WORKSPACE_CHANGED", "The file view's workspace has changed");
    if (!Value.Check(WorkspacePluginFilesResultSchema, result)
      || (operation === "list") !== (result.kind === "list")) {
      throw failure("INVALID_RESPONSE", "Remote Host returned an invalid plugin file response");
    }
    if (result.kind === "list") {
      for (const entry of result.entries) {
        const expected = normalizedRef ? `${normalizedRef}/${entry.name}` : entry.name;
        if (/[\\/\u0000-\u001f]/.test(entry.name) || [".", ".."].includes(entry.name) || entry.path !== expected) {
          throw failure("INVALID_RESPONSE", "Remote Host returned an invalid directory entry");
        }
      }
    }
    context.audit({ api, ok: true, path: normalizedRef, remote: true, ts: Date.now() });
    return result;
  } catch (error) {
    const record = error as { code?: string; errorCode?: string };
    context.audit({ api, ok: false, path: ref, remote: true, errorCode: record.errorCode ?? record.code ?? "UNKNOWN", ts: Date.now() });
    throw error;
  }
}
