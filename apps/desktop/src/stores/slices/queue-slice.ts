import i18n from "i18next";
import type {
  AgentQueueChangedEvent,
  AgentPromptAttachment,
  AppError,
  SessionSummary,
  UiMessage,
  QueuedTurnSummary,
} from "@pi-desktop/shared";
import { collectSessionReferenceIds, stripSessionReferencePrompt } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { calculateSessionReferenceBudget } from "../../lib/session-reference-budget";
import { getSessionReferenceBudgetPercent } from "../../lib/session-reference-preferences";
import { expandComposerSessionReferences } from "../../lib/session-reference-prompt";
import {
  enqueueQueuedPrompt,
  isPendingQueuedPrompt,
  isPromotedQueuedPrompt,
  promoteQueuedPrompt,
  queuedPromptForSession,
  removeQueuedPrompt,
  reorderQueuedPrompt,
  type QueuedPrompt,
  type QueuedPromptDirection,
} from "../../lib/queued-prompts";
import type {
  ComposerDraftSnapshot,
  ComposerPrefill,
} from "../../lib/composer-smart-stop";
import { optimisticUserMessage } from "../../lib/session-transcript";
import type { AppState } from "../app-state";
import {
  type SessionRuntime,
  type SubmittedComposerDraft,
} from "../runtime/session-runtime";
import type { StoreAccess } from "./types";

type PromptAttachmentConverter = (
  references: ComposerDraftSnapshot["fileReferences"],
) => AgentPromptAttachment[];

export type QueueSliceDependencies = StoreAccess & {
  runtime: SessionRuntime;
  promptAttachmentsFromDraft: PromptAttachmentConverter;
  withoutRecordKey: <T>(record: Record<string, T>, key: string) => Record<string, T>;
  promptFallbackSessionTitle: (content: string, emptyTitle: string) => string;
  untitledTaskTitle: () => string;
  isDefaultSessionTitle: (title?: string | null) => boolean;
  viewingSessionIdForPrompt: (
    state: Pick<AppState, "page" | "activeSessionId">,
    sessionId: string,
  ) => string | null;
  messageErrorFromUnknown: (error: unknown) => AppError;
  assistantErrorMessage: (error: AppError) => UiMessage;
  materializeDraftSession: (intent?: number) => Promise<string | null>;
};

export function createQueueSlice({
  get,
  set,
  runtime,
  promptAttachmentsFromDraft,
  withoutRecordKey,
  promptFallbackSessionTitle,
  untitledTaskTitle,
  isDefaultSessionTitle,
  viewingSessionIdForPrompt,
  messageErrorFromUnknown,
  assistantErrorMessage,
  materializeDraftSession,
}: QueueSliceDependencies): Pick<
  AppState,
  | "enqueuePrompt"
  | "removeQueuedPrompt"
  | "moveQueuedPrompt"
  | "editQueuedPrompt"
  | "sendQueuedNow"
  | "refreshQueuedPrompts"
  | "applyQueueChanged"
  | "sendPrompt"
  | "steerPrompt"
> {
  const queuedDrafts = new Map<string, ComposerDraftSnapshot>();
  const pendingSubmissions = new Set<string>();

  function needsReferenceExpansion(
    content: string,
    draft: ComposerDraftSnapshot | undefined,
    sessionId: string,
  ): boolean {
    // Frozen/queued snapshots already carry the reference block and must not be re-read.
    return stripSessionReferencePrompt(content) === content &&
      collectSessionReferenceIds(content, draft?.fileReferences, sessionId).length > 0;
  }

  async function expandReferencedSessions(
    content: string,
    draft: ComposerDraftSnapshot | undefined,
    sessionId: string,
    currentInput: string,
    stillValid: () => boolean = () => true,
  ): Promise<string | null> {
    const state = get();
    const target = state.sessions.find((session) => session.id === sessionId);
    if (!target) {
      get().showToast(i18n.t("chat.sessionReferenceChanged"), { variant: "error" });
      return null;
    }
    const { providerId, modelId } = target;
    const isCurrent = () => {
      const current = get();
      const session = current.sessions.find((item) => item.id === sessionId);
      return Boolean(session && session.providerId === providerId && session.modelId === modelId &&
        current.pendingPlans[sessionId]?.status !== "pending" && stillValid());
    };
    try {
      const budget = calculateSessionReferenceBudget({
        session: { providerId, modelId },
        providers: state.providers,
        providerModels: state.providerModels,
        messages: state.activeSessionId === sessionId ? state.messages
          : runtime.sessionTranscriptCache.get(sessionId)
            ?? state.retainedTranscripts[sessionId]
            ?? [],
        compactions: state.sessionCompactions[sessionId],
        currentInput,
        percent: getSessionReferenceBudgetPercent(),
      });
      const expanded = await expandComposerSessionReferences(content, draft?.fileReferences, sessionId, {
        budgetTokens: budget.budgetTokens, isCurrent,
      });
      if (!isCurrent()) {
        get().showToast(i18n.t("chat.sessionReferenceChanged"), { variant: "error" });
        return null;
      }
      if (expanded.missingIds.length > 0) {
        get().showToast(i18n.t("chat.sessionReferenceMissing"), { variant: "error" });
        return null;
      }
      if (expanded.blockedReason) {
        get().showToast(i18n.t(expanded.blockedReason === "budget"
          ? "chat.sessionReferenceBudgetBlocked" : "chat.sessionReferenceIncomplete"), { variant: "error", duration: 10_000 });
        return null;
      }
      const included = expanded.notices.reduce((sum, notice) => sum + notice.includedTurns, 0);
      const omitted = expanded.notices.reduce((sum, notice) => sum + notice.omittedKnown, 0);
      const unread = expanded.notices.some((notice) => notice.olderUnread || notice.readLimitReached);
      const summary = [i18n.t("chat.sessionReferenceSummary", { turns: included, tokens: expanded.estimatedTokens })];
      if (omitted > 0) summary.push(i18n.t("chat.sessionReferenceOmitted", { turns: omitted }));
      if (unread) summary.push(i18n.t("chat.sessionReferenceUnread"));
      get().showToast(summary.join(" "), { variant: omitted > 0 || unread ? "warning" : "info", duration: 8_000 });
      return expanded.content;
    } catch {
      get().showToast(i18n.t(isCurrent() ? "chat.sessionReferenceFailed" : "chat.sessionReferenceChanged"), { variant: "error" });
      return null;
    }
  }

  function toQueuedPrompt(entry: QueuedTurnSummary): QueuedPrompt {
    return {
      id: entry.id,
      sessionId: entry.sessionId,
      content: entry.content,
      draft: queuedDrafts.get(entry.id) ?? {
        text: stripSessionReferencePrompt(entry.content),
        fileReferences: [],
      },
      createdAt: Date.parse(entry.createdAt) || Date.now(),
      ...(entry.priority === undefined ? {} : { priority: entry.priority }),
    };
  }

  function applyQueueEntries(
    sessionId: string,
    entries: QueuedTurnSummary[],
  ): void {
    set((state) => {
      const current = state.queuedPrompts[sessionId] ?? [];
      const pending = current.filter(isPendingQueuedPrompt);
      const mirrored = entries.map((entry) => toQueuedPrompt(entry));
      for (const item of current) {
        if (
          !isPendingQueuedPrompt(item) &&
          !entries.some((entry) => entry.id === item.id)
        ) {
          queuedDrafts.delete(item.id);
        }
      }
      const next = { ...state.queuedPrompts };
      const merged = [...mirrored, ...pending];
      if (merged.length === 0) delete next[sessionId];
      else next[sessionId] = merged;
      return { queuedPrompts: next };
    });
  }

  function detachQueuedPrompt(sessionId: string, promptId: string): void {
    set((state) => ({
      queuedPrompts: removeQueuedPrompt(state.queuedPrompts, sessionId, promptId),
    }));
    queuedDrafts.delete(promptId);
    if (promptId.startsWith("pending:")) return;
    void api.removeQueuedPrompt(promptId).catch((error) => {
      get().showToast(
        error instanceof Error ? error.message : String(error),
        { variant: "error" },
      );
      void get().refreshQueuedPrompts(sessionId);
    });
  }

  async function enqueueFrozenPrompt(
    content: string,
    draft: ComposerDraftSnapshot | undefined,
    sessionId: string,
  ): Promise<boolean> {
    const queuedDraft: ComposerDraftSnapshot = draft
      ? {
          text: draft.text,
          fileReferences: draft.fileReferences.map((reference) => ({
            ...reference,
          })),
        }
      : { text: stripSessionReferencePrompt(content), fileReferences: [] };
    const item: QueuedPrompt = {
      id: `pending:${crypto.randomUUID()}`,
      sessionId,
      content,
      draft: queuedDraft,
      createdAt: Date.now(),
    };
    set((state) => ({
      queuedPrompts: enqueueQueuedPrompt(state.queuedPrompts, item),
    }));
    const attachments = promptAttachmentsFromDraft(queuedDraft.fileReferences);
    return api
      .queuePrompt({
        sessionId,
        content,
        ...(attachments.length ? { attachments } : {}),
      })
      .then((entry) => {
        queuedDrafts.set(entry.id, queuedDraft);
        set((state) => ({
          queuedPrompts: removeQueuedPrompt(
            state.queuedPrompts,
            sessionId,
            item.id,
          ),
        }));
        void get().refreshQueuedPrompts(sessionId);
        return true;
      })
      .catch((error) => {
        set((state) => ({
          queuedPrompts: removeQueuedPrompt(
            state.queuedPrompts,
            sessionId,
            item.id,
          ),
        }));
        get().showToast(
          error instanceof Error ? error.message : String(error),
          { variant: "error" },
        );
        return false;
      });
  }

  return {
    enqueuePrompt: async (content, draft, requestedSessionId) => {
      const sessionId = requestedSessionId ?? get().activeSessionId;
      if (!sessionId || get().pendingPlans[sessionId]?.status === "pending") return false;
      const key = `session:${sessionId}`;
      if (pendingSubmissions.has(key)) return false;
      pendingSubmissions.add(key);
      try {
        const promptContent = needsReferenceExpansion(content, draft, sessionId)
          ? await expandReferencedSessions(content, draft, sessionId, content) : content;
        if (promptContent === null || get().pendingPlans[sessionId]?.status === "pending") return false;
        return enqueueFrozenPrompt(promptContent, draft, sessionId);
      } finally {
        pendingSubmissions.delete(key);
      }
    },

    removeQueuedPrompt: (promptId) => {
      const sessionId = get().activeSessionId;
      if (!sessionId) return;
      detachQueuedPrompt(sessionId, promptId);
    },

    editQueuedPrompt: (promptId) => {
      const sessionId = get().activeSessionId;
      if (!sessionId) return;
      const item = queuedPromptForSession(
        get().queuedPrompts,
        sessionId,
        promptId,
      );
      if (!item || isPromotedQueuedPrompt(item)) return;
      const restored: ComposerPrefill = {
        sessionId,
        text: item.draft.text,
        fileReferences: item.draft.fileReferences.map((reference) => ({
          ...reference,
        })),
      };
      detachQueuedPrompt(sessionId, promptId);
      set({ composerPrefill: restored });
    },

    moveQueuedPrompt: async (promptId, direction) => {
      const sessionId = get().activeSessionId;
      if (!sessionId) return;
      const item = queuedPromptForSession(
        get().queuedPrompts,
        sessionId,
        promptId,
      );
      if (!item || isPendingQueuedPrompt(item) || isPromotedQueuedPrompt(item)) {
        return;
      }
      const before = get().queuedPrompts;
      const moved = reorderQueuedPrompt(
        before,
        sessionId,
        promptId,
        direction,
      );
      if (moved === before) return;
      set({ queuedPrompts: moved });
      try {
        await api.reorderQueuedPrompt(promptId, direction);
      } catch (error) {
        void get().refreshQueuedPrompts(sessionId);
        get().showToast(
          error instanceof Error ? error.message : String(error),
          { variant: "error" },
        );
      }
    },

    sendQueuedNow: async (promptId) => {
      const sessionId = get().activeSessionId;
      if (!sessionId) return;
      const item = queuedPromptForSession(
        get().queuedPrompts,
        sessionId,
        promptId,
      );
      if (!item || isPendingQueuedPrompt(item) || isPromotedQueuedPrompt(item)) {
        return;
      }
      set((state) => ({
        queuedPrompts: promoteQueuedPrompt(
          state.queuedPrompts,
          sessionId,
          promptId,
        ),
      }));
      try {
        await api.prioritizeQueuedPrompt(promptId);
        if (get().runningSessions[sessionId]) await api.stop(sessionId);
      } catch (error) {
        void get().refreshQueuedPrompts(sessionId);
        get().showToast(
          error instanceof Error ? error.message : String(error),
          { variant: "error" },
        );
      }
    },

    refreshQueuedPrompts: async (sessionId) => {
      try {
        const { entries } = await api.listQueuedPrompts(sessionId);
        applyQueueEntries(sessionId, entries);
      } catch {
        // The next queue event resynchronizes the mirror.
      }
    },

    applyQueueChanged: (event: AgentQueueChangedEvent) => {
      applyQueueEntries(event.sessionId, event.entries);
    },

    steerPrompt: async (content, draft) => {
      const state = get();
      const sessionId = state.activeSessionId;
      const expectedTurnId = sessionId ? state.agentStatuses[sessionId]?.currentTurnId : undefined;
      if (
        !sessionId || !expectedTurnId || !state.runningSessions[sessionId] ||
        state.pendingPlans[sessionId]?.status === "pending"
      ) {
        get().showToast(i18n.t("chat.steeringUnavailable"), { variant: "info" });
        return false;
      }
      const key = `session:${sessionId}`;
      if (pendingSubmissions.has(key)) return false;
      pendingSubmissions.add(key);
      try {
        const stillValid = () => Boolean(get().runningSessions[sessionId] &&
          get().agentStatuses[sessionId]?.currentTurnId === expectedTurnId &&
          get().pendingPlans[sessionId]?.status !== "pending");
        const promptContent = needsReferenceExpansion(content, draft, sessionId)
          ? await expandReferencedSessions(content, draft, sessionId, content, stillValid) : content;
        if (promptContent === null || !stillValid()) return false;
        const message = optimisticUserMessage(
          crypto.randomUUID(), content, draft?.fileReferences ?? [],
        );
        message.steering = true;
        runtime.insertOptimisticUserMessage(sessionId, message);
        try {
          await api.steer({
            sessionId, expectedTurnId, content: promptContent, messageId: message.id,
            attachments: draft ? promptAttachmentsFromDraft(draft.fileReferences) : [],
          });
          return true;
        } catch (error) {
          runtime.retractOptimisticUserMessage(sessionId, message);
          const failure = messageErrorFromUnknown(error);
          get().showToast(
            failure.code === "TURN_NOT_FOUND"
              ? i18n.t("chat.steeringUnavailable")
              : failure.message,
            { variant: "error" },
          );
          return false;
        }
      } finally {
        pendingSubmissions.delete(key);
      }
    },

    sendPrompt: async (content, draft, requestedSessionId) => {
      let sessionId = requestedSessionId ?? get().activeSessionId;
      const submissionKey = sessionId ? `session:${sessionId}` : "draft";
      if (pendingSubmissions.has(submissionKey)) return false;
      pendingSubmissions.add(submissionKey);
      let materializedKey: string | undefined;
      try {
        if (sessionId && get().pendingPlans[sessionId]?.status === "pending") {
          return false;
        }
        if (!sessionId) {
          const intent = runtime.beginNavigationIntent();
          const createdId = await materializeDraftSession(intent);
          if (!createdId) return false;
          sessionId = createdId;
          const key = `session:${createdId}`;
          if (pendingSubmissions.has(key)) return false;
          pendingSubmissions.add(key);
          materializedKey = key;
        }
        if (!sessionId) throw new Error(i18n.t("errors.noActiveSession"));
        if (get().pendingPlans[sessionId]?.status === "pending") return false;
        const promptContent = needsReferenceExpansion(content, draft, sessionId)
          ? await expandReferencedSessions(content, draft, sessionId, content) : content;
        if (promptContent === null || get().pendingPlans[sessionId]?.status === "pending") return false;
        if (get().runningSessions[sessionId]) {
          if (
            get().sessions.find((session) => session.id === sessionId)?.source ===
            "pi-native"
          ) {
            get().showToast(i18n.t("chat.nativeSessionBusy"), { variant: "info" });
            return false;
          }
          return enqueueFrozenPrompt(promptContent, draft, sessionId);
        }
        const startedIn = sessionId;
        const messageCountBeforeSend =
          startedIn === get().activeSessionId
            ? get().messages.length
            : runtime.sessionTranscriptCache.get(startedIn)?.length ?? 0;
        const submission: SubmittedComposerDraft = {
          messageCountBeforeSend,
          draft: draft
            ? {
                text: draft.text,
                fileReferences: draft.fileReferences.map((reference) => ({
                  ...reference,
                })),
              }
            : { text: content, fileReferences: [] },
        };
        runtime.submittedComposerDrafts.set(startedIn, submission);
        set((state) => ({
          isRunning: state.activeSessionId === startedIn ? true : state.isRunning,
          error: null,
          errorCode: null,
          errorRetriable: null,
          runningSessions: { ...state.runningSessions, [startedIn]: true },
          latestTurnResults: withoutRecordKey(state.latestTurnResults, startedIn),
          sessionOutcomes: withoutRecordKey(state.sessionOutcomes, startedIn),
        }));
        const optimisticMessage = optimisticUserMessage(
          crypto.randomUUID(),
          content,
          submission.draft.fileReferences,
        );
        runtime.insertOptimisticUserMessage(startedIn, optimisticMessage);
        try {
          const current = get().sessions.find((session) => session.id === sessionId);
          if (isDefaultSessionTitle(current?.title)) {
            const nextTitle = promptFallbackSessionTitle(
              content,
              untitledTaskTitle(),
            );
            api
              .renameSession(sessionId, nextTitle)
              .then(() => get().refreshSessions())
              .catch(() => {
                // Non-fatal title fallback.
              });
          }
          if (get().pendingPlans[sessionId]?.status === "pending") {
            runtime.submittedComposerDrafts.delete(startedIn);
            runtime.retractOptimisticUserMessage(startedIn, optimisticMessage);
            set((state) => ({
              isRunning:
                state.activeSessionId === startedIn ? false : state.isRunning,
              runningSessions: { ...state.runningSessions, [startedIn]: false },
            }));
            return false;
          }
          const submissionRecord = runtime.submittedComposerDrafts.get(startedIn);
          if (submissionRecord?.abortResolution && (await submissionRecord.abortResolution)) {
            runtime.submittedComposerDrafts.delete(startedIn);
            return false;
          }
          await api.prompt({
            sessionId,
            content: promptContent,
            messageId: optimisticMessage.id,
            viewingSessionId: viewingSessionIdForPrompt(get(), sessionId),
            attachments: draft ? promptAttachmentsFromDraft(draft.fileReferences) : [],
          });
          const submitted = runtime.submittedComposerDrafts.get(startedIn);
          if (submitted?.abortResolution && (await submitted.abortResolution)) {
            return false;
          }
          return true;
        } catch (error) {
          runtime.submittedComposerDrafts.delete(startedIn);
          runtime.retractOptimisticUserMessage(startedIn, optimisticMessage);
          const messageError = messageErrorFromUnknown(error);
          const errorRow = assistantErrorMessage(messageError);
          set((state) => {
            return {
              isRunning:
                state.activeSessionId === startedIn ? false : state.isRunning,
              runningSessions: { ...state.runningSessions, [startedIn]: false },
              latestTurnResults: {
                ...state.latestTurnResults,
                [startedIn]: {
                  status: "failed",
                  turnId: `${startedIn}:${Date.now()}`,
                  finishedAt: Date.now(),
                  errorCode: messageError.code,
                },
              },
              sessionOutcomes: { ...state.sessionOutcomes, [startedIn]: "failed" },
              ...(state.activeSessionId === startedIn
                ? { messages: [...state.messages, errorRow] }
                : {}),
            };
          });
          return false;
        }
      } catch {
        return false;
      } finally {
        pendingSubmissions.delete(submissionKey);
        if (materializedKey) pendingSubmissions.delete(materializedKey);
      }
    },
  };
}
