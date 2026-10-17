import { realpath, stat } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import { RacpError } from "@pi-desktop/agent-host";
import { loadProjectInstructions } from "@pi-desktop/agent-runtime";
import { collectWorkspaceDiff, getWorkspaceFileIndex, isChatRefOutsideRoots, listDir, readOpenableFile, readOpenableImage, resolveChatFileRef } from "@pi-desktop/host-runtime";
import type { RacpHostOperations } from "@pi-desktop/racp";

/** File views are rooted in the explicit SSH workspace, without Host sessions. */
export function createWorkspaceFiles(): NonNullable<RacpHostOperations["workspaceFiles"]> {
  return { async read(input) {
    if (!isAbsolute(input.path) || /[\u0000-\u001f]/.test(input.path)) throw new RacpError("INVALID_ARGUMENT", "invalid workspace root");
    const root = await realpath(input.path).catch(() => undefined);
    if (!root || !(await stat(root)).isDirectory()) throw new RacpError("REMOTE_PATH_NOT_FOUND", "workspace directory is unavailable");
    const ref = input.ref ?? "";
    try {
      switch (input.operation) {
        case "list": return { entries: await listDir(root, ref) };
        case "read": return await readOpenableFile(ref, root, [], input.mimeType);
        case "image": return await readOpenableImage(ref, root, [], input.mimeType);
        case "index": return await getWorkspaceFileIndex(root);
        case "diff": return await collectWorkspaceDiff(root);
        case "instructions": return (await loadProjectInstructions(root)) ?? { entries: [] };
        case "resolve": {
          const roots = { project: [{ path: root, name: basename(root), primary: true }] };
          if (await isChatRefOutsideRoots(ref, roots)) return { match: null, reason: "outside-allowed-roots" };
          return { match: await resolveChatFileRef(ref, roots) };
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/escapes workspace root|outside allowed roots|not openable/.test(message)) throw new RacpError("REMOTE_PATH_FORBIDDEN", message);
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") throw new RacpError("REMOTE_PATH_NOT_FOUND", message);
      throw error;
    }
  } };
}
