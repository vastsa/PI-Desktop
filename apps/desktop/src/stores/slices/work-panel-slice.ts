import { buildTranscriptEntries } from "../../lib/assistant-turns";
import { summarizeTurnFileChanges } from "../../lib/turn-file-summary";
import { transcriptViewMessages } from "../../lib/transcript-reading";
import { api } from "../../lib/api";
import {
  activateWorkPanelTabState,
  browserPluginTab,
  closeWorkPanelTabState,
  emptyWorkPanelContext,
  fileWorkPanelTab,
  newWorkPanelTab,
  openWorkPanelTabState,
  replaceWorkPanelTabState,
  sanitizeWorkPanelTabsState,
  switchWorkPanelContextState,
  toolWorkPanelTab,
  type WorkPanelContext,
  type WorkPanelReviewSelection,
  type WorkPanelTab,
} from "../../lib/work-panel-tabs";
import {
  WORK_PANEL_COMPACT_MIN_WIDTH,
  WORK_PANEL_DEFAULT_WIDTH,
} from "../../lib/work-panel-resize";
import type { AppState } from "../app-state";
import type { StoreAccess } from "./types";

const WORK_PANEL_STORAGE_KEY = "pi.desktop.workPanel";

export function loadWorkPanelWidth(): number {
  try {
    const raw = localStorage.getItem(WORK_PANEL_STORAGE_KEY);
    if (!raw) return WORK_PANEL_DEFAULT_WIDTH;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const width = Number(parsed.width);
    return Number.isFinite(width)
      ? Math.max(
          WORK_PANEL_COMPACT_MIN_WIDTH,
          Math.round(width),
        )
      : WORK_PANEL_DEFAULT_WIDTH;
  } catch {
    return WORK_PANEL_DEFAULT_WIDTH;
  }
}

function saveWorkPanelWidth(width: number): void {
  try {
    localStorage.setItem(WORK_PANEL_STORAGE_KEY, JSON.stringify({ width }));
  } catch {
    // best-effort persistence
  }
}

export function currentWorkPanelContext(state: AppState): WorkPanelContext {
  const tabs = sanitizeWorkPanelTabsState({
    tabs: state.workPanelTabs,
    activeTabId: state.activeWorkPanelTabId,
  });
  const reviewSelection = state.activeSessionId
    ? state.workPanelContexts[state.activeSessionId]?.reviewSelection
    : undefined;
  return {
    open: state.workPanelOpen,
    tabs: tabs.tabs,
    activeTabId: tabs.activeTabId,
    fileRequest: state.workPanelFileRequest,
    ...(reviewSelection ? { reviewSelection } : {}),
  };
}

export function switchWorkPanelSession(
  state: AppState,
  nextSessionId?: string,
): Pick<
  AppState,
  | "workPanelContexts"
  | "workPanelOpen"
  | "workPanelTabs"
  | "activeWorkPanelTabId"
  | "workPanelFileRequest"
> {
  const switched = switchWorkPanelContextState(
    state.workPanelContexts,
    state.activeSessionId,
    currentWorkPanelContext(state),
    nextSessionId,
  );
  return {
    workPanelContexts: switched.contexts,
    workPanelOpen: switched.visible.open,
    workPanelTabs: switched.visible.tabs,
    activeWorkPanelTabId: switched.visible.activeTabId,
    workPanelFileRequest: switched.visible.fileRequest,
  };
}

export type WorkPanelSliceDependencies = StoreAccess & {
  isSessionSelectionPending: (sessionId: string) => boolean;
};

export function createWorkPanelSlice({
  get,
  set,
  isSessionSelectionPending,
}: WorkPanelSliceDependencies): Pick<
  AppState,
  "toggleSubagentPanel"
  | "closeSubagentPanel"
  | "openWorkPanel"
  | "toggleWorkPanel"
  | "openWorkPanelTab"
  | "openNewWorkPanelTab"
  | "replaceWorkPanelTab"
  | "openWorkPanelTabForSession"
  | "resetWorkPanelContext"
  | "activateWorkPanelTab"
  | "closeWorkPanelTab"
  | "collapseWorkPanel"
  | "setWorkPanelWidth"
  | "openFileInWorkPanel"
  | "openUrlInWorkPanel"
  | "openTurnFileReview"
> {
  let workPanelFileRequestSeq = 0;

  return {
  toggleSubagentPanel: (delegationId) => {
    const state = get();
    const sessionId = state.activeSessionId;
    const id = delegationId.trim();
    if (!sessionId || !id) return;
    if (
      state.subagentPanel?.sessionId === sessionId &&
      state.subagentPanel.delegationId === id
    ) {
      set({ subagentPanel: null });
      return;
    }
    set({ subagentPanel: { sessionId, delegationId: id } });
  },
  closeSubagentPanel: () => set({ subagentPanel: null }),

  openWorkPanel: () => {
    const state = get();
    const sessionId = state.activeSessionId;
    if (!sessionId) return;
    const context = currentWorkPanelContext(state);
    set({
      workPanelOpen: true,
      workPanelContexts: {
        ...state.workPanelContexts,
        [sessionId]: { ...context, open: true },
      },
    });
  },

  toggleWorkPanel: () => {
    const state = get();
    if (state.subagentPanel) {
      state.closeSubagentPanel();
      if (get().workPanelOpen) get().collapseWorkPanel();
      return;
    }
    if (state.workPanelOpen) {
      state.collapseWorkPanel();
      return;
    }
    state.openWorkPanel();
  },

  openWorkPanelTabForSession: (sessionId, tab) => {
    if (!sessionId) return;
    set((state) => {
      const affectsVisibleSession =
        state.activeSessionId === sessionId &&
        (!isSessionSelectionPending(sessionId));
      const context = affectsVisibleSession
        ? currentWorkPanelContext(state)
        : state.workPanelContexts[sessionId] ?? emptyWorkPanelContext();
      const next = openWorkPanelTabState(
        {
          tabs: context.tabs,
          activeTabId: context.activeTabId,
        },
        tab,
      );
      const fileRequest =
        tab.kind === "file" && tab.resource
          ? {
              path: tab.resource,
              seq: ++workPanelFileRequestSeq,
              ...(tab.mimeType ? { mimeType: tab.mimeType } : {}),
            }
          : context.fileRequest;
      const nextContext: WorkPanelContext = {
        ...context,
        open: true,
        tabs: next.tabs,
        activeTabId: next.activeTabId,
        fileRequest,
      };
      return {
        workPanelContexts: {
          ...state.workPanelContexts,
          [sessionId]: nextContext,
        },
        ...(affectsVisibleSession
          ? {
              workPanelOpen: true,
              workPanelTabs: next.tabs,
              activeWorkPanelTabId: next.activeTabId,
              workPanelFileRequest: fileRequest,
            }
          : {}),
      };
    });
  },
  openWorkPanelTab: (tab) => {
    const sessionId = get().activeSessionId;
    if (!sessionId) return;
    get().openWorkPanelTabForSession(sessionId, tab);
  },
  openNewWorkPanelTab: () => {
    const sessionId = get().activeSessionId;
    if (!sessionId) return;
    get().openWorkPanelTabForSession(sessionId, newWorkPanelTab());
  },
  replaceWorkPanelTab: (sourceTabId, tab) => {
    set((state) => {
      const sessionId = state.activeSessionId;
      if (!sessionId) return {};
      const next = replaceWorkPanelTabState(
        {
          tabs: state.workPanelTabs,
          activeTabId: state.activeWorkPanelTabId,
        },
        sourceTabId,
        tab,
      );
      const activeTab = next.tabs.find((item) => item.id === next.activeTabId);
      const fileRequest =
        activeTab?.kind === "file" && activeTab.resource
          ? {
              path: activeTab.resource,
              seq: ++workPanelFileRequestSeq,
              ...(activeTab.mimeType ? { mimeType: activeTab.mimeType } : {}),
            }
          : state.workPanelFileRequest;
      const nextContext: WorkPanelContext = {
        ...currentWorkPanelContext(state),
        reviewSelection: next.tabs.some((item) => item.kind === "review")
          ? state.workPanelContexts[sessionId]?.reviewSelection
          : undefined,
        open: true,
        tabs: next.tabs,
        activeTabId: next.activeTabId,
        fileRequest,
      };
      return {
        workPanelOpen: true,
        workPanelTabs: next.tabs,
        activeWorkPanelTabId: next.activeTabId,
        workPanelFileRequest: fileRequest,
        workPanelContexts: {
          ...state.workPanelContexts,
          [sessionId]: nextContext,
        },
      };
    });
  },
  activateWorkPanelTab: (tabId) => {
    set((state) => {
      const sessionId = state.activeSessionId;
      if (!sessionId) return {};
      const next = activateWorkPanelTabState(
        {
          tabs: state.workPanelTabs,
          activeTabId: state.activeWorkPanelTabId,
        },
        tabId,
      );
      const activeTab = next.tabs.find((tab) => tab.id === next.activeTabId);
      const fileRequest =
        activeTab?.kind === "file" && activeTab.resource
          ? {
              path: activeTab.resource,
              seq: ++workPanelFileRequestSeq,
              ...(activeTab.mimeType ? { mimeType: activeTab.mimeType } : {}),
            }
          : state.workPanelFileRequest;
      const nextContext: WorkPanelContext = {
        ...currentWorkPanelContext(state),
        open: state.workPanelOpen,
        tabs: next.tabs,
        activeTabId: next.activeTabId,
        fileRequest,
      };
      return {
        activeWorkPanelTabId: next.activeTabId,
        workPanelFileRequest: fileRequest,
        workPanelContexts: {
          ...state.workPanelContexts,
          [sessionId]: nextContext,
        },
      };
    });
  },
  closeWorkPanelTab: (tabId) => {
    set((state) => {
      const sessionId = state.activeSessionId;
      if (!sessionId) return {};
      const next = closeWorkPanelTabState(
        {
          tabs: state.workPanelTabs,
          activeTabId: state.activeWorkPanelTabId,
        },
        tabId,
      );
      const activeTab = next.tabs.find((tab) => tab.id === next.activeTabId);
      const fileRequest =
        activeTab?.kind === "file" && activeTab.resource
          ? {
              path: activeTab.resource,
              seq: ++workPanelFileRequestSeq,
              ...(activeTab.mimeType ? { mimeType: activeTab.mimeType } : {}),
            }
          : state.workPanelFileRequest;
      const nextContext: WorkPanelContext = {
        ...currentWorkPanelContext(state),
        reviewSelection: next.tabs.some((item) => item.kind === "review")
          ? state.workPanelContexts[sessionId]?.reviewSelection
          : undefined,
        // Closing the final tab leaves the panel open so the user can choose
        // another tool from the new-tab launcher instead of losing the dock.
        open: state.workPanelOpen,
        tabs: next.tabs,
        activeTabId: next.activeTabId,
        fileRequest,
      };
      return {
        workPanelTabs: next.tabs,
        activeWorkPanelTabId: next.activeTabId,
        workPanelOpen: state.workPanelOpen,
        workPanelFileRequest: fileRequest,
        workPanelContexts: {
          ...state.workPanelContexts,
          [sessionId]: nextContext,
        },
      };
    });
  },
  collapseWorkPanel: () => {
    const state = get();
    const sessionId = state.activeSessionId;
    if (!sessionId || !state.workPanelOpen) return;
    set({
      workPanelOpen: false,
      workPanelContexts: {
        ...state.workPanelContexts,
        [sessionId]: { ...currentWorkPanelContext(state), open: false },
      },
    });
  },
  resetWorkPanelContext: () => {
    set((state) => switchWorkPanelSession(state));
  },
  setWorkPanelWidth: (width) => {
    const committedWidth = Math.round(width);
    set({
      workPanelWidth: Math.max(
        WORK_PANEL_COMPACT_MIN_WIDTH,
        committedWidth,
      ),
    });
    saveWorkPanelWidth(get().workPanelWidth);
  },

  openTurnFileReview: (selection) => {
    const state = get();
    if (
      !selection.sessionId ||
      state.activeSessionId !== selection.sessionId ||
      isSessionSelectionPending(selection.sessionId) ||
      !selection.selectedPath ||
      selection.snapshotIds.length === 0
    ) {
      return;
    }
    // Validate against the same loaded reading range and visual boundaries as
    // ChatTranscript; the live tail alone can omit history or merge checkpoints.
    const messages = transcriptViewMessages(
      state.messages,
      state.transcriptViews[selection.sessionId],
    );
    const turn = buildTranscriptEntries(
      messages,
      state.sessionCompactions[selection.sessionId],
    ).entries.find(
      (entry) => entry.kind === "assistant-turn" && entry.id === selection.turnId,
    );
    if (turn?.kind !== "assistant-turn") return;
    const file = summarizeTurnFileChanges(turn).files.find(
      (candidate) => candidate.path === selection.selectedPath,
    );
    if (!file) return;
    const requestedIds = new Set(selection.snapshotIds);
    const availableIds = new Set(
      file.entries
        .map(({ change }) => change.snapshotId)
        .filter((snapshotId) => requestedIds.has(snapshotId)),
    );
    if (availableIds.size !== requestedIds.size) return;
    const context = currentWorkPanelContext(state);
    const next = openWorkPanelTabState(
      { tabs: context.tabs, activeTabId: context.activeTabId },
      toolWorkPanelTab("review"),
    );
    const previousRevision = context.reviewSelection?.revision ?? 0;
    const reviewSelection: WorkPanelReviewSelection = {
      ...selection,
      snapshotIds: [...selection.snapshotIds],
      revision: previousRevision + 1,
    };
    const nextContext: WorkPanelContext = {
      ...context,
      open: true,
      tabs: next.tabs,
      activeTabId: next.activeTabId,
      reviewSelection,
    };
    set({
      subagentPanel: null,
      workPanelOpen: true,
      workPanelTabs: next.tabs,
      activeWorkPanelTabId: next.activeTabId,
      workPanelContexts: {
        ...state.workPanelContexts,
        [selection.sessionId]: nextContext,
      },
    });
  },

  openFileInWorkPanel: (path, mimeType) => {
    get().openWorkPanelTab(fileWorkPanelTab(path, mimeType));
  },
  openUrlInWorkPanel: (url) => {
    const hasBrowser = get().pluginViews.some(
      (view) => view.pluginId === "pi.browser" && view.viewId === "browser",
    );
    if (!hasBrowser) {
      if (/^https?:\/\//i.test(url.trim())) {
        void api.browserOpenExternal(url.trim());
      }
      return;
    }
    get().openWorkPanelTab(browserPluginTab(url));
  },
  };
}
