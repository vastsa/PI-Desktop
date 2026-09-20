import { api } from "./api";
import { useAppStore } from "../stores/app-store";

export type ResolvedLinkOpenTarget = "workpanel" | "external";

/** Persistable setting → destination. Absent or unknown values keep the work panel. */
export function resolveLinkOpenTarget(
  linkOpenTarget: string | null | undefined,
): ResolvedLinkOpenTarget {
  return linkOpenTarget === "external" ? "external" : "workpanel";
}

/** Work-panel tabs are per-session; without one the dock cannot open. */
export function canPresentWorkPanelBrowser(state: {
  activeSessionId?: string | null;
}): boolean {
  return Boolean(state.activeSessionId);
}

export type HttpUrlOpenPlan =
  | { action: "ignore" }
  | { action: "external"; url: string }
  | { action: "workpanel"; url: string; returnToChat: boolean };

/** Decide where an HTTP(S) click goes. Non-HTTP strings are ignored. */
export function planHttpUrlOpen(
  url: string,
  state: {
    settings?: { linkOpenTarget?: string | null } | null;
    activeSessionId?: string | null;
    page?: string | null;
  },
): HttpUrlOpenPlan {
  const trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed)) return { action: "ignore" };
  const wantsWorkPanel =
    resolveLinkOpenTarget(state.settings?.linkOpenTarget) === "workpanel";
  if (wantsWorkPanel && canPresentWorkPanelBrowser(state)) {
    return {
      action: "workpanel",
      url: trimmed,
      returnToChat: state.page !== "chat",
    };
  }
  return { action: "external", url: trimmed };
}

/**
 * Open an HTTP(S) URL using Settings → AI → Link open destination.
 *
 * Explicit preview (workspace HTML, BrowserPreview, the link context-menu
 * "Open in work panel" item) keeps calling `openUrlInWorkPanel` directly.
 *
 * Plugin/settings pages cover or unmount the dock, so a work-panel destination
 * returns to chat first without recording a navigation hop. A missing session
 * falls back to the OS browser.
 */
export function openHttpUrl(url: string): void {
  const state = useAppStore.getState();
  const plan = planHttpUrlOpen(url, state);
  if (plan.action === "ignore") return;
  if (plan.action === "workpanel") {
    if (plan.returnToChat) {
      state.setPage("chat", { record: false });
    }
    state.openUrlInWorkPanel(plan.url);
    return;
  }
  void api.browserOpenExternal(plan.url);
}
