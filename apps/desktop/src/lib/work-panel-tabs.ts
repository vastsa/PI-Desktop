export type WorkPanelTabKind =
  | "review"
  | "file"
  | "plugin";

export type WorkPanelTab = {
  id: string;
  kind: WorkPanelTabKind;
  resource?: string;
  /** Guest URL or workspace path for the Browser plugin view (D333). */
  location?: string;
};

export type WorkPanelTabsState = {
  tabs: WorkPanelTab[];
  activeTabId: string | null;
};

export type WorkPanelContext = WorkPanelTabsState & {
  open: boolean;
  fileRequest: { path: string; seq: number } | null;
};

export type ReviewArtifactEvent = {
  toolName?: string;
  isError?: boolean;
  result: unknown;
};

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
  kind: Exclude<WorkPanelTabKind, "file" | "plugin">,
): WorkPanelTab {
  return { id: kind, kind };
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

export const BROWSER_PLUGIN_TAB = {
  pluginId: "pi.browser",
  viewId: "browser",
} as const;

export function browserPluginTab(location?: string): WorkPanelTab {
  return {
    ...pluginWorkPanelTab(BROWSER_PLUGIN_TAB.pluginId, BROWSER_PLUGIN_TAB.viewId),
    ...(location ? { location } : {}),
  };
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
    (tab.kind === "review" || tab.kind === "file" || tab.kind === "plugin")
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

export function fileWorkPanelTab(path: string): WorkPanelTab {
  const resource = normalizeWorkPanelFilePath(path);
  return { id: `file:${resource}`, kind: "file", resource };
}

export function toolResultRoot(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const details = (result as { details?: unknown }).details;
  if (!details || typeof details !== "object") return null;
  const root = (details as { root?: unknown }).root;
  return typeof root === "string" ? root : null;
}

export function shouldOpenReviewArtifact(event: ReviewArtifactEvent): boolean {
  return (
    (event.toolName === "Write" || event.toolName === "Edit") &&
    event.isError !== true &&
    toolResultRoot(event.result) === "workspace"
  );
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

export function activateWorkPanelTabState(
  state: WorkPanelTabsState,
  tabId: string,
): WorkPanelTabsState {
  return state.tabs.some((tab) => tab.id === tabId)
    ? { ...state, activeTabId: tabId }
    : state;
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
