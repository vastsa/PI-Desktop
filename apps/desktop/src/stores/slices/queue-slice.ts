import i18n from "i18next";
import { formatFileInsert } from "@pi-desktop/shared";
import type {
  AgentQueueChangedEvent,
  AgentPromptAttachment,
  AppError,
  SessionSummary,
  UiMessage,
  QueuedTurnSummary,
} from "@pi-desktop/shared";
import { api } from "../../lib/api";
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

  function toQueuedPrompt(entry: QueuedTurnSummary): QueuedPrompt {
    return {
      id: entry.id,
      sessionId: entry.sessionId,
      content: entry.content,
      draft: queuedDrafts.get(entry.id) ?? {
        text: entry.content,
        fileReferences: (entry.attachments ?? []).map((attachment) => {
          const token = formatFileInsert(attachment.path, "file").trim();
          return {
            ...attachment,
            // Keep restored inline files removable with their visible @path.
            ...(attachment.kind === "file" && entry.content.includes(token) ? { token } : {}),
          };
        }),
      },
      createdAt: Date.parse(entry.createdAt) || Date.now(),
      // The Host owns ordering and priority: entries arrive in delivery order.
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

  /** Only acknowledged rows have a Host id that can actually be removed. */
  function detachQueuedPrompt(sessionId: string, promptId: string): void {
    if (promptId.startsWith("pending:")) return;
    set((state) => ({
      queuedPrompts: removeQueuedPrompt(state.queuedPrompts, sessionId, promptId),
    }));
    queuedDrafts.delete(promptId);
    void api.removeQueuedPrompt(promptId).catch((error) => {
      get().showToast(
        error instanceof Error ? error.message : String(error),
        { variant: "error" },
      );
      void get().refreshQueuedPrompts(sessionId);
    });
  }

  return {
    enqueuePrompt: async (content, draft, requestedSessionId) => {
      const sessionId = requestedSessionId ?? get().activeSessionId;
      if (!sessionId) return false;
      const queuedDraft: ComposerDraftSnapshot = draft
        ? {
            text: draft.text,
            fileReferences: draft.fileReferences.map((reference) => ({
              ...reference,
            })),
          }
        : { text: content, fileReferences: [] };
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
    },

    removeQueuedPrompt: async (promptId) => {
      const sessionId = get().activeSessionId;
      if (!sessionId) return;
      const item = queuedPromptForSession(get().queuedPrompts, sessionId, promptId);
      if (!item || isPendingQueuedPrompt(item)) return;
      try {
        // The Host arbitrates cancellation against delivery. Keep the row
        // visible until it confirms that this input will not be executed.
        await api.removeQueuedPrompt(promptId);
        set((state) => ({
          queuedPrompts: removeQueuedPrompt(state.queuedPrompts, sessionId, promptId),
        }));
        queuedDrafts.delete(promptId);
      } catch (error) {
        const conflict = error instanceof Error && "code" in error && error.code === "CONFLICT";
        get().showToast(conflict ? i18n.t("chat.queuedPromptAlreadyStarted") :
          error instanceof Error ? error.message : String(error), { variant: "error" });
      } finally {
        await get().refreshQueuedPrompts(sessionId);
      }
    },

    /** Return one waiting row to the composer as an editable draft. */
    editQueuedPrompt: (promptId) => {
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
      // `item.content` is token-stripped; the row's captured draft is the text
      // and the inline file references the user actually wrote.
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

    /** Move one waiting row past its neighbour; promoted rows stay locked. */
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
      // A promoted neighbour means the row already sits at its block boundary.
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
      let prioritized = false;
      try {
        await api.prioritizeQueuedPrompt(promptId);
        prioritized = true;
        // Send now keeps its graceful stop: the active turn reaches its
        // boundary before the promoted row starts.
        if (get().runningSessions[sessionId] &&
            queuedPromptForSession(get().queuedPrompts, sessionId, promptId)) {
          const result = await api.stop(sessionId);
          if (!result.requested) {
            await get().refreshQueuedPrompts(sessionId);
            if (queuedPromptForSession(get().queuedPrompts, sessionId, promptId)) {
              get().showToast(i18n.t("chat.queuedPromptStopFailed"), { variant: "info" });
            }
          }
        }
      } catch (error) {
        await get().refreshQueuedPrompts(sessionId);
        const detail = error instanceof Error ? error.message : String(error);
        const stillQueued = queuedPromptForSession(get().queuedPrompts, sessionId, promptId);
        get().showToast(
          prioritized && stillQueued ? `${i18n.t("chat.queuedPromptStopFailed")} ${detail}` : detail,
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
      const message = optimisticUserMessage(
        crypto.randomUUID(), content, draft?.fileReferences ?? [],
      );
      message.steering = true;
      runtime.insertOptimisticUserMessage(sessionId, message);
      try {
        await api.steer({
          sessionId, expectedTurnId, content, messageId: message.id,
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
        if (get().runningSessions[sessionId]) {
          // Native Pi children have no Desktop prompt queue. Reject the send
          // here so the caller restores the draft instead of round-tripping a
          // queue item the backend refuses.
          if (
            get().sessions.find((session) => session.id === sessionId)?.source ===
            "pi-native"
          ) {
            get().showToast(i18n.t("chat.nativeSessionBusy"), { variant: "info" });
            return false;
          }
          const accepted = await get().enqueuePrompt(content, draft, sessionId);
          return accepted;
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
            content,
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
      } catch (error) {
        // Keep sendPrompt's Promise<boolean> contract so the composer can
        // restore a draft cleared before submission, even on unexpected setup errors.
        return false;
      } finally {
        pendingSubmissions.delete(submissionKey);
        if (materializedKey) pendingSubmissions.delete(materializedKey);
      }
    },
  };
}
