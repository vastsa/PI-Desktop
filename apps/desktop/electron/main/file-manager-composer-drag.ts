import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { referenceComposerFiles } from "./composer-file-references.ts";
import {
  checkFileManagerComposerRegistry,
  fileLinePathInProject,
  fileManagerComposerTarget,
  type FileManagerComposerContext,
} from "./file-line-reference.ts";

const DRAG_TTL_MS = 60_000;
type Target = NonNullable<ReturnType<typeof fileManagerComposerTarget>>;

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
      const entry = lstatSync(path, { throwIfNoEntry: false });
      if (!entry?.isFile()) return null;
      const canonicalPath = realpathSync(path);
      if (!fileLinePathInProject(path, projectPath, canonicalPath)) return null;
      const [reference] = await referenceComposerFiles(dataDir, sessionId, projectPath, [canonicalPath]);
      return reference?.path === canonicalPath && context.getHost() === host &&
        isCurrent() && fileLinePathInProject(path, projectPath, canonicalPath) ? reference : null;
    },
  };
}
