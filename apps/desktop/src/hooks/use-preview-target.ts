import { useCallback } from "react";
import { useAppStore } from "../stores/app-store";
import { api } from "../lib/api";
import {
  isHtmlFilePath,
  toWorkspaceRel,
  type ChatPreviewTarget,
} from "../lib/chat-links";

/**
 * Open a resolved chat reference in the work panel: files in the viewer, URLs
 * in the embedded browser. Shared by the transcript's tool row summaries and
 * tool result file/match lists.
 */
export function useOpenPreviewTarget() {
  const openFile = useAppStore((s) => s.openFileInWorkPanel);
  const openUrl = useAppStore((s) => s.openUrlInWorkPanel);
  return useCallback(
    (target: ChatPreviewTarget) => {
      if (target.kind === "file") openFile(target.path);
      else openUrl(target.url);
    },
    [openFile, openUrl],
  );
}

/**
 * Open a user-message file chip: workspace HTML in the side browser, every
 * other allowed path with the OS default handler (D320).
 */
export function useOpenChatFileRef() {
  const workspacePath = useAppStore((s) => s.workspace?.path ?? null);
  const openUrl = useAppStore((s) => s.openUrlInWorkPanel);
  const showToast = useAppStore((s) => s.showToast);
  return useCallback(
    (path: string) => {
      const rel = toWorkspaceRel(path, workspacePath);
      if (rel && isHtmlFilePath(rel)) {
        openUrl(rel);
        return;
      }
      void api.fsOpen(path).catch((error: unknown) => {
        showToast(error instanceof Error ? error.message : String(error), {
          variant: "error",
        });
      });
    },
    [openUrl, showToast, workspacePath],
  );
}
