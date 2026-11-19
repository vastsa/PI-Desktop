import type { WorkPanelTab } from "./work-panel-tabs";

/**
 * Host layout for a docked plugin view that opted into
 * `contributes.views[].presentation: "workbench"` (ADR 0348).
 *
 * The plugin asks for nothing but a presentation: while its view is the
 * foreground docked tab, the host borrows the existing maximize affordance and
 * its own temporary sidebar collapse, then gives both back when the user
 * leaves. Everything here is pure so the transitions can be tested without a
 * renderer: the caller owns the React state and the refs the transition reads.
 */

/** The only non-default presentation a view may declare. */
export const WORKBENCH_VIEW_PRESENTATION = "workbench" as const;

/** The minimal view metadata this policy reads. */
export type WorkbenchViewRef = {
  ref: string;
  presentation?: string;
};

/**
 * Identity of an active workbench presentation, or null when the current
 * layout is the ordinary one.
 *
 * The layout applies only to a foreground, presented work panel whose active
 * tab is one of the *current session's* docked plugin views and opted in. The
 * session id is part of the key so that switching sessions between two
 * workbench views is a transition between activations rather than a restore
 * followed by a re-apply, and so a stale tab from another session can never
 * hold the layout.
 */
export function workbenchViewActivationKey(input: {
  page: string;
  sessionId: string | null;
  workPanelOpen: boolean;
  presented: boolean;
  tabs: readonly WorkPanelTab[];
  activeTabId: string | null;
  views: readonly WorkbenchViewRef[];
}): string | null {
  if (input.page !== "chat") return null;
  if (!input.workPanelOpen || !input.presented) return null;
  if (!input.sessionId) return null;
  const tab = input.tabs.find((candidate) => candidate.id === input.activeTabId);
  if (!tab || tab.kind !== "plugin" || !tab.resource) return null;
  const view = input.views.find((candidate) => candidate.ref === tab.resource);
  if (!view || view.presentation !== WORKBENCH_VIEW_PRESENTATION) return null;
  return `${input.sessionId}\u0000${tab.id}`;
}

/**
 * What this policy changed for the activation it currently holds.
 *
 * The flags say "this policy owns the change", not "the host is in that
 * state": a view opened while the user had already maximized the panel, or
 * already collapsed the sidebar, must leave that state alone when the view is
 * left.
 */
export type WorkbenchLayoutState = {
  key: string | null;
  maximized: boolean;
  sidebarCollapsed: boolean;
};

export const EMPTY_WORKBENCH_LAYOUT: WorkbenchLayoutState = {
  key: null,
  maximized: false,
  sidebarCollapsed: false,
};

export type WorkbenchLayoutCommand = {
  state: WorkbenchLayoutState;
  /** Desired `workPanelMaximized`, or absent to leave it untouched. */
  setMaximized?: boolean;
  /** Desired sidebar-collapsed flag, or absent to leave it untouched. */
  setSidebarCollapsed?: boolean;
};

/**
 * The one transition this policy performs.
 *
 * - Entering an activation maximizes the panel and collapses the sidebar, but
 *   only on the axes the user had not already set that way, and records which
 *   axes it owns.
 * - Moving between two activations keeps the borrowed layout, so switching
 *   directly between workbench tabs never flickers the host layout.
 * - Leaving restores exactly the axes this policy owns. Widths are never
 *   touched, so nothing temporary is persisted: the panel and sidebar come
 *   back at the user's own preferred widths.
 */
export function workbenchLayoutTransition(
  state: WorkbenchLayoutState,
  input: {
    key: string | null;
    /** Current host layout at transition time. */
    maximized: boolean;
    sidebarCollapsed: boolean;
  },
): WorkbenchLayoutCommand {
  if (input.key === state.key) return { state };

  const command: WorkbenchLayoutCommand = {
    state: {
      key: input.key,
      maximized: input.key !== null && !input.maximized,
      sidebarCollapsed: input.key !== null && !input.sidebarCollapsed,
    },
  };

  if (state.key !== null && input.key !== null) {
    // Eligible view to eligible view: keep the same borrowed layout.
    command.state.maximized = state.maximized;
    command.state.sidebarCollapsed = state.sidebarCollapsed;
    return command;
  }

  if (state.key !== null) {
    if (state.maximized) command.setMaximized = false;
    if (state.sidebarCollapsed) command.setSidebarCollapsed = false;
    return command;
  }

  if (command.state.maximized) command.setMaximized = true;
  if (command.state.sidebarCollapsed) command.setSidebarCollapsed = true;
  return command;
}

/**
 * The user took back one axis while staying in a workbench view.
 *
 * Clearing ownership is what keeps a manual restore manual: the view keeps
 * rendering, but this policy no longer restores that axis when the view is
 * left, and it never re-applies it while the same view stays active.
 */
export function markWorkbenchLayoutUserChange(
  state: WorkbenchLayoutState,
  axis: "maximized" | "sidebarCollapsed",
): WorkbenchLayoutState {
  if (!state[axis]) return state;
  return { ...state, [axis]: false };
}
