export type WorkPanelTabKind =
  | "new"
  | "review"
  | "file"
  | "plugin"
  | "subagent";

export type WorkPanelTab = {
  id: string;
  /** Display name captured at open time, used by labels that have no resource. */
  label?: string;
  kind: WorkPanelTabKind;
  resource?: string;
  /** Guest URL or workspace path for the Browser plugin view (D333). */
  location?: string;
  /** Stored attachment mimeType for extension-less `attachments/<sha256>` images. */
  mimeType?: string;
};

export type WorkPanelTabsState = {
  tabs: WorkPanelTab[];
  activeTabId: string | null;
};

export type WorkPanelContext = WorkPanelTabsState & {
  open: boolean;
  fileRequest: { path: string; seq: number; mimeType?: string } | null;
};

let newWorkPanelTabSequence = 0;

export function emptyWorkPanelContext(): WorkPanelContext {
  return { open: false, tabs: [], activeTabId: null, fileRequest: null };
}

export function switchWorkPanelContextState(
  contexts: Record<string, WorkPanelContext>,
  currentSessionId: string | undefined,
  currentVisible: WorkPanelContext,
  nextSessionId: string | undefined,
): { contexts: Record<string, WorkPanelContext>; visible: WorkPanelContext } {
  const sanitizeContext = (context: WorkPanelContext): WorkPanelContext => {
    const sanitized = sanitizeWorkPanelTabsState(context);
    return {
      ...context,
      tabs: sanitized.tabs,
      activeTabId: sanitized.activeTabId,
    };
  };
  // A background artifact can update the retained context while an async
  // session selection still renders the older projection. Retained state wins.
  const retainedCurrent = currentSessionId
    ? sanitizeContext(contexts[currentSessionId] ?? currentVisible)
    : sanitizeContext(currentVisible);
  const nextContexts = currentSessionId
    ? { ...contexts, [currentSessionId]: retainedCurrent }
    : contexts;
  return {
    contexts: nextContexts,
    visible: nextSessionId
      ? sanitizeContext(nextContexts[nextSessionId] ?? emptyWorkPanelContext())
      : emptyWorkPanelContext(),
  };
}

export function toolWorkPanelTab(
  kind: Exclude<WorkPanelTabKind, "new" | "file" | "plugin" | "subagent">,
): WorkPanelTab {
  return { id: kind, kind };
}

/**
 * A temporary launcher page created by the panel's `+` action. Its id is
 * intentionally unique so each click creates a real, independently closable
 * tab instead of toggling a shared menu or reusing one blank state.
 */
export function newWorkPanelTab(): WorkPanelTab {
  newWorkPanelTabSequence += 1;
  return {
    id: `new:${Date.now().toString(36)}-${newWorkPanelTabSequence.toString(36)}`,
    kind: "new",
  };
}

/**
 * A plugin-contributed view (ADR 0104).
 *
 * Keyed by `<pluginId>/<viewId>` so two plugins may ship a view with the same
 * local id, and so re-opening the same view reuses its tab instead of stacking
 * duplicates. Like the tool singletons, a view is a *tool* rather than a
 * transcript resource — see `isToolWorkPanelTab`.
 */
export function pluginWorkPanelTab(pluginId: string, viewId: string): WorkPanelTab {
  const resource = `${pluginId}/${viewId}`;
  return { id: `plugin:${resource}`, kind: "plugin", resource };
}

/**
 * A subagent transcript tab (ADR 0062 delegations).
 *
 * Keyed by the delegation id, so re-opening the same delegate reuses its tab
 * and parallel delegates coexist as independent tabs. The agent name is
 * captured at open time so the strip can label the tab even before the
 * delegate produced any row.
 */
export function subagentWorkPanelTab(
  delegationId: string,
  agentName?: string,
): WorkPanelTab {
  return {
    id: `subagent:${delegationId}`,
    kind: "subagent",
    resource: delegationId,
    ...(agentName ? { label: agentName } : {}),
  };
}

export const BROWSER_PLUGIN_TAB = {
  pluginId: "pi.browser",
  viewId: "browser",
} as const;

export function browserPluginTab(location?: string): WorkPanelTab {
  const base = pluginWorkPanelTab(BROWSER_PLUGIN_TAB.pluginId, BROWSER_PLUGIN_TAB.viewId);
  if (!location) return base;
  const target = location.trim();
  return { ...base, id: `${base.id}:${Date.now().toString(36)}-${++newWorkPanelTabSequence}`, location: target, label: browserTabLabel(target) };
}

export function browserTabLabel(location: string): string {
  try { return new URL(location).host || location; } catch { return location.split(/[\\/]/).at(-1) || location; }
}

/**
 * The bundled file view (ADR 0241). A chat file reference prefers it, because
 * the file belongs beside the conversation that named it and the view can edit
 * as well as read.
 *
 * Named here exactly as `BROWSER_PLUGIN_TAB` names the side browser. The id is
 * not privileged: when the plugin is absent its view is simply missing from the
 * launcher list, and callers fall back to the host file tab.
 */
export const FILE_MANAGER_PLUGIN_TAB = {
  pluginId: "pi.file-manager",
  viewId: "manager",
} as const;

/** The file view, asked to show one file. */
export function fileManagerPluginTab(location: string): WorkPanelTab {
  return {
    ...pluginWorkPanelTab(
      FILE_MANAGER_PLUGIN_TAB.pluginId,
      FILE_MANAGER_PLUGIN_TAB.viewId,
    ),
    location,
  };
}

/** The identity of one plugin-contributed view, as tabs and manifests key it. */
export type PluginViewRef = { pluginId: string; viewId: string };

/** Whether that view is currently launchable in the work panel. */
export function hasPluginView(
  views: readonly PluginViewRef[],
  target: PluginViewRef,
): boolean {
  return views.some(
    (view) => view.pluginId === target.pluginId && view.viewId === target.viewId,
  );
}

/**
 * The tab the host opens a project file in when the host, not the user, chose
 * the file: the bundled file view whenever it is launchable, and the host file
 * tab otherwise — the same preference and fallback a chat file reference
 * already uses, so a plan or goal artifact lands where the user's other file
 * work lives. The bundle is never required: an absent view leaves the host tab.
 */
export function preferredFileWorkPanelTab(
  path: string,
  pluginViews: readonly PluginViewRef[],
): WorkPanelTab {
  return hasPluginView(pluginViews, FILE_MANAGER_PLUGIN_TAB)
    ? fileManagerPluginTab(path)
    : fileWorkPanelTab(path);
}

export function parsePluginViewRef(
  resource: string | undefined,
): { pluginId: string; viewId: string } | null {
  if (!resource) return null;
  // A plugin id may itself contain dots but never a slash, and a view id is
  // slash-free by manifest validation, so the first separator splits cleanly.
  const separator = resource.indexOf("/");
  if (separator <= 0 || separator === resource.length - 1) return null;
  return {
    pluginId: resource.slice(0, separator),
    viewId: resource.slice(separator + 1),
  };
}

/**
 * Runtime state can briefly outlive a renderer update. Unknown tab kinds must
 * be ignored rather than handed to a component lookup that expects a known
 * icon and renderer.
 */
export function isKnownWorkPanelTab(tab: WorkPanelTab): boolean {
  return (
    Boolean(tab) &&
    (tab.kind === "new" || tab.kind === "review" ||
      tab.kind === "file" || tab.kind === "plugin" ||
      tab.kind === "subagent")
  );
}

export function sanitizeWorkPanelTabsState(
  state: WorkPanelTabsState,
): WorkPanelTabsState {
  const tabs = state.tabs.filter(isKnownWorkPanelTab);
  if (tabs.length === state.tabs.length) return state;
  if (
    state.activeTabId === null ||
    tabs.some((tab) => tab.id === state.activeTabId)
  ) {
    return { tabs, activeTabId: state.activeTabId };
  }

  const activeIndex = state.tabs.findIndex(
    (tab) => tab.id === state.activeTabId,
  );
  return {
    tabs,
    activeTabId:
      tabs[Math.min(Math.max(activeIndex, 0), tabs.length - 1)]?.id ?? null,
  };
}

/**
 * Only plugin-contributed views are launchable tools. Review and file tabs
 * are transcript resources even though their tab ids are singleton-shaped, so
 * they remain visible in the opened-resource section.
 */
export function isToolWorkPanelTab(tab: WorkPanelTab): boolean {
  return tab.kind === "plugin";
}

export function normalizeWorkPanelFilePath(path: string): string {
  const normalizedSeparators = path.replace(/\\/g, "/");
  const absolute = normalizedSeparators.startsWith("/");
  const segments: string[] = [];

  for (const segment of normalizedSeparators.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      const previous = segments.at(-1);
      if (previous && previous !== "..") {
        segments.pop();
      } else if (!absolute) {
        segments.push(segment);
      }
      continue;
    }
    segments.push(segment);
  }

  const normalized = segments.join("/");
  return absolute ? `/${normalized}` : normalized;
}

export function fileWorkPanelTab(path: string, mimeType?: string): WorkPanelTab {
  const resource = normalizeWorkPanelFilePath(path);
  return {
    id: `file:${resource}`,
    kind: "file",
    resource,
    ...(mimeType ? { mimeType } : {}),
  };
}

export function openWorkPanelTabState(
  state: WorkPanelTabsState,
  tab: WorkPanelTab,
): WorkPanelTabsState {
  const index = state.tabs.findIndex((item) => item.id === tab.id);
  if (index === -1) {
    return { tabs: [...state.tabs, tab], activeTabId: tab.id };
  }
  const tabs = [...state.tabs];
  tabs[index] = tab;
  return { tabs, activeTabId: tab.id };
}

/** Replace a launcher tab with its selected destination, reusing an open tab. */
export function replaceWorkPanelTabState(
  state: WorkPanelTabsState,
  sourceTabId: string,
  tab: WorkPanelTab,
): WorkPanelTabsState {
  const sourceIndex = state.tabs.findIndex((item) => item.id === sourceTabId);
  if (sourceIndex < 0) return openWorkPanelTabState(state, tab);
  if (sourceTabId === tab.id) return { ...state, activeTabId: tab.id };

  const existingIndex = state.tabs.findIndex(
    (item) => item.id === tab.id && item.id !== sourceTabId,
  );
  if (existingIndex >= 0) {
    return {
      tabs: state.tabs.filter((_, index) => index !== sourceIndex),
      activeTabId: tab.id,
    };
  }

  const tabs = [...state.tabs];
  tabs[sourceIndex] = tab;
  return { tabs, activeTabId: tab.id };
}

export function activateWorkPanelTabState(
  state: WorkPanelTabsState,
  tabId: string,
): WorkPanelTabsState {
  return state.tabs.some((tab) => tab.id === tabId)
    ? { ...state, activeTabId: tabId }
    : state;
}

/** Move one tab before or after another without changing the active tab. */
export function reorderWorkPanelTabsState(
  state: WorkPanelTabsState,
  sourceTabId: string,
  targetTabId: string,
  insertAfter: boolean,
): WorkPanelTabsState {
  const sourceIndex = state.tabs.findIndex((tab) => tab.id === sourceTabId);
  const targetIndex = state.tabs.findIndex((tab) => tab.id === targetTabId);
  if (
    sourceIndex < 0 ||
    targetIndex < 0 ||
    sourceTabId === targetTabId
  ) {
    return state;
  }

  const tabs = [...state.tabs];
  const [source] = tabs.splice(sourceIndex, 1);
  const nextTargetIndex = tabs.findIndex((tab) => tab.id === targetTabId);
  if (!source || nextTargetIndex < 0) return state;
  tabs.splice(nextTargetIndex + (insertAfter ? 1 : 0), 0, source);
  return { tabs, activeTabId: state.activeTabId };
}

export function closeWorkPanelTabState(
  state: WorkPanelTabsState,
  tabId: string,
): WorkPanelTabsState {
  const index = state.tabs.findIndex((tab) => tab.id === tabId);
  if (index === -1) return state;

  const tabs = state.tabs.filter((tab) => tab.id !== tabId);
  if (state.activeTabId !== tabId) return { tabs, activeTabId: state.activeTabId };
  return {
    tabs,
    activeTabId: tabs[Math.min(index, tabs.length - 1)]?.id ?? null,
  };
}

/**
 * Display labels for the subagent tabs in strip order.
 *
 * Delegates with the same agent name would otherwise render identical tab
 * labels, so a repeated base label gains a 1-based `#n` suffix within its
 * label group; a label that occurs once stays unnumbered. Other tab kinds are
 * unique by construction and are not passed here.
 */
export function subagentTabDisplayLabels(
  baseLabels: readonly string[],
): string[] {
  const counts = new Map<string, number>();
  for (const label of baseLabels) {
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  return baseLabels.map((label) => {
    if ((counts.get(label) ?? 0) <= 1) return label;
    const index = (seen.get(label) ?? 0) + 1;
    seen.set(label, index);
    return `${label}#${index}`;
  });
}
