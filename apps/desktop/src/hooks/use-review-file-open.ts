import { useTranslation } from "react-i18next";
import { api } from "../lib/api";
import type { ReviewFileGroup } from "../lib/review-history";
import { FILE_MANAGER_PLUGIN_TAB, fileManagerPluginTab, hasPluginView } from "../lib/work-panel-tabs";
import { useAppStore } from "../stores/app-store";

/** Review opens the current authorized file, never a historical snapshot export. */
export function useReviewFileOpen(file: ReviewFileGroup, sessionId: string) {
  const { t } = useTranslation();
  const views = useAppStore(state => state.pluginViews);
  const workspace = useAppStore(state => state.workspace);
  // Legacy delegates without execution-root provenance cannot name a safe target.
  const canOpenFile = !workspace?.remote && Boolean(file.root || !file.entries.some(entry => entry.message.parentToolCallId));
  const outside = /^(?:[a-z]:[\\/]|[\\/])/i.test(file.path) || file.path.split(/[\\/]/).includes("..");
  const canOpenInternal = !outside && canOpenFile && hasPluginView(views, FILE_MANAGER_PLUGIN_TAB);
  const openFile = async (destination: "internal" | "external" | "folder") => {
    const current = () => {
      const state = useAppStore.getState();
      return state.activeSessionId === sessionId && state.workspace === workspace;
    };
    if (!canOpenFile || !current()) return;
    try {
      if (destination === "internal" && (outside || !hasPluginView(useAppStore.getState().pluginViews, FILE_MANAGER_PLUGIN_TAB))) return;
      if (outside && destination !== "internal") {
        const snapshotId = file.entries.at(-1)?.change.snapshotId;
        if (!snapshotId) throw new Error("Native review snapshot unavailable");
        await api.workspaceReviewOpenFile({ sessionId, snapshotId, action: destination });
        return;
      }
      const absolute = /^(?:[a-z]:[\\/]|[\\/])/i.test(file.path);
      let ref = absolute || !file.root ? file.path : file.root.replace(/[\\/]+$/, "") + "/" + file.path;
      // Normalize Windows captured spellings, without changing host authorization.
      if (/^[a-z]:[\\/]/i.test(ref) || ref.startsWith("\\\\") || ref.startsWith("//?/")) {
        ref = ref.replaceAll("\\", "/").replace(/^\/\/\?\/UNC\//i, "//").replace(/^\/\/\?\/(?=[a-z]:\/)/i, "");
      }
      const { match } = await api.fsResolveRef(ref, sessionId);
      if (!current()) return;
      // Review paths are exact identities, not chat shorthands. Never fall back
      // to a same-named file when a historical file has been removed.
      if (!match || !["exact-absolute", "exact-relative"].includes(match.matchedBy)) throw new Error("Review file unavailable");
      if (destination === "external") {
        await api.fsOpen(match.absolutePath, undefined, sessionId);
      } else if (destination === "folder") {
        await api.fsReveal(match.absolutePath, sessionId);
      } else {
        const loaded = await api.listPluginViews();
        if (!current()) return;
        const state = useAppStore.getState();
        if (!hasPluginView(loaded, FILE_MANAGER_PLUGIN_TAB) || !hasPluginView(state.pluginViews, FILE_MANAGER_PLUGIN_TAB)) throw new Error("File manager unavailable");
        const session = state.sessions.find(item => item.id === sessionId);
        const location = match.root === "workspace" && match.projectRoot?.primary !== false && !session?.worktree ? match.relativePath : match.absolutePath;
        state.openWorkPanelTab(fileManagerPluginTab(location));
      }
    } catch {
      if (current()) useAppStore.getState().showToast(t("panel.review.openError"), { variant: "error" });
    }
  };
  return { canOpenFile, canOpenInternal, openFile, outside };
}
