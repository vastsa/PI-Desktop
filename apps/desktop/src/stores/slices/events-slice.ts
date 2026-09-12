import i18n from "i18next";
import type {
  AgentEventEnvelope,
  PlanningStateEvent,
  UiMessage,
} from "@pi-desktop/shared";
import { createFrameBatcher } from "../../lib/frame-batcher";
import {
  clearSessionAsks,
  enqueueAsk,
  removeAskForToolCall,
} from "../../lib/pending-asks";
import {
  clearSessionPermissions,
  enqueuePermission,
  removePermissionForToolCall,
} from "../../lib/pending-permissions";
import {
  isActivePlanExecution,
  isPendingPlan,
  mergePlanCheckpoint,
} from "../../lib/plan-mode-state";
import { formatToolValue } from "../../lib/tool-display";
import {
  shouldOpenReviewArtifact,
  toolWorkPanelTab,
} from "../../lib/work-panel-tabs";
import type { AppState } from "../app-state";
import type { SessionRuntime } from "../runtime/session-runtime";
import type { StoreAccess } from "./types";

export type EventsSliceDependencies = StoreAccess & {
  runtime: SessionRuntime;
  withoutRecordKey: <T>(record: Record<string, T>, key: string) => Record<string, T>;
  sessionModeForPlanningState: (
    state: AppState["planningStates"][string],
    kind: PlanningStateEvent["kind"],
  ) => AppState["sessions"][number]["mode"];
  openPlanArtifact: (
    proposal: NonNullable<AppState["pendingPlans"][string]>,
    openWorkPanelTabForSession: AppState["openWorkPanelTabForSession"],
  ) => void;
  notifyInteractivePrompt: (
    sessionId: string,
    kind: "ask" | "permission" | "plan",
    payload?: { question?: string; toolName?: string },
  ) => void;
  triggerAutoTitleSummarization: (sessionId: string) => Promise<void>;
  flushPendingSessionConfiguration: (sessionId: string) => Promise<void>;
  assistantErrorMessage: (error: {
    code: string;
    message: string;
    retriable?: boolean;
  }) => UiMessage;
  withCompactionMark: (
    marks: AppState["sessionCompactions"][string] | undefined,
    mark: NonNullable<AppState["sessionCompactions"][string]>[number],
  ) => NonNullable<AppState["sessionCompactions"][string]>;
};

export function createEventsSlice({
  get,
  set,
  runtime,
  withoutRecordKey,
  sessionModeForPlanningState,
  openPlanArtifact,
  notifyInteractivePrompt,
  triggerAutoTitleSummarization,
  flushPendingSessionConfiguration,
  assistantErrorMessage,
  withCompactionMark,
}: EventsSliceDependencies): Pick<
  AppState,
  "handlePlansChanged" | "handleAgentEvent"
> {
  let flushingStreamUpdates = false;
  const streamUpdates = createFrameBatcher<AgentEventEnvelope>((envelopes) => {
    flushingStreamUpdates = true;
    try {
      for (const envelope of envelopes) {
        get().handleAgentEvent(envelope);
      }
    } finally {
      flushingStreamUpdates = false;
    }
  });

  return {
    handlePlansChanged: (event) => {
      if (!event?.sessionId) return;
      runtime.nextPlanSyncGeneration(event.sessionId);
      set((state) => {
        const previousCheckpoint = state.planCheckpoints[event.sessionId];
        const checkpoint = mergePlanCheckpoint(previousCheckpoint, event);
        const activeProposal =
          event.state === "awaiting_approval" && isPendingPlan(checkpoint)
            ? checkpoint
            : undefined;
        const pendingPlans = activeProposal
          ? { ...state.pendingPlans, [event.sessionId]: activeProposal }
          : withoutRecordKey(state.pendingPlans, event.sessionId);
        const nextMode = sessionModeForPlanningState(
          event.state,
          event.kind ?? checkpoint?.kind,
        );
        const executionActive = isActivePlanExecution(checkpoint);
        const planExecutionWasActive = isActivePlanExecution(previousCheckpoint);
        const planExecutionRunChanged = executionActive || planExecutionWasActive;
        return {
          planningStates: {
            ...state.planningStates,
            [event.sessionId]: event.state,
          },
          planCheckpoints: checkpoint
            ? { ...state.planCheckpoints, [event.sessionId]: checkpoint }
            : state.planCheckpoints,
          pendingPlans,
          runningSessions: planExecutionRunChanged
            ? { ...state.runningSessions, [event.sessionId]: executionActive }
            : state.runningSessions,
          isRunning:
            state.activeSessionId === event.sessionId && planExecutionRunChanged
              ? executionActive
              : state.isRunning,
          sessions: state.sessions.map((session) =>
            session.id === event.sessionId
              ? { ...session, mode: nextMode }
              : session,
          ),
        };
      });
      const checkpoint = get().planCheckpoints[event.sessionId];
      if (event.state === "awaiting_approval" && isPendingPlan(checkpoint)) {
        openPlanArtifact(checkpoint, get().openWorkPanelTabForSession);
      }
      if (event.state === "awaiting_approval" && !event.proposal) {
        void get().restorePendingPlan(event.sessionId);
      }
      if (event.state === "inactive") {
        void get().refreshSessions();
      }
      if (event.state !== "awaiting_approval") {
        void get().refreshQueuedPrompts(event.sessionId);
      }
    },

    handleAgentEvent: (envelope) => {
      const event = envelope.event;
      if (event.type === "agent_end" || event.type === "error") {
        runtime.submittedComposerDrafts.delete(envelope.sessionId);
      }
      if (!flushingStreamUpdates) {
        if (event.type === "message_update") {
          streamUpdates.enqueue(
            `message:${envelope.sessionId}:${event.message.id}`,
            envelope,
          );
          return;
        }
        if (event.type === "tool_update") {
          streamUpdates.enqueue(
            `tool:${envelope.sessionId}:${event.toolCallId}`,
            envelope,
          );
          return;
        }
        streamUpdates.flushNow();
      }
      if (
        event.type === "message_start" ||
        event.type === "message_update" ||
        event.type === "message_end" ||
        event.type === "tool_start" ||
        event.type === "tool_update" ||
        event.type === "tool_end"
      ) {
        runtime.liveSessionTranscripts.add(envelope.sessionId);
      }
      if (event.type === "status") {
        set((state) => ({
          agentStatuses: {
            ...state.agentStatuses,
            [envelope.sessionId]: event.status,
          },
        }));
      }
      if (
        event.type === "agent_start" ||
        event.type === "turn_start" ||
        event.type === "compaction_start"
      ) {
        set((state) => ({
          runningSessions: {
            ...state.runningSessions,
            [envelope.sessionId]: true,
          },
          sessionOutcomes: withoutRecordKey(
            state.sessionOutcomes,
            envelope.sessionId,
          ),
          latestTurnResults: withoutRecordKey(
            state.latestTurnResults,
            envelope.sessionId,
          ),
        }));
      } else if (event.type === "compaction_end" && event.reason === "manual") {
        set((state) => ({
          runningSessions: {
            ...state.runningSessions,
            [envelope.sessionId]: false,
          },
        }));
        void flushPendingSessionConfiguration(envelope.sessionId);
        void get().refreshQueuedPrompts(envelope.sessionId);
      } else if (event.type === "agent_end" || event.type === "error") {
        set((state) => ({
          runningSessions: {
            ...state.runningSessions,
            [envelope.sessionId]: false,
          },
          agentStatuses: withoutRecordKey(
            state.agentStatuses,
            envelope.sessionId,
          ),
          pendingPermissions: clearSessionPermissions(
            state.pendingPermissions,
            envelope.sessionId,
          ),
          pendingAsks: clearSessionAsks(
            state.pendingAsks,
            envelope.sessionId,
          ),
          latestTurnResults:
            event.type === "error" && event.error.code === "TURN_ABORTED"
              ? withoutRecordKey(state.latestTurnResults, envelope.sessionId)
              : event.type === "agent_end" &&
                  state.latestTurnResults[envelope.sessionId]?.status === "failed"
                ? state.latestTurnResults
                : {
                    ...state.latestTurnResults,
                    [envelope.sessionId]: {
                      status: event.type === "error" ? "failed" : "completed",
                      turnId:
                        envelope.turnId ?? `${envelope.sessionId}:${envelope.ts}`,
                      finishedAt: envelope.ts,
                      ...(event.type === "error"
                        ? { errorCode: event.error.code }
                        : {}),
                    },
                  },
        }));
        void flushPendingSessionConfiguration(envelope.sessionId);
        if (event.type === "agent_end") {
          void get().refreshQueuedPrompts(envelope.sessionId);
        }
      }
      if (event.type === "planning_state") {
        runtime.nextPlanSyncGeneration(envelope.sessionId);
        set((state) => {
          const checkpoint = mergePlanCheckpoint(
            state.planCheckpoints[envelope.sessionId],
            { ...event, sessionId: envelope.sessionId },
          );
          const activeProposal =
            event.state === "awaiting_approval" && isPendingPlan(checkpoint)
              ? checkpoint
              : undefined;
          return {
            planningStates: {
              ...state.planningStates,
              [envelope.sessionId]: event.state,
            },
            planCheckpoints: checkpoint
              ? { ...state.planCheckpoints, [envelope.sessionId]: checkpoint }
              : state.planCheckpoints,
            pendingPlans: activeProposal
              ? { ...state.pendingPlans, [envelope.sessionId]: activeProposal }
              : withoutRecordKey(state.pendingPlans, envelope.sessionId),
          };
        });
        if (event.state === "awaiting_approval") {
          const checkpoint = get().planCheckpoints[envelope.sessionId];
          if (isPendingPlan(checkpoint)) {
            openPlanArtifact(checkpoint, get().openWorkPanelTabForSession);
          }
          void get().restorePendingPlan(envelope.sessionId);
          notifyInteractivePrompt(envelope.sessionId, "plan");
        }
        if (event.state !== "awaiting_approval") {
          void get().refreshQueuedPrompts(envelope.sessionId);
        }
      }

      if (event.type === "tool_start") {
        runtime.recordToolStart(event.toolCallId, {
          toolName: event.toolName,
          args: event.args,
          createdAt: new Date(envelope.ts).toISOString(),
          ...(envelope.parentToolCallId
            ? { parentToolCallId: envelope.parentToolCallId }
            : {}),
          ...(envelope.agentName ? { agentName: envelope.agentName } : {}),
        });
      } else if (event.type === "tool_end") {
        const toolName = runtime.getToolStart(event.toolCallId)?.toolName;
        set((state) => {
          const pendingPermissions = removePermissionForToolCall(
            state.pendingPermissions,
            envelope.sessionId,
            event.toolCallId,
          );
          const pendingAsks = removeAskForToolCall(
            state.pendingAsks,
            envelope.sessionId,
            event.toolCallId,
          );
          return pendingPermissions === state.pendingPermissions &&
            pendingAsks === state.pendingAsks
            ? {}
            : { pendingPermissions, pendingAsks };
        });
        if (
          shouldOpenReviewArtifact({
            toolName,
            isError: event.isError,
            result: event.result,
          })
        ) {
          get().openWorkPanelTabForSession(
            envelope.sessionId,
            toolWorkPanelTab("review"),
          );
        }
      }

      if (event.type === "compaction_end" && event.ok && event.mark) {
        const mark = event.mark;
        set((state) => ({
          sessionCompactions: {
            ...state.sessionCompactions,
            [envelope.sessionId]: withCompactionMark(
              state.sessionCompactions[envelope.sessionId],
              mark,
            ),
          },
        }));
        void flushPendingSessionConfiguration(envelope.sessionId);
      }

      if (envelope.sessionId !== get().activeSessionId) {
        runtime.cacheBackgroundTranscriptEvent(envelope);
        if (event.type === "tool_end") {
          runtime.removeToolStart(event.toolCallId);
        }
        if (event.type === "tool_permission_request") {
          set((state) => ({
            pendingPermissions: enqueuePermission(state.pendingPermissions, {
              ...event.request,
              receivedAt: envelope.ts,
            }),
          }));
          notifyInteractivePrompt(envelope.sessionId, "permission", {
            toolName: event.request.toolName,
          });
        } else if (event.type === "asktool_request") {
          set((state) => ({
            pendingAsks: enqueueAsk(state.pendingAsks, event.request),
          }));
          notifyInteractivePrompt(envelope.sessionId, "ask", {
            question: event.request.questions?.[0]?.question,
          });
        } else if (event.type === "agent_end") {
          void get().refreshSessions();
          void triggerAutoTitleSummarization(envelope.sessionId);
        } else if (event.type === "planning_state") {
          void get().refreshSessions();
        }
        return;
      }

      switch (event.type) {
        case "agent_start":
        case "turn_start":
        case "compaction_start":
          set({ isRunning: true });
          break;
        case "compaction_end":
          if (event.reason === "manual") set({ isRunning: false });
          if (event.ok) {
            get().showToast(i18n.t("contextCompaction.longThreadWarning"), {
              variant: "warning",
            });
            if (event.fallback) {
              get().showToast(i18n.t("contextCompaction.recovered"), {
                variant: "warning",
              });
            } else if (event.reason === "overflow") {
              get().showToast(i18n.t("contextCompaction.retrying"), {
                variant: "warning",
              });
            } else if (event.reason === "manual") {
              get().showToast(i18n.t("contextCompaction.completed"), {
                variant: "info",
              });
            }
          } else if (event.reason === "manual") {
            get().showToast(
              event.error?.message || i18n.t("contextCompaction.failed"),
              { variant: "error" },
            );
          }
          break;
        case "agent_end":
          set({ isRunning: false });
          void get().refreshSessions();
          void triggerAutoTitleSummarization(envelope.sessionId);
          break;
        case "turn_end":
          break;
        case "message_start":
          set((state) =>
            state.messages.some((message) => message.id === event.message.id)
              ? state
              : { messages: [...state.messages, event.message] },
          );
          break;
        case "message_update":
          set((state) => {
            const exists = state.messages.some(
              (message) => message.id === event.message.id,
            );
            return {
              messages: exists
                ? state.messages.map((message) =>
                    message.id === event.message.id ? event.message : message,
                  )
                : [...state.messages, event.message],
            };
          });
          break;
        case "message_end":
          set((state) => {
            if (
              event.message.role === "assistant" &&
              (event.message.status === "error" ||
                event.message.status === "aborted") &&
              !event.message.content.trim() &&
              !(event.message.thinking || "").trim() &&
              !event.message.error
            ) {
              return {
                messages: state.messages.filter(
                  (message) => message.id !== event.message.id,
                ),
              };
            }
            const exists = state.messages.some(
              (message) => message.id === event.message.id,
            );
            return {
              messages: exists
                ? state.messages.map((message) =>
                    message.id === event.message.id ? event.message : message,
                  )
                : [...state.messages, event.message],
            };
          });
          break;
        case "tool_start":
          set((state) => ({
            messages: [
              ...state.messages,
              {
                id: event.toolCallId,
                role: "tool",
                content: "",
                createdAt: new Date(envelope.ts).toISOString(),
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                toolArgs: event.args,
                toolStatus: "running",
                status: "streaming",
                ...(envelope.parentToolCallId
                  ? { parentToolCallId: envelope.parentToolCallId }
                  : {}),
                ...(envelope.agentName ? { agentName: envelope.agentName } : {}),
              },
            ],
          }));
          break;
        case "tool_update":
          if (event.partialResult === undefined) break;
          set((state) => ({
            messages: state.messages.map((message) =>
              message.toolCallId === event.toolCallId &&
              message.toolStatus === "running"
                ? {
                    ...message,
                    content:
                      typeof event.partialResult === "string"
                        ? event.partialResult
                        : formatToolValue(event.partialResult),
                    toolResult: event.partialResult,
                  }
                : message,
            ),
          }));
          break;
        case "tool_end":
          set((state) => {
            const toolStart = runtime.getToolStart(event.toolCallId);
            runtime.removeToolStart(event.toolCallId);
            const completedAt = new Date(envelope.ts).toISOString();
            const existing = state.messages.some(
              (message) => message.toolCallId === event.toolCallId,
            );
            const completed = {
              id: event.toolCallId,
              role: "tool" as const,
              content:
                typeof event.result === "string"
                  ? event.result
                  : JSON.stringify(event.result, null, 2),
              createdAt: toolStart?.createdAt ?? completedAt,
              toolCallId: event.toolCallId,
              ...(toolStart?.toolName ? { toolName: toolStart.toolName } : {}),
              ...(toolStart ? { toolArgs: toolStart.args } : {}),
              ...(toolStart?.parentToolCallId
                ? { parentToolCallId: toolStart.parentToolCallId }
                : {}),
              ...(toolStart?.agentName ? { agentName: toolStart.agentName } : {}),
              toolCompletedAt: completedAt,
              toolDurationMs: toolStart
                ? Math.max(0, envelope.ts - Date.parse(toolStart.createdAt))
                : 0,
              toolStatus: event.isError ? ("error" as const) : ("success" as const),
              toolResult: event.result,
              ...(event.toolUsage ? { toolUsage: event.toolUsage } : {}),
              status: "complete" as const,
              isError: event.isError,
            } satisfies UiMessage;
            return {
              messages: existing
                ? state.messages.map((message) =>
                    message.toolCallId === event.toolCallId
                      ? {
                          ...message,
                          ...completed,
                          toolName: message.toolName ?? completed.toolName,
                          toolArgs: message.toolArgs ?? completed.toolArgs,
                          createdAt: message.createdAt || completed.createdAt,
                        }
                      : message,
                  )
                : [...state.messages, completed],
            };
          });
          break;
        case "tool_permission_request":
          set((state) => ({
            pendingPermissions: enqueuePermission(state.pendingPermissions, {
              ...event.request,
              receivedAt: envelope.ts,
            }),
          }));
          notifyInteractivePrompt(envelope.sessionId, "permission", {
            toolName: event.request.toolName,
          });
          break;
        case "asktool_request":
          set((state) => ({
            pendingAsks: enqueueAsk(state.pendingAsks, event.request),
          }));
          notifyInteractivePrompt(envelope.sessionId, "ask", {
            question: event.request.questions?.[0]?.question,
          });
          break;
        case "error": {
          const aborted = event.error.code === "TURN_ABORTED";
          set((state) => {
            const last = state.messages[state.messages.length - 1];
            const hasErrorMessage =
              last?.role === "assistant" &&
              (last.status === "error" || last.isError === true);
            const messages: UiMessage[] = state.messages
              .filter(
                (message) =>
                  !(
                    message.role === "assistant" &&
                    message.status === "aborted" &&
                    !message.content.trim() &&
                    !(message.thinking || "").trim()
                  ),
              )
              .map((message) =>
                message.role === "tool" && message.toolStatus === "running"
                  ? {
                      ...message,
                      toolStatus: "error" as const,
                      status: "error" as const,
                      isError: true,
                    }
                  : message.role === "assistant" &&
                      message.status === "streaming"
                    ? {
                        ...message,
                        status: aborted
                          ? ("aborted" as const)
                          : ("error" as const),
                      }
                    : message,
              );
            return {
              isRunning: false,
              error: null,
              errorCode: null,
              errorRetriable: null,
              messages:
                aborted || hasErrorMessage
                  ? messages
                  : [...messages, assistantErrorMessage(event.error)],
            };
          });
          break;
        }
        default:
          break;
      }
    },
  };
}
