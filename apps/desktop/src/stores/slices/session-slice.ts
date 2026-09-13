import i18n from "i18next";
import type {
  Mode,
  PlanProposal,
  ProposalKind,
  SessionDetail,
  SessionSummary,
  UiMessage,
} from "@pi-desktop/shared";
import {
  isActivePlanExecution,
  isPendingPlan,
  latestPlanProposal,
  terminalizeMissingPlan,
} from "../../lib/plan-mode-state";
import {
  EMPTY_SESSION_WINDOW,
  sessionIsReusableEmpty,
} from "../../lib/session-create";
import {
  retainSessionPane,
} from "../../lib/session-panes";
import {
  normalizeProjectPath,
  projectPathsForNewSessions,
  sessionMatchesProject,
} from "../../lib/sidebar-session-groups";
import {
  sessionIsArchived,
  sessionIsPinned,
  type SessionMeta,
} from "../../lib/sidebar-preferences";
import { api } from "../../lib/api";
import {
  applyOptimisticSessionConfiguration,
} from "../../lib/session-thinking";
import {
  durableCoversLiveSessionMessages,
  mergeLiveSessionMessages,
} from "../../lib/session-transcript";
import type {
  AppState,
  DraftSessionConfiguration,
  NavigationOptions,
  PendingPlanRefreshResult,
  SessionHistoryWindow,
} from "../app-state";
import {
  type SessionConfiguration,
  type SessionRuntime,
} from "../runtime/session-runtime";
import type { StoreAccess } from "./types";
import { switchWorkPanelSession } from "./work-panel-slice";

export type SessionSliceDependencies = StoreAccess & {
  runtime: SessionRuntime;
  decorateSessions: (
    sessions: SessionSummary[],
    meta: Record<string, SessionMeta>,
  ) => SessionSummary[];
  withoutRecordKey: <T>(record: Record<string, T>, key: string) => Record<string, T>;
  sessionModeForPlanningState: (
    state: AppState["planningStates"][string],
    kind: ProposalKind | undefined,
  ) => Mode;
  openPlanArtifact: (
    proposal: PlanProposal,
    openWorkPanelTabForSession: AppState["openWorkPanelTabForSession"],
  ) => void;
  rememberSessionCompactions: (
    sessionId: string,
    session:
      | {
          compaction?: import("@pi-desktop/shared").ContextCompactionRecord;
          compactions?: import("@pi-desktop/shared").ContextCompactionRecord[];
        }
      | null
      | undefined,
  ) => void;
  commitForkedSession: (
    session: SessionDetail,
    options: { activate: boolean; clearError?: boolean },
  ) => void;
  persistSessionAndSelect: (options: {
    intent: number;
    projectPath?: string | null;
    draftConfiguration?: DraftSessionConfiguration | null;
  }) => Promise<string | null>;
};

export function createSessionSlice({
  get,
  set,
  runtime,
  decorateSessions,
  withoutRecordKey,
  sessionModeForPlanningState,
  openPlanArtifact,
  rememberSessionCompactions,
  commitForkedSession,
  persistSessionAndSelect,
}: SessionSliceDependencies): Pick<
  AppState,
  | "refreshSessions"
  | "restorePendingPlan"
  | "refreshPlanCheckpoints"
  | "prefetchSession"
  | "loadOlderMessages"
  | "selectSession"
  | "newSession"
  | "forkSession"
  | "forkAssistantMessage"
  | "configureActiveSession"
> {
  return {
    refreshSessions: async (options) => {
      const previousSessions = get().sessions;
      const sessions = await api.listSessions();
      set({ sessions: decorateSessions(sessions.sessions, get().sessionMeta) });
      if (options?.revealImportedProjects) {
        get().restoreProjects(
          projectPathsForNewSessions(previousSessions, sessions.sessions),
        );
      }
    },

    restorePendingPlan: async (sessionId) => {
      if (!sessionId) return "unavailable";
      const generation = runtime.nextPlanSyncGeneration(sessionId);
      try {
        const result = await api.pendingPlans(sessionId);
        if (generation !== runtime.planSyncGeneration(sessionId)) return "unavailable";
        const existingCheckpoint = get().planCheckpoints[sessionId];
        const wasPending = existingCheckpoint?.status === "pending";
        const proposal = latestPlanProposal(result.plans, sessionId);
        const durableMode = get().sessions.find(
          (session) => session.id === sessionId,
        )?.mode;
        const nextState =
          result.state ??
          (proposal?.status === "pending"
            ? "awaiting_approval"
            : durableMode === "plan" || durableMode === "goal"
              ? "planning"
              : "inactive");
        const nextKind: ProposalKind | undefined =
          result.kind ??
          proposal?.kind ??
          (durableMode === "plan" || durableMode === "goal"
            ? durableMode
            : undefined);
        const checkpoint =
          proposal ??
          (existingCheckpoint?.status === "pending" &&
          nextState === "awaiting_approval"
            ? existingCheckpoint
            : terminalizeMissingPlan(existingCheckpoint, nextState));
        const activeProposal =
          nextState === "awaiting_approval" && isPendingPlan(checkpoint)
            ? checkpoint
            : undefined;
        const executionActive = isActivePlanExecution(checkpoint);
        const planRunSettled = Boolean(activeProposal || executionActive || wasPending);
        set((state) => ({
          planningStates: {
            ...state.planningStates,
            [sessionId]: nextState,
          },
          planCheckpoints: checkpoint
            ? { ...state.planCheckpoints, [sessionId]: checkpoint }
            : state.planCheckpoints,
          pendingPlans: activeProposal
            ? { ...state.pendingPlans, [sessionId]: activeProposal }
            : withoutRecordKey(state.pendingPlans, sessionId),
          runningSessions: planRunSettled
            ? { ...state.runningSessions, [sessionId]: executionActive }
            : state.runningSessions,
          isRunning:
            state.activeSessionId === sessionId && planRunSettled
              ? executionActive
              : state.isRunning,
          sessions: state.sessions.map((session) =>
            session.id === sessionId
              ? {
                  ...session,
                  mode: sessionModeForPlanningState(nextState, nextKind),
                }
              : session,
          ),
        }));
        if (checkpoint && activeProposal) {
          openPlanArtifact(checkpoint, get().openWorkPanelTabForSession);
        }
        return activeProposal ? "pending" : "terminal";
      } catch {
        return "unavailable";
      }
    },

    refreshPlanCheckpoints: async () => {
      const sessionIds = get().sessions.map((session) => session.id);
      await Promise.allSettled(
        sessionIds.map((sessionId) => get().restorePendingPlan(sessionId)),
      );
    },

    prefetchSession: async (id) => {
      if (!id || runtime.sessionTranscriptCache.has(id)) return;
      await runtime.loadSessionDetail(id, {
        messageLimit: 100,
        contentLimit: 64 * 1024,
      });
    },

    loadOlderMessages: async (sessionId) => {
      const window = get().sessionHistory[sessionId];
      if (!window?.hasMoreBefore || runtime.sessionOlderLoads.has(sessionId)) return;
      const before = window.messageStart;
      const request = api
        .getSession(sessionId, {
          messageBefore: before,
          messageLimit: 100,
          contentLimit: 64 * 1024,
        })
        .then((detail) => {
          const page = detail.session;
          if (!page) return;
          const nextWindow = {
            messageStart: page.messageStart ?? Math.max(0, before - page.messages.length),
            hasMoreBefore: page.hasMoreBefore === true,
          };
          const cached = runtime.sessionTranscriptCache.get(sessionId) ?? [];
          const cachedStart =
            runtime.sessionHistoryCache.get(sessionId)?.messageStart ?? before;
          if (cachedStart !== before && cached.length > 0) return;
          const merged = mergeLiveSessionMessages(page.messages, cached);
          runtime.cacheSessionTranscript(sessionId, merged, nextWindow);
          set((state) =>
            state.activeSessionId === sessionId
              ? {
                  messages: mergeLiveSessionMessages(page.messages, state.messages),
                  sessionHistory: {
                    ...state.sessionHistory,
                    [sessionId]: nextWindow,
                  },
                }
              : {
                  sessionHistory: {
                    ...state.sessionHistory,
                    [sessionId]: nextWindow,
                  },
                },
          );
        })
        .finally(() => {
          if (runtime.sessionOlderLoads.get(sessionId) === request) {
            runtime.sessionOlderLoads.delete(sessionId);
          }
        });
      runtime.sessionOlderLoads.set(sessionId, request);
      await request;
    },

    selectSession: async (id, opts) => {
      const intent = opts?.navigationIntent ?? runtime.beginNavigationIntent();
      const selection = runtime.beginSessionSelection(id, intent);
      const stateAtStart = get();
      const runningAtSelection = stateAtStart.runningSessions[id] === true;
      if (runningAtSelection) runtime.liveSessionTranscripts.add(id);
      if (stateAtStart.activeSessionId) {
        runtime.cacheSessionTranscript(
          stateAtStart.activeSessionId,
          stateAtStart.messages,
          stateAtStart.sessionHistory[stateAtStart.activeSessionId],
        );
      }
      set({ selectingSessionId: id, page: "chat" });

      const commitSelection = (
        messages: UiMessage[],
        revalidating: boolean,
        historyWindow: SessionHistoryWindow =
          runtime.sessionHistoryCache.get(id) ?? {
            messageStart: 0,
            hasMoreBefore: false,
          },
      ) => {
        const record = opts?.record !== false;
        const commit = (state: AppState) => ({
          ...(state.activeSessionId === id ? {} : switchWorkPanelSession(state, id)),
          ...retainSessionPane(state, id, messages),
          activeSessionId: id,
          selectingSessionId: revalidating ? id : undefined,
          messages,
          sessionHistory: { ...state.sessionHistory, [id]: historyWindow },
          page: "chat" as const,
          isRunning: state.runningSessions[id] ?? false,
        });
        if (!record) {
          set(commit);
          return;
        }
        set((state) => {
          const stack = state.navStack.slice(0, state.navIndex + 1);
          const last = stack[stack.length - 1];
          const same = last?.page === "chat" && last?.sessionId === id;
          const nextStack = same ? stack : [...stack, { page: "chat" as const, sessionId: id }].slice(-50);
          return {
            ...commit(state),
            navStack: nextStack,
            navIndex: nextStack.length - 1,
          };
        });
      };

      const alignWorkspace = async (projectPath?: string | null) => {
        if (projectPath) {
          if (
            !sessionMatchesProject(
              { projectPath: get().activeProjectPath },
              projectPath,
            )
          ) {
            const workspace = await get().activateProject(projectPath, {
              navigationIntent: intent,
            });
            if (!runtime.navigationIntentIsCurrent(intent)) return false;
            if (!workspace) throw new Error(i18n.t("errors.workspaceActivationFailed"));
          }
        } else if (get().workspace) {
          await get().clearProject({ navigationIntent: intent });
          if (!runtime.navigationIntentIsCurrent(intent)) return false;
        }
        return runtime.navigationIntentIsCurrent(intent);
      };

      try {
        if (!runtime.navigationIntentIsCurrent(intent)) return;
        const summary = get().sessions.find((session) => session.id === id);
        const detailPromise = runtime.loadSessionDetail(id, {
          messageLimit: 100,
          contentLimit: 64 * 1024,
        });
        let detail: Awaited<typeof detailPromise> | undefined;
        const retainedMessages =
          runtime.sessionTranscriptCache.get(id) ?? get().retainedTranscripts[id];
        if (retainedMessages && get().activeSessionId !== id && summary) {
          commitSelection(retainedMessages, true);
        } else if (
          summary &&
          get().activeSessionId !== id &&
          sessionIsReusableEmpty(summary, {
            running: runningAtSelection,
            liveMessageCount: retainedMessages?.length ?? 0,
            submitted: runtime.submittedComposerDrafts.has(id),
          })
        ) {
          runtime.cacheSessionTranscript(id, [], EMPTY_SESSION_WINDOW);
          commitSelection([], true, EMPTY_SESSION_WINDOW);
        }
        if (summary) {
          if (
            !(await runtime.queueWorkspaceAlignment(() =>
              alignWorkspace(summary.projectPath),
            ))
          ) {
            return;
          }
        } else {
          detail = await detailPromise;
          if (!runtime.navigationIntentIsCurrent(intent)) return;
          if (
            !(await runtime.queueWorkspaceAlignment(() =>
              alignWorkspace(detail?.session?.projectPath),
            ))
          ) {
            return;
          }
        }

        const cachedMessages = runtime.sessionTranscriptCache.get(id);
        if (cachedMessages && runtime.navigationIntentIsCurrent(intent)) {
          runtime.cacheSessionTranscript(
            id,
            cachedMessages,
            runtime.sessionHistoryCache.get(id),
          );
          commitSelection(
            cachedMessages,
            true,
            runtime.sessionHistoryCache.get(id),
          );
        }

        detail ??= await detailPromise;
        if (!runtime.navigationIntentIsCurrent(intent)) return;
        const historyWindow = detail.session
          ? {
              messageStart: detail.session.messageStart ?? 0,
              hasMoreBefore: detail.session.hasMoreBefore === true,
            }
          : { messageStart: 0, hasMoreBefore: false };
        const currentState = get();
        const liveMessages =
          (runningAtSelection ||
            currentState.runningSessions[id] === true ||
            runtime.liveSessionTranscripts.has(id))
            ? currentState.activeSessionId === id
              ? currentState.messages
              : runtime.sessionTranscriptCache.get(id) ??
                currentState.retainedTranscripts[id]
            : undefined;
        const selectedMessages = detail.session
          ? liveMessages
            ? mergeLiveSessionMessages(detail.session.messages ?? [], liveMessages)
            : detail.session.messages ?? []
          : liveMessages ?? [];
        if (detail.session) {
          runtime.cacheSessionTranscript(id, selectedMessages, historyWindow);
        }
        commitSelection(selectedMessages, false, historyWindow);
        if (
          currentState.runningSessions[id] !== true &&
          durableCoversLiveSessionMessages(detail.session?.messages ?? [], liveMessages)
        ) {
          runtime.liveSessionTranscripts.delete(id);
        }
        rememberSessionCompactions(id, detail.session);
        void get().restorePendingPlan(id);
        void get().acknowledgeSessionOutcome(id);
      } finally {
        if (runtime.isCurrentSessionSelection(selection)) {
          runtime.clearSessionSelection(selection);
          set((state) =>
            state.selectingSessionId === id
              ? { selectingSessionId: undefined }
              : {},
          );
        }
      }
    },

    newSession: async (options) => {
      const requestedProjectPath =
        options && "projectPath" in options
          ? options.projectPath ?? null
          : get().workspace?.path ?? null;
      const scopeKey = runtime.newSessionScopeKey(requestedProjectPath);
      const pending = runtime.pendingNewSessionRequests.get(scopeKey);
      if (pending) {
        await pending;
        return;
      }

      const intent = runtime.beginNavigationIntent();
      const request = (async () => {
        if (
          requestedProjectPath &&
          !sessionMatchesProject(
            { projectPath: get().activeProjectPath },
            requestedProjectPath,
          )
        ) {
          const workspace = await get().activateProject(requestedProjectPath, {
            navigationIntent: intent,
          });
          if (!runtime.navigationIntentIsCurrent(intent)) return;
          if (!workspace) throw new Error(i18n.t("errors.workspaceActivationFailed"));
        }
        if (requestedProjectPath === null && get().workspace) {
          await get().clearProject({ navigationIntent: intent });
          if (!runtime.navigationIntentIsCurrent(intent)) return;
        }

        const latest = runtime.latestSessionInScope(
          get().sessions,
          requestedProjectPath,
          get().sessionMeta,
        );
        if (
          latest &&
          sessionIsReusableEmpty(latest, {
            running: get().runningSessions[latest.id] === true,
            liveMessageCount: runtime.liveMessageCountForSession(latest.id, get()),
            submitted: runtime.submittedComposerDrafts.has(latest.id),
          })
        ) {
          if (get().activeSessionId === latest.id && get().page === "chat") return;
          await get().selectSession(latest.id, { navigationIntent: intent });
          return;
        }

        await persistSessionAndSelect({
          intent,
          projectPath: requestedProjectPath,
          draftConfiguration: null,
        });
      })();
      runtime.pendingNewSessionRequests.set(scopeKey, request);
      try {
        await request;
      } finally {
        if (runtime.pendingNewSessionRequests.get(scopeKey) === request) {
          runtime.pendingNewSessionRequests.delete(scopeKey);
        }
      }
    },

    forkSession: async (id) => {
      const intent = runtime.beginNavigationIntent();
      const state = get();
      if (!id || state.runningSessions[id]) return;
      const source = state.sessions.find((session) => session.id === id);
      if (!source) throw new Error(i18n.t("errors.sessionNotFound"));

      if (source.projectPath) {
        if (
          !sessionMatchesProject(
            { projectPath: state.activeProjectPath },
            source.projectPath,
          )
        ) {
          const workspace = await get().activateProject(source.projectPath, {
            navigationIntent: intent,
          });
          if (!runtime.navigationIntentIsCurrent(intent)) return;
          if (!workspace) throw new Error(i18n.t("errors.workspaceActivationFailed"));
        }
      } else if (state.workspace) {
        await get().clearProject({ navigationIntent: intent });
        if (!runtime.navigationIntentIsCurrent(intent)) return;
      }

      const sourceTitle = source.title.trim() || i18n.t("chat.untitledTask");
      const result = await api.forkSession(
        id,
        i18n.t("nav.branchTitle", { title: sourceTitle }),
      );
      commitForkedSession(result.session, {
        activate: runtime.navigationIntentIsCurrent(intent),
      });
    },

    forkAssistantMessage: async (messageId) => {
      const intent = runtime.beginNavigationIntent();
      const state = get();
      const sessionId = state.activeSessionId;
      if (!sessionId || state.runningSessions[sessionId]) return;
      const message = state.messages.find((candidate) => candidate.id === messageId);
      const source = state.sessions.find((session) => session.id === sessionId);
      if (!message || message.role !== "assistant" || !source) return;

      try {
        const sourceTitle = source.title.trim() || i18n.t("chat.untitledTask");
        const result = await api.forkSession(
          sessionId,
          i18n.t("nav.branchTitle", { title: sourceTitle }),
          messageId,
        );
        commitForkedSession(result.session, {
          activate: runtime.navigationIntentIsCurrent(intent),
          clearError: true,
        });
      } catch (error) {
        set({
          error: error instanceof Error ? error.message : String(error),
          errorCode: (error as { code?: string })?.code ?? null,
        });
      }
    },

    configureActiveSession: async (config) => {
      const sessionId = get().activeSessionId;
      if (!sessionId) {
        set((state) => ({
          draftConfiguration: {
            mode: config.mode,
            thinkingLevel: config.thinkingLevel,
            providerId:
              config.providerId ?? state.draftConfiguration?.providerId,
            modelId: config.modelId ?? state.draftConfiguration?.modelId,
            permissionMode:
              config.permissionMode ?? state.draftConfiguration?.permissionMode,
          },
        }));
        return;
      }
      if (get().pendingPlans[sessionId]?.status === "pending") return;
      if (
        get().runningSessions[sessionId] ||
        runtime.sessionConfigurationFlushes.has(sessionId)
      ) {
        runtime.pendingSessionConfigurations.set(
          sessionId,
          runtime.mergeSessionConfiguration(
            runtime.pendingSessionConfigurations.get(sessionId),
            config,
          ),
        );
        set((state) => ({
          sessions: state.sessions.map((session) =>
            session.id === sessionId
              ? applyOptimisticSessionConfiguration(session, config)
              : session,
          ),
        }));
        return;
      }
      const payload = runtime.mergeSessionConfiguration(
        runtime.pendingSessionConfigurations.get(sessionId),
        config,
      );
      runtime.pendingSessionConfigurations.delete(sessionId);
      const result = await api.configureSession(sessionId, payload);
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
          [sessionId]: result.session.mode === "plan" ? "planning" : "inactive",
        },
      }));
    },
  };
}
