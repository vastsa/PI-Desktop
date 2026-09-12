import type {
  ContextCompactionRecord,
  SessionDetail,
  SessionSummary,
  UiMessage,
} from "@pi-desktop/shared";
import {
  contextCompactionMark,
  initialThinkingLevelForBinding,
  modelIdsMatch,
  normalizeMode,
} from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { scheduleHomeDraftAdopt } from "../../lib/composer-draft-cache";
import {
  commitForkedSessionState,
  forkedSessionMessages,
  FORKED_SESSION_WINDOW,
} from "../../lib/session-fork";
import { EMPTY_SESSION_WINDOW } from "../../lib/session-create";
import {
  clearSessionPanes,
  retainSessionPane,
} from "../../lib/session-panes";
import {
  sessionIsArchived,
  sessionIsPinned,
} from "../../lib/sidebar-preferences";
import type { AppState, DraftSessionConfiguration } from "../app-state";
import type { SessionRuntime } from "./session-runtime";
import type { StoreAccess } from "../slices/types";
import { switchWorkPanelSession } from "../slices/work-panel-slice";

export type PersistSessionOptions = {
  intent?: number;
  projectPath?: string | null;
  draftConfiguration?: DraftSessionConfiguration | null;
};

export type SessionCoordination = {
  flushPendingSessionConfiguration: (sessionId: string) => Promise<void>;
  rememberSessionCompactions: (
    sessionId: string,
    session:
      | {
          compaction?: ContextCompactionRecord;
          compactions?: ContextCompactionRecord[];
        }
      | null
      | undefined,
  ) => void;
  commitForkedSession: (
    session: SessionDetail,
    options: { activate: boolean; clearError?: boolean },
  ) => void;
  persistSessionAndSelect: (
    options?: PersistSessionOptions,
  ) => Promise<string | null>;
  materializeDraftSession: (intent?: number) => Promise<string | null>;
};

export type SessionCoordinationDependencies = StoreAccess & {
  runtime: SessionRuntime;
  decorateSessions: (
    sessions: SessionSummary[],
    meta: AppState["sessionMeta"],
  ) => SessionSummary[];
  withoutRecordKey: <T>(record: Record<string, T>, key: string) => Record<string, T>;
  untitledTaskTitle: () => string;
};

export function createSessionCoordination({
  get,
  set,
  runtime,
  decorateSessions,
  withoutRecordKey,
  untitledTaskTitle,
}: SessionCoordinationDependencies): SessionCoordination {
  function flushPendingSessionConfiguration(sessionId: string): Promise<void> {
    const active = runtime.sessionConfigurationFlushes.get(sessionId);
    if (active) return active;
    if (get().runningSessions[sessionId]) return Promise.resolve();

    const flush = (async () => {
      let failed = false;
      while (!get().runningSessions[sessionId]) {
        const config = runtime.pendingSessionConfigurations.get(sessionId);
        if (!config) break;
        try {
          const result = await api.configureSession(sessionId, config);
          if (runtime.pendingSessionConfigurations.get(sessionId) === config) {
            runtime.pendingSessionConfigurations.delete(sessionId);
          }
          set((state) => ({
            sessions: state.sessions.map((session) =>
              session.id === sessionId
                ? {
                    ...result.session,
                    pinned: sessionIsPinned(sessionId, state.sessionMeta),
                    archived: sessionIsArchived(sessionId, state.sessionMeta),
                  }
                : session,
            ),
            planningStates: {
              ...state.planningStates,
              [sessionId]:
                result.session.mode === "plan" ? "planning" : "inactive",
            },
          }));
        } catch (error) {
          get().showToast(
            error instanceof Error ? error.message : String(error),
            { variant: "error" },
          );
          void get().refreshSessions();
          if (runtime.pendingSessionConfigurations.get(sessionId) !== config) {
            continue;
          }
          failed = true;
          break;
        }
      }
      return failed;
    })();
    const settled = flush.then(() => undefined);
    runtime.sessionConfigurationFlushes.set(sessionId, settled);
    void flush.then((failed) => {
      if (runtime.sessionConfigurationFlushes.get(sessionId) === settled) {
        runtime.sessionConfigurationFlushes.delete(sessionId);
      }
      if (
        !failed &&
        runtime.pendingSessionConfigurations.has(sessionId) &&
        !get().runningSessions[sessionId]
      ) {
        void flushPendingSessionConfiguration(sessionId);
      }
    });
    return settled;
  }

  function rememberSessionCompactions(
    sessionId: string,
    session:
      | {
          compaction?: ContextCompactionRecord;
          compactions?: ContextCompactionRecord[];
        }
      | null
      | undefined,
  ): void {
    const records =
      session?.compactions ??
      (session?.compaction ? [session.compaction] : []);
    const marks = records.map(contextCompactionMark);
    set((state) => ({
      sessionCompactions:
        marks.length > 0
          ? { ...state.sessionCompactions, [sessionId]: marks }
          : withoutRecordKey(state.sessionCompactions, sessionId),
    }));
  }

  function commitForkedSession(
    session: SessionDetail,
    options: { activate: boolean; clearError?: boolean },
  ): void {
    const { messages: _forkedMessages, ...summary } = session;
    const messages = forkedSessionMessages(session);
    const historyWindow = { ...FORKED_SESSION_WINDOW };
    runtime.cacheSessionTranscript(summary.id, messages, historyWindow);
    set((current) => {
      const commit = commitForkedSessionState(current, summary, {
        activate: options.activate,
      });
      const shared: Partial<AppState> = {
        sessions: decorateSessions(commit.sessions, current.sessionMeta),
        sessionHistory: {
          ...current.sessionHistory,
          [summary.id]: historyWindow,
        },
        planningStates: {
          ...current.planningStates,
          [summary.id]: summary.mode === "plan" ? "planning" : "inactive",
        },
        ...(options.clearError ? { error: null, errorCode: null } : {}),
      };
      if (!commit.activated) return shared;
      return {
        ...switchWorkPanelSession(current, summary.id),
        ...shared,
        ...retainSessionPane(current, summary.id, messages),
        activeSessionId: summary.id,
        messages,
        page: "chat" as const,
        isRunning: false,
        navStack: commit.navStack as AppState["navStack"],
        navIndex: commit.navIndex,
      };
    });
    rememberSessionCompactions(summary.id, session);
    void get().restorePendingPlan(summary.id);
  }

  function revealEmptyCreatingSession(intent: number): void {
    if (!runtime.navigationIntentIsCurrent(intent)) return;
    set((state) => {
      if (
        !state.activeSessionId &&
        state.page === "chat" &&
        state.messages.length === 0 &&
        state.retainedSessionIds.length === 0
      ) {
        return {};
      }
      return {
        ...switchWorkPanelSession(state, undefined),
        ...clearSessionPanes(),
        activeSessionId: undefined,
        selectingSessionId: undefined,
        messages: [],
        page: "chat" as const,
        isRunning: false,
      };
    });
  }

  function commitCreatedEmptySession(
    summary: SessionSummary,
    options: { activate: boolean },
  ): void {
    const messages: UiMessage[] = [];
    runtime.cacheSessionTranscript(summary.id, messages, EMPTY_SESSION_WINDOW);
    if (options.activate) scheduleHomeDraftAdopt(summary.id);
    set((current) => {
      const commit = commitForkedSessionState(current, summary, {
        activate: options.activate,
      });
      const shared: Partial<AppState> = {
        sessions: decorateSessions(commit.sessions, current.sessionMeta),
        sessionHistory: {
          ...current.sessionHistory,
          [summary.id]: EMPTY_SESSION_WINDOW,
        },
        planningStates: {
          ...current.planningStates,
          [summary.id]: summary.mode === "plan" ? "planning" : "inactive",
        },
      };
      if (!commit.activated) return shared;
      return {
        ...switchWorkPanelSession(current, summary.id),
        ...shared,
        ...retainSessionPane(current, summary.id, messages),
        activeSessionId: summary.id,
        selectingSessionId: undefined,
        draftConfiguration: null,
        messages,
        page: "chat" as const,
        isRunning: current.runningSessions[summary.id] ?? false,
        navStack: commit.navStack as AppState["navStack"],
        navIndex: commit.navIndex,
      };
    });
  }

  async function persistSessionAndSelect(
    options: PersistSessionOptions = {},
  ): Promise<string | null> {
    const active = options.intent ?? runtime.beginNavigationIntent();
    const state = get();
    const settings = state.settings;
    const projectPath =
      options && "projectPath" in options
        ? options.projectPath
        : state.workspace?.path ?? null;
    const draftConfig =
      options && "draftConfiguration" in options
        ? options.draftConfiguration
        : state.draftConfiguration;
    const defaultProvider = state.providers.find(
      (provider) =>
        provider.id === (draftConfig?.providerId ?? settings?.defaultProviderId),
    );
    const inheritedModelId =
      draftConfig?.modelId ??
      settings?.defaultModelId ??
      defaultProvider?.defaultModelId;
    const inheritedBinding = defaultProvider?.models.find((candidate) =>
      modelIdsMatch(candidate.id, inheritedModelId ?? ""),
    );
    const defaultThinkingLevel = initialThinkingLevelForBinding(
      inheritedBinding,
      defaultProvider?.supportedThinkingLevels,
    );
    const previousSessionId = state.activeSessionId;
    revealEmptyCreatingSession(active);
    let created: Awaited<ReturnType<typeof api.createSession>>;
    try {
      created = await api.createSession({
        title: untitledTaskTitle(),
        mode: draftConfig?.mode ?? normalizeMode(settings?.defaultMode),
        thinkingLevel: draftConfig?.thinkingLevel ?? defaultThinkingLevel,
        permissionMode: draftConfig?.permissionMode,
        providerId: draftConfig?.providerId,
        modelId: draftConfig?.modelId,
        projectPath: projectPath ?? undefined,
      });
    } catch (error) {
      if (previousSessionId && runtime.navigationIntentIsCurrent(active)) {
        void get().selectSession(previousSessionId, {
          navigationIntent: active,
        });
      }
      throw error;
    }
    const sessionId = created.session.id;
    if (!runtime.navigationIntentIsCurrent(active)) {
      commitCreatedEmptySession(created.session, { activate: false });
      return null;
    }
    commitCreatedEmptySession(created.session, { activate: true });
    return sessionId;
  }

  async function materializeDraftSession(
    intent?: number,
  ): Promise<string | null> {
    const state = get();
    const scopeKey = runtime.newSessionScopeKey(state.workspace?.path ?? null);
    const pending = runtime.pendingNewSessionRequests.get(scopeKey);
    if (pending) {
      await pending;
      const activeId = get().activeSessionId;
      if (activeId) return activeId;
    }
    return persistSessionAndSelect({ intent });
  }

  return {
    flushPendingSessionConfiguration,
    rememberSessionCompactions,
    commitForkedSession,
    persistSessionAndSelect,
    materializeDraftSession,
  };
}
