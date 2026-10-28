import { readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { RacpError } from "@pi-desktop/agent-host";
import { previewFile } from "@pi-desktop/host-runtime";
import { isDeniedFsPath, isFsPathInScope, PLUGIN_FS_LIST_MAX_ENTRIES } from "@pi-desktop/plugin-sdk";
import type { WorkspacePluginFilesRequest, WorkspacePluginFilesResult } from "@pi-desktop/shared";
import type { RacpHostOperations } from "@pi-desktop/racp";

const SKIPPED_DIRECTORIES = new Set([".git", "node_modules", ".venv", "__pycache__"]);
const forbidden = () => new RacpError("REMOTE_PATH_FORBIDDEN", "path is outside the plugin's readable workspace");
const inside = (root: string, target: string) => {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};
const relativePath = (root: string, target: string) => relative(root, target).split(sep).join("/");

function normalizeRef(ref: string): string {
  if (typeof ref !== "string" || /[\u0000-\u001f]/.test(ref) || /^(?:[\\/]|[a-zA-Z]:)/.test(ref)) {
    throw new RacpError("INVALID_ARGUMENT", "plugin paths must be root-relative");
  }
  const parts = ref.replaceAll("\\", "/").split("/").filter((part) => part && part !== ".");
  if (parts.includes("..")) throw forbidden();
  return parts.join("/");
}

async function canonical(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new RacpError("REMOTE_PATH_NOT_FOUND", "workspace path does not exist");
    }
    throw error;
  }
}

/** A separate read-only boundary: ordinary owner workspace reads are not plugin grants. */
export function createWorkspacePluginFiles(options: {
  browseRoot: string;
  protectedPaths: readonly string[];
  isRegisteredRoot?: (path: string) => Promise<boolean>;
}): NonNullable<RacpHostOperations["workspacePluginFiles"]> {
  return { async read(input: WorkspacePluginFilesRequest): Promise<WorkspacePluginFilesResult> {
    if (!isAbsolute(input.path) || /[\u0000-\u001f]/.test(input.path)
      || !Array.isArray(input.scope) || !input.scope.every((pattern) => typeof pattern === "string")) {
      throw new RacpError("INVALID_ARGUMENT", "invalid plugin workspace request");
    }
    const ref = normalizeRef(input.ref);
    const [root, browseRoot] = await Promise.all([canonical(input.path), canonical(options.browseRoot)]);
    const protectedRoots = await Promise.all(options.protectedPaths.map(async (path) => {
      try { return await realpath(path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return resolve(path);
        throw error;
      }
    }));
    const protectedPath = (path: string) => protectedRoots.some((guarded) => inside(guarded, path));
    if (protectedPath(root) || isDeniedFsPath(root)) throw forbidden();
    if (!inside(browseRoot, root) && !(await options.isRegisteredRoot?.(root))) throw forbidden();
    if (!(await stat(root)).isDirectory()) throw new RacpError("INVALID_ARGUMENT", "workspace is not a directory");

    const authorize = async (requested: string, file: boolean) => {
      if (isDeniedFsPath(requested)) throw forbidden();
      const target = await canonical(join(root, requested));
      const actual = relativePath(root, target);
      if (!inside(root, target) || protectedPath(target) || isDeniedFsPath(target) || isDeniedFsPath(actual)) throw forbidden();
      if (file && (!isFsPathInScope(requested, input.scope) || !isFsPathInScope(actual, input.scope))) throw forbidden();
      return target;
    };
    const target = await authorize(ref, input.operation === "preview");
    const info = await stat(target);
    if (input.operation === "preview") {
      if (!info.isFile()) throw new RacpError("INVALID_ARGUMENT", "only regular files can be previewed");
      const preview = await previewFile(target, ref);
      const metadata = { size: preview.size, mtimeMs: info.mtimeMs };
      if (preview.kind === "text") {
        if (typeof preview.content !== "string") throw new RacpError("INTERNAL", "text preview is missing its content");
        return { ...metadata, kind: "text", content: preview.content };
      }
      if (preview.kind === "image") {
        if (typeof preview.dataUrl !== "string") throw new RacpError("INTERNAL", "image preview is missing its data");
        return { ...metadata, kind: "image", dataUrl: preview.dataUrl };
      }
      return { ...metadata, kind: preview.kind };
    }
    if (input.operation !== "list" || !info.isDirectory()) {
      throw new RacpError("INVALID_ARGUMENT", "only directories can be listed");
    }
    const entries: Extract<WorkspacePluginFilesResult, { kind: "list" }>["entries"] = [];
    for (const entry of (await readdir(target, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entries.length >= PLUGIN_FS_LIST_MAX_ENTRIES) break;
      const childRef = ref ? `${ref}/${entry.name}` : entry.name;
      try {
        const child = await authorize(childRef, false);
        const childInfo = await stat(child);
        if (childInfo.isDirectory()) {
          if (!SKIPPED_DIRECTORIES.has(entry.name)) entries.push({ name: entry.name, path: childRef, isDirectory: true });
        } else if (childInfo.isFile()) {
          await authorize(childRef, true);
          entries.push({ name: entry.name, path: childRef, isDirectory: false, size: childInfo.size, mtimeMs: childInfo.mtimeMs });
        }
      } catch (error) {
        // Forbidden or vanished entries are absent from a plugin's readable tree.
        if (error instanceof RacpError && ["REMOTE_PATH_FORBIDDEN", "REMOTE_PATH_NOT_FOUND"].includes(error.code)) continue;
        throw error;
      }
    }
    return { kind: "list", entries };
  } };
}
