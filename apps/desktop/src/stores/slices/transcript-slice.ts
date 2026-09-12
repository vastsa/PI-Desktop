import i18n from "i18next";
import type {
  ReviewRollbackResult,
  UiMessage,
} from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { resolveComposerSmartStop } from "../../lib/composer-smart-stop";
import {
  clearSessionPermissions,
  sessionPermissions,
} from "../../lib/pending-permissions";
import {
  mergeLiveSessionMessages,
} from "../../lib/session-transcript";
import { optimisticUserMessage } from "../../lib/session-transcript";
import { withReviewChangeState } from "../../lib/workspace-review";
import { settleStoppedAssistantMetrics } from "../../lib/context-usage";
import type { AppState } from "../app-state";
import type { SessionRuntime } from "../runtime/session-runtime";
import type { StoreAccess } from "./types";

export type TranscriptSliceDependencies = StoreAccess & {
  runtime: SessionRuntime;
  promptAttachmentsFromMessage: (
    attachments: UiMessage["attachments"],
  ) => NonNullable<Parameters<typeof api.prompt>[0]["attachments"]>;
  viewingSessionIdForPrompt: (
    state: Pick<AppState, "page" | "activeSessionId">,
    sessionId: string,
  ) => string | null;
  flushPendingSessionConfiguration: (sessionId: string) => Promise<void>;
};

export function createTranscriptSlice({
  get,
  set,
  runtime,
  promptAttachmentsFromMessage,
  viewingSessionIdForPrompt,
  flushPendingSessionConfiguration,
}: TranscriptSliceDependencies): Pick<
  AppState,
  | "compactContext"
  | "retryAssistantMessage"
  | "editUserMessage"
  | "retryLastPrompt"
  | "clearError"
  | "activateMessageRevision"
  | "deleteMessage"
  | "rollbackWorkspaceChange"
  | "abort"
> {
  return {
    compactContext: async () => {
      const state = get();
      const sessionId = state.activeSessionId;
      if (!sessionId || state.isRunning) return;
      set((current) => ({
        isRunning: true,
        runningSessions: {
          ...current.runningSessions,
          [sessionId]: true,
        },
      }));
      try {
        await api.compact({ sessionId });
      } catch (error) {
        set((current) => ({
          isRunning:
            current.activeSessionId === sessionId ? false : current.isRunning,
          runningSessions: {
            ...current.runningSessions,
            [sessionId]: false,
          },
        }));
        if ((error as { code?: string })?.code !== "CONTEXT_COMPACTION_FAILED") {
          get().showToast(
            error instanceof Error
              ? error.message
              : i18n.t("contextCompaction.failed"),
            { variant: "error" },
          );
        }
      }
    },

    retryAssistantMessage: async (messageId) => {
      const state = get();
      if (state.isRunning) return;
      const index = state.messages.findIndex((message) => message.id === messageId);
      if (index < 0) return;
      const target = state.messages[index];
      if (target.role !== "assistant") return;
      let userIndex = -1;
      for (let i = index - 1; i >= 0; i -= 1) {
        const candidate = state.messages[i];
        if (
          candidate.role === "user" &&
          (candidate.content.trim() || candidate.attachments?.length)
        ) {
          userIndex = i;
          break;
        }
      }
      if (userIndex < 0) return;
      const root = state.messages[userIndex];
      await get().editUserMessage(root.id, root.content, root.attachments);
    },

    editUserMessage: async (messageId, content, attachments) => {
      const state = get();
      if (state.isRunning) return false;
      const sessionId = state.activeSessionId;
      if (!sessionId) return false;
      if (state.pendingPlans[sessionId]?.status === "pending") return false;
      const prompt = content.trim();
      const userIndex = state.messages.findIndex(
        (message) => message.id === messageId,
      );
      if (userIndex < 0 || state.messages[userIndex].role !== "user") return false;
      if (
        !prompt &&
        !(attachments ?? state.messages[userIndex].attachments)?.length
      ) {
        return false;
      }
      const promptAttachments = promptAttachmentsFromMessage(
        attachments ?? state.messages[userIndex].attachments,
      );
      const kept = state.messages.slice(0, userIndex);
      const truncateFromMessageId = state.messages[userIndex].id;
      const optimisticMessage = optimisticUserMessage(
        crypto.randomUUID(),
        prompt,
        (attachments ?? state.messages[userIndex].attachments ?? []).map(
          (attachment) => ({
            path: attachment.ref,
            name: attachment.name,
            kind: attachment.kind,
            mimeType: attachment.mimeType,
          }),
        ),
      );

      set((current) => ({
        messages: [...kept, optimisticMessage],
        isRunning: true,
        error: null,
        errorCode: null,
        errorRetriable: null,
        runningSessions: { ...current.runningSessions, [sessionId]: true },
        latestTurnResults: withoutRecordKey(current.latestTurnResults, sessionId),
        sessionOutcomes: withoutRecordKey(current.sessionOutcomes, sessionId),
      }));

      try {
        await api.prompt({
          sessionId,
          content: prompt,
          messageId: optimisticMessage.id,
          viewingSessionId: viewingSessionIdForPrompt(get(), sessionId),
          attachments: promptAttachments,
          truncateFromMessageId,
        });
        return true;
      } catch (error) {
        try {
          const detail = await api.getSession(sessionId);
          set((current) => ({
            messages:
              current.activeSessionId === sessionId
                ? detail.session?.messages ?? kept
                : current.messages,
            isRunning:
              current.activeSessionId === sessionId ? false : current.isRunning,
            runningSessions: { ...current.runningSessions, [sessionId]: false },
            latestTurnResults: {
              ...current.latestTurnResults,
              [sessionId]: {
                status: "failed",
                turnId: `${sessionId}:${Date.now()}`,
                finishedAt: Date.now(),
                errorCode: (error as { code?: string })?.code,
              },
            },
            sessionOutcomes: { ...current.sessionOutcomes, [sessionId]: "failed" },
            error: error instanceof Error ? error.message : String(error),
            errorCode: (error as { code?: string })?.code ?? null,
          }));
        } catch {
          set((current) => ({
            isRunning:
              current.activeSessionId === sessionId ? false : current.isRunning,
            runningSessions: { ...current.runningSessions, [sessionId]: false },
            latestTurnResults: {
              ...current.latestTurnResults,
              [sessionId]: {
                status: "failed",
                turnId: `${sessionId}:${Date.now()}`,
                finishedAt: Date.now(),
                errorCode: (error as { code?: string })?.code,
              },
            },
            sessionOutcomes: { ...current.sessionOutcomes, [sessionId]: "failed" },
            error: error instanceof Error ? error.message : String(error),
            errorCode: (error as { code?: string })?.code ?? null,
          }));
        }
        return false;
      }
    },

    retryLastPrompt: async () => {
      const state = get();
      if (state.isRunning) return;
      const sessionId = state.activeSessionId;
      if (!sessionId) return;
      if (state.pendingPlans[sessionId]?.status === "pending") return;
      let userIndex = -1;
      for (let i = state.messages.length - 1; i >= 0; i -= 1) {
        const candidate = state.messages[i];
        if (
          candidate.role === "user" &&
          (candidate.content.trim() || candidate.attachments?.length)
        ) {
          userIndex = i;
          break;
        }
      }
      if (userIndex < 0) return;
      const prompt = state.messages[userIndex].content;
      const promptAttachments = promptAttachmentsFromMessage(
        state.messages[userIndex].attachments,
      );
      const kept = state.messages.slice(0, userIndex);
      const truncateFromMessageId = state.messages[userIndex].id;
      set((current) => ({
        messages: kept,
        isRunning: true,
        error: null,
        errorCode: null,
        errorRetriable: null,
        runningSessions: { ...current.runningSessions, [sessionId]: true },
        latestTurnResults: withoutRecordKey(current.latestTurnResults, sessionId),
        sessionOutcomes: withoutRecordKey(current.sessionOutcomes, sessionId),
      }));
      try {
        await api.prompt({
          sessionId,
          content: prompt,
          viewingSessionId: viewingSessionIdForPrompt(get(), sessionId),
          attachments: promptAttachments,
          truncateFromMessageId,
        });
      } catch (error) {
        set((current) => ({
          isRunning:
            current.activeSessionId === sessionId ? false : current.isRunning,
          runningSessions: { ...current.runningSessions, [sessionId]: false },
          latestTurnResults: {
            ...current.latestTurnResults,
            [sessionId]: {
              status: "failed",
              turnId: `${sessionId}:${Date.now()}`,
              finishedAt: Date.now(),
              errorCode: (error as { code?: string })?.code,
            },
          },
          sessionOutcomes: { ...current.sessionOutcomes, [sessionId]: "failed" },
          error: error instanceof Error ? error.message : String(error),
          errorCode: (error as { code?: string })?.code ?? null,
          errorRetriable: false,
        }));
      }
    },

    clearError: () => set({ error: null, errorCode: null, errorRetriable: null }),

    activateMessageRevision: async (rootUserId, revisionIndex) => {
      let state = get();
      if (state.isRunning) return;
      const sessionId = state.activeSessionId;
      if (!sessionId) return;
      if (state.sessionHistory[sessionId]?.hasMoreBefore) {
        const fullMessages = await runtime.loadFullSessionMessages(sessionId);
        if (!fullMessages || get().activeSessionId !== sessionId) return;
        set((current) =>
          current.activeSessionId === sessionId
            ? {
                messages: fullMessages,
                sessionHistory: {
                  ...current.sessionHistory,
                  [sessionId]: { messageStart: 0, hasMoreBefore: false },
                },
              }
            : {},
        );
        state = get();
      }
      const rootIndex = state.messages.findIndex((message) => message.id === rootUserId);
      if (rootIndex < 0) return;
      const root = state.messages[rootIndex];
      const revisionFamilyId = root.revisionRootId || root.id;
      const prefix = state.messages.slice(0, rootIndex);
      try {
        const result = await api.activateSessionRevision({
          sessionId,
          rootUserId: revisionFamilyId,
          revisionIndex,
          prefix,
        });
        set((current) => ({
          messages:
            current.activeSessionId === sessionId
              ? result.messages ?? prefix
              : current.messages,
          sessionHistory:
            current.activeSessionId === sessionId
              ? {
                  ...current.sessionHistory,
                  [sessionId]: { messageStart: 0, hasMoreBefore: false },
                }
              : current.sessionHistory,
          error: null,
          errorCode: null,
        }));
      } catch (error) {
        set({
          error: error instanceof Error ? error.message : String(error),
          errorCode: (error as { code?: string })?.code ?? null,
        });
      }
    },

    deleteMessage: async (messageId) => {
      const sessionId = get().activeSessionId;
      if (!sessionId || get().isRunning) return;
      const fullMessages = await runtime.loadFullSessionMessages(sessionId);
      if (!fullMessages || get().activeSessionId !== sessionId) return;
      set((current) =>
        current.activeSessionId === sessionId
          ? {
              messages: fullMessages,
              sessionHistory: {
                ...current.sessionHistory,
                [sessionId]: { messageStart: 0, hasMoreBefore: false },
              },
            }
          : {},
      );
      const state = get();
      const index = state.messages.findIndex((message) => message.id === messageId);
      if (index < 0) return;
      const target = state.messages[index];
      let end = index + 1;
      if (target.role === "user") {
        while (
          end < state.messages.length &&
          state.messages[end].role !== "user"
        ) {
          end += 1;
        }
      }
      const previous = state.messages;
      const next = [...previous.slice(0, index), ...previous.slice(end)];
      const fullWindow = { messageStart: 0, hasMoreBefore: false };
      runtime.cacheSessionTranscript(sessionId, next, fullWindow);
      set((current) => ({
        messages: next,
        sessionHistory: { ...current.sessionHistory, [sessionId]: fullWindow },
        error: null,
        errorCode: null,
      }));
      try {
        await api.replaceSessionMessages(sessionId, next);
      } catch (error) {
        runtime.cacheSessionTranscript(sessionId, previous, fullWindow);
        set((current) => ({
          messages:
            current.activeSessionId === sessionId ? previous : current.messages,
          error: error instanceof Error ? error.message : String(error),
          errorCode: (error as { code?: string })?.code ?? null,
        }));
      }
    },

    rollbackWorkspaceChange: async (messageId, snapshotId) => {
      const state = get();
      const sessionId = state.activeSessionId;
      if (!sessionId || state.isRunning) return null;
      try {
        const result = await api.workspaceReviewRollback({ sessionId, snapshotId });
        if (result.status === "rolledBack" || result.status === "alreadyRolledBack") {
          set((current) =>
            current.activeSessionId === sessionId
              ? {
                  messages: current.messages.map((message) =>
                    message.id === messageId
                      ? withReviewChangeState(message, "rolledBack")
                      : message,
                  ),
                }
              : {},
          );
        } else if (result.status === "conflict") {
          get().showToast(i18n.t("panel.review.rollbackConflict"), {
            variant: "warning",
          });
        } else if (result.status === "unavailable") {
          get().showToast(i18n.t("panel.review.rollbackUnavailable"), {
            variant: "warning",
          });
        }
        return result;
      } catch (error) {
        get().showToast(i18n.t("panel.review.rollbackError"), {
          variant: "error",
        });
        set({
          error: error instanceof Error ? error.message : String(error),
          errorCode: (error as { code?: string })?.code ?? null,
        });
        return null;
      }
    },

    abort: async () => {
      const stateBeforeAbort = get();
      const sessionId = stateBeforeAbort.activeSessionId;
      if (!sessionId) return;
      const submittedDraft = runtime.submittedComposerDrafts.get(sessionId);
      const preserveSteering = stateBeforeAbort.messages
        .slice(submittedDraft?.messageCountBeforeSend ?? 0)
        .findLast((message) => message.role === "user")?.steering;
      const stoppedAtMs = Date.now();
      if (submittedDraft && !submittedDraft.abortResolution) {
        submittedDraft.abortResolution = new Promise<boolean>((resolve) => {
          submittedDraft.resolveAbort = resolve;
        });
      }
      const pendingForSession = sessionPermissions(
        stateBeforeAbort.pendingPermissions,
        sessionId,
      );
      await Promise.allSettled([
        api.abort(sessionId),
        ...pendingForSession.map((permission) =>
          api.resolvePermission({
            requestId: permission.requestId,
            decision: "deny",
          }),
        ),
      ]);
      set((current) => ({
        pendingPermissions: clearSessionPermissions(
          current.pendingPermissions,
          sessionId,
        ),
      }));
      const state = get();
      if (state.activeSessionId !== sessionId) {
        submittedDraft?.resolveAbort?.(false);
        runtime.submittedComposerDrafts.delete(sessionId);
        set((current) => ({
          runningSessions: { ...current.runningSessions, [sessionId]: false },
        }));
        return;
      }
      const smartStop = preserveSteering
        ? { kind: "settle" as const }
        : resolveComposerSmartStop(state.messages, submittedDraft);
      if (smartStop.kind === "restore") {
        const fullMessages = await runtime.loadFullSessionMessages(sessionId);
        if (!fullMessages || get().activeSessionId !== sessionId) {
          submittedDraft?.resolveAbort?.(false);
          runtime.submittedComposerDrafts.delete(sessionId);
          return;
        }
        const merged = mergeLiveSessionMessages(fullMessages, get().messages);
        const fullStop = resolveComposerSmartStop(merged, submittedDraft);
        if (fullStop.kind === "restore") {
          runtime.submittedComposerDrafts.delete(sessionId);
          submittedDraft?.resolveAbort?.(true);
          const fullWindow = { messageStart: 0, hasMoreBefore: false };
          runtime.cacheSessionTranscript(sessionId, fullStop.kept, fullWindow);
          set((current) => ({
            messages: fullStop.kept,
            sessionHistory: { ...current.sessionHistory, [sessionId]: fullWindow },
            composerPrefill: { ...fullStop.draft, sessionId },
            isRunning: false,
            runningSessions: { ...current.runningSessions, [sessionId]: false },
          }));
          if (fullStop.kept.length < merged.length) {
            try {
              await api.replaceSessionMessages(sessionId, fullStop.kept);
            } catch {
              // Best effort — the local transcript already reflects the undo.
            }
          }
          void flushPendingSessionConfiguration(sessionId);
          return;
        }
        set((current) =>
          current.activeSessionId === sessionId
            ? {
                messages: merged,
                sessionHistory: {
                  ...current.sessionHistory,
                  [sessionId]: { messageStart: 0, hasMoreBefore: false },
                },
              }
            : {},
        );
      }
      submittedDraft?.resolveAbort?.(false);
      runtime.submittedComposerDrafts.delete(sessionId);
      const stoppedRows = (rows: UiMessage[]) =>
        rows.map((message) => {
          if (message.role === "assistant" && message.status === "streaming") {
            return {
              ...settleStoppedAssistantMetrics(message, stoppedAtMs),
              status: "aborted" as const,
            };
          }
          if (message.role === "tool" && message.toolStatus === "running") {
            return {
              ...message,
              toolStatus: "error" as const,
              status: "aborted" as const,
              toolCompletedAt:
                message.toolCompletedAt ?? new Date().toISOString(),
            };
          }
          return message;
        });
      set((current) => ({
        messages:
          current.activeSessionId === sessionId
            ? stoppedRows(current.messages)
            : current.messages,
        isRunning: false,
        runningSessions: { ...current.runningSessions, [sessionId]: false },
      }));
      void flushPendingSessionConfiguration(sessionId);
    },
  };
}

function withoutRecordKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const next = { ...record };
  delete next[key];
  return next;
}
