import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { normalizeProjectPath, type SessionSummary } from "@pi-desktop/shared";
import { discardComposerFileReference, referenceComposerFiles } from "./composer-file-references.ts";
import {
  checkFileManagerComposerRegistry,
  fileLinePathInProject,
  fileManagerComposerTarget,
  type FileManagerComposerContext,
} from "./file-line-reference.ts";

const DRAG_TTL_MS = 60_000;
type Target = NonNullable<ReturnType<typeof fileManagerComposerTarget>>;
type DropSession = Pick<SessionSummary, "projectPath" | "remoteWorkspace" | "worktree">;

async function resolveDragFile(path: string): Promise<string | null> {
  try {
    return (await lstat(path)).isFile() ? await realpath(path) : null;
  } catch (error) {
    if (["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      return null;
    }
    throw error;
  }
}

export function createFileManagerComposerDrag(
  context: FileManagerComposerContext,
  dataDir: string,
  now = Date.now,
) {
  let pending: {
    token: string;
    senderId: number;
    workspace: string;
    path: string;
    target: Target;
    expiresAt: number;
  } | null = null;

  return {
    begin(senderId: number, payload: unknown): string | null {
      const input = payload as { path?: unknown; workspace?: unknown } | null;
      const path = input?.path;
      const workspace = input?.workspace;
      if (
        typeof path !== "string" || !isAbsolute(path) || path.length > 4096 || /[\0\r\n]/.test(path) ||
        typeof workspace !== "string" || workspace.length > 4096
      ) return null;
      const target = fileManagerComposerTarget(context, senderId, workspace);
      if (!target || !target.selected.projectPath || !isAbsolute(target.selected.projectPath)) return null;
      if (!/^[A-Za-z0-9_-]+$/.test(target.selected.sessionId)) return null;
      const token = randomUUID();
      pending = { token, senderId, workspace, path, target, expiresAt: now() + DRAG_TTL_MS };
      return token;
    },

    async drop(payload: unknown) {
      const input = payload as { token?: unknown; sessionId?: unknown } | null;
      const drag = pending;
      if (!drag || input?.token !== drag.token) return null;
      pending = null;
      const { target, path } = drag;
      const { sessionId, projectPath } = target.selected;
      if (drag.expiresAt <= now() || input.sessionId !== sessionId || !projectPath) return null;

      const isCurrent = () => {
        const current = fileManagerComposerTarget(context, drag.senderId, drag.workspace);
        return current?.loaded === target.loaded &&
          current.selected.sessionId === sessionId && current.selected.projectPath === projectPath;
      };
      if (!isCurrent()) return null;
      const host = await checkFileManagerComposerRegistry(context, target.loaded);
      if (context.getHost() !== host || !isCurrent()) return null;
      const { session } = await host.call<{ session?: DropSession }>(
        "session.get", { id: sessionId, messageLimit: 1, contentLimit: 1 }, 5_000,
      );
      // File Manager shows the project tree. An isolated session runs in a
      // different checkout, so the visible project file is not its counterpart.
      if (!session || session.remoteWorkspace || session.worktree ||
          normalizeProjectPath(session.projectPath) !== normalizeProjectPath(projectPath)) return null;

      const canonicalPath = await resolveDragFile(path);
      if (!canonicalPath || context.getHost() !== host || !isCurrent() ||
          !fileLinePathInProject(path, projectPath, canonicalPath)) return null;
      const [reference] = await referenceComposerFiles(dataDir, sessionId, projectPath, [canonicalPath]);
      if (!reference) return null;
      if (reference.path === canonicalPath && context.getHost() === host &&
          isCurrent() && fileLinePathInProject(path, projectPath, canonicalPath)) return reference;
      await discardComposerFileReference(dataDir, reference.localReference);
      return null;
    },
  };
}
