import type {
  PluginShellLayout,
  PluginShellLayoutCommand,
  PluginViewMeta,
  SessionSummary,
} from "@pi-desktop/shared";
import { isRemoteSession } from "../../lib/remote-session-safety";
import { clampSidebarWidth, SIDEBAR_WIDTH_MAX, SIDEBAR_WIDTH_MIN } from "../../lib/sidebar-preferences";
import { sidebarWidthBudget } from "../../lib/sidebar-resize";
import { workPanelSubagentLabels, workPanelTabLabel } from "../../lib/work-panel-tab-label";
import { isKnownWorkPanelTab, type WorkPanelTab } from "../../lib/work-panel-tabs";
import { clampWorkPanelWidth, WORK_PANEL_MIN_WIDTH, workPanelLayout, workPanelRequestedWidth } from "../../lib/work-panel-resize";

export type { PluginPanelGeometry } from "../../lib/work-panel-geometry";
import type { PluginPanelGeometry } from "../../lib/work-panel-geometry";
export type PluginShellRendererState = {
  ready: boolean;
  contextId: string;
  page: string;
  containerWidth: number;
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  sidebarPreferredWidth: number;
  sidebarEntering: boolean;
  sidebarExiting: boolean;
  sidebarResizing: boolean;
  presentedWorkPanelOpen: boolean;
  workPanelExiting: boolean;
  workPanelMaximized: boolean;
  panelGeometry: PluginPanelGeometry | null;
};

type WorkPanelStore = {
  activeSessionId?: string;
  selectingSessionId?: string;
  sessions: Pick<SessionSummary, "id" | "source" | "projectPath">[];
  workspace?: { path: string } | null;
  workPanelOpen: boolean;
  workPanelWidth: number;
  workPanelYieldedWidth: number | null;
  workPanelTabs: WorkPanelTab[];
  activeWorkPanelTabId: string | null;
  pluginViews: PluginViewMeta[];
  openWorkPanel: () => void;
  collapseWorkPanel: () => void;
  setWorkPanelWidth: (width: number) => void;
  activateWorkPanelTab: (id: string) => void;
};
export type PluginShellLayoutOwner = {
  getShell: () => PluginShellRendererState;
  getStore: () => WorkPanelStore;
  t: (key: string) => string;
  commitSidebarWidth: (width: number, maximum?: number) => void;
  toggleSidebar: () => void;
  autoCollapseSidebar: () => void;
};

function unavailable(message: string): Error {
  return Object.assign(new Error(message), { code: "UNAVAILABLE" });
}
function panelRequest(shell: PluginShellRendererState, store: WorkPanelStore): number {
  return workPanelRequestedWidth({
    containerWidth: shell.containerWidth,
    sidebarWidth: shell.sidebarWidth,
    sidebarCollapsed: shell.sidebarCollapsed && !shell.sidebarExiting,
    preferredWidth: store.workPanelWidth,
    yieldedWidth: store.workPanelYieldedWidth,
  });
}

/** A live read, including a drag preview, without changing any shell state. */
export function readPluginShellLayout(owner: PluginShellLayoutOwner): {
  contextId: string;
  sessionId: string | null;
  projectPath: string | null;
  layout: PluginShellLayout;
  settled: boolean;
} {
  const shell = owner.getShell();
  if (!shell.ready || shell.containerWidth <= 0) throw unavailable("Shell layout is not ready");
  const store = owner.getStore();
  if (store.selectingSessionId) throw unavailable("The selected session is changing");
  const sessionId = store.activeSessionId ?? null;
  const remote = isRemoteSession(store.sessions.find((session) => session.id === sessionId)) || sessionId?.startsWith("remote:");
  const tabs = sessionId && !remote ? store.workPanelTabs.filter(isKnownWorkPanelTab) : [];
  const subagentLabels = workPanelSubagentLabels(tabs, owner.t, store.pluginViews);
  const visible = shell.page === "chat" && (shell.presentedWorkPanelOpen || shell.workPanelExiting);
  const layout = workPanelLayout({
    containerWidth: shell.containerWidth,
    sidebarWidth: shell.sidebarWidth,
    sidebarCollapsed: shell.sidebarCollapsed && !shell.sidebarExiting,
    requestedPanelWidth: panelRequest(shell, store),
    maximized: shell.workPanelMaximized,
  });
  return {
    contextId: shell.contextId,
    sessionId,
    projectPath: sessionId ? store.sessions.find((session) => session.id === sessionId)?.projectPath ?? null : store.workspace?.path ?? null,
    settled: !shell.sidebarEntering && !shell.sidebarExiting && !shell.sidebarResizing &&
      !shell.workPanelExiting && !shell.panelGeometry?.resizing &&
      !shell.panelGeometry?.element?.getAnimations().some((animation) => animation.playState === "running" || animation.pending) &&
      !(visible && !remote && layout.shouldCollapseSidebar) &&
      (shell.page !== "chat" || (store.workPanelOpen === shell.presentedWorkPanelOpen && (!visible || shell.panelGeometry !== null))),
    layout: {
      sidebar: {
        collapsed: shell.sidebarCollapsed,
        width: shell.sidebarCollapsed ? shell.sidebarPreferredWidth : shell.sidebarWidth,
        minWidth: SIDEBAR_WIDTH_MIN,
        maxWidth: SIDEBAR_WIDTH_MAX,
      },
      workPanel: {
        visible,
        width: visible ? shell.panelGeometry?.element?.getBoundingClientRect().width ?? shell.panelGeometry?.width ?? layout.panelWidth : store.workPanelWidth,
        minWidth: WORK_PANEL_MIN_WIDTH,
        tabs: tabs.map((tab) => ({
          id: tab.id,
          kind: tab.kind,
          label: subagentLabels.get(tab.id) ?? workPanelTabLabel(tab, owner.t, store.pluginViews),
          ...(tab.resource === undefined ? {} : { resource: tab.resource }),
        })),
        activeTabId: tabs.some((tab) => tab.id === store.activeWorkPanelTabId) ? store.activeWorkPanelTabId : null,
      },
    },
  };
}

/** Called synchronously, immediately after the bridge checks context/deadline. */
export function applyPluginShellLayoutCommand(
  owner: PluginShellLayoutOwner,
  command: PluginShellLayoutCommand,
  expectedContextId: string,
): boolean {
  const current = readPluginShellLayout(owner);
  if (command.kind === "get") return false;
  if (current.contextId !== expectedContextId) throw unavailable("Shell context changed before applying the request");
  const store = owner.getStore();
  if (store.selectingSessionId) throw unavailable("The selected session is changing");
  const shell = owner.getShell();
  if (command.kind === "activateTab") {
    if (command.tabId === current.layout.workPanel.activeTabId || !current.layout.workPanel.tabs.some((tab) => tab.id === command.tabId)) return false;
    store.activateWorkPanelTab(command.tabId);
    return true;
  }
  if (command.kind === "setSidebar") {
    const collapsed = command.input.collapsed ?? shell.sidebarCollapsed;
    const maximum = collapsed || shell.sidebarCollapsed ? SIDEBAR_WIDTH_MAX : sidebarWidthBudget({
      containerWidth: shell.containerWidth,
      workPanelOpen: store.workPanelOpen,
      workPanelWidth: panelRequest(shell, store),
      workPanelMaximized: shell.workPanelMaximized,
    });
    const width = command.input.width === undefined ? undefined : clampSidebarWidth(command.input.width, maximum);
    const widthChanged = width !== undefined && width !== shell.sidebarPreferredWidth;
    if (widthChanged) owner.commitSidebarWidth(width, maximum);
    if (collapsed !== shell.sidebarCollapsed) owner.toggleSidebar();
    return widthChanged || collapsed !== shell.sidebarCollapsed;
  }
  let changed = false;
  const visible = command.input.visible ?? store.workPanelOpen;
  if (command.input.width !== undefined) {
    const requested = clampWorkPanelWidth(Math.round(command.input.width));
    const budget = workPanelLayout({
      containerWidth: shell.containerWidth,
      sidebarWidth: shell.sidebarWidth,
      sidebarCollapsed: shell.sidebarCollapsed,
      requestedPanelWidth: requested,
    });
    const yieldsSidebar = visible && shell.page === "chat" && !shell.sidebarCollapsed && !shell.workPanelMaximized && budget.shouldCollapseSidebar;
    const maximum = yieldsSidebar ? workPanelLayout({
      containerWidth: shell.containerWidth,
      sidebarWidth: shell.sidebarWidth,
      sidebarCollapsed: true,
      requestedPanelWidth: requested,
    }).maxPanelWidth : budget.maxPanelWidth;
    const width = Math.max(WORK_PANEL_MIN_WIDTH, Math.min(requested, maximum));
    if (yieldsSidebar) { owner.autoCollapseSidebar(); changed = true; }
    if (width !== store.workPanelWidth) { store.setWorkPanelWidth(width); changed = true; }
  }
  if (store.activeSessionId && visible !== store.workPanelOpen) {
    if (visible) store.openWorkPanel();
    else store.collapseWorkPanel();
    changed = true;
  }
  return changed;
}
