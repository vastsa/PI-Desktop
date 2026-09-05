import { useCallback } from "react";
import { useAppStore } from "../stores/app-store";
import type { ChatPreviewTarget } from "./chat-links";

/**
 * Open a resolved chat reference in the work panel: files in the viewer, URLs
 * in the embedded browser. Shared by the transcript's linkified text, tool row
 * summaries and tool result file/match lists.
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
