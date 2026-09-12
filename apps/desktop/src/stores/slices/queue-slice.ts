import i18n from "i18next";
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
  clearQueuedPromptSendNow,
  enqueueQueuedPrompt,
  prioritizeQueuedPrompt,
  queuedPromptForSession,
  removeQueuedPrompt,
  type QueuedPrompt,
} from "../../lib/queued-prompts";
import type { ComposerDraftSnapshot } from "../../lib/composer-smart-stop";
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
  | "sendQueuedNow"
  | "refreshQueuedPrompts"
  | "applyQueueChanged"
  | "sendPrompt"
> {
  const queuedDrafts = new Map<string, ComposerDraftSnapshot>();

  function toQueuedPrompt(
    entry: QueuedTurnSummary,
    previous?: QueuedPrompt,
  ): QueuedPrompt {
    return {
      id: entry.id,
      sessionId: entry.sessionId,
      content: entry.content,
      draft: queuedDrafts.get(entry.id) ?? {
        text: entry.content,
        fileReferences: [],
      },
      createdAt: Date.parse(entry.createdAt) || Date.now(),
      ...(previous?.sendNowRequested ? { sendNowRequested: true } : {}),
    };
  }

  function applyQueueEntries(
    sessionId: string,
    entries: QueuedTurnSummary[],
  ): void {
    set((state) => {
      const current = state.queuedPrompts[sessionId] ?? [];
      const pending = current.filter((item) => item.id.startsWith("pending:"));
      const mirrored = entries.map((entry) =>
        toQueuedPrompt(entry, current.find((item) => item.id === entry.id)),
      );
      for (const item of current) {
        if (
          !item.id.startsWith("pending:") &&
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

  return {
    enqueuePrompt: (content, draft, requestedSessionId) => {
      const sessionId = requestedSessionId ?? get().activeSessionId;
      if (!sessionId) return;
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
      void api
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
          return get().refreshQueuedPrompts(sessionId);
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
        });
    },

    removeQueuedPrompt: (promptId) => {
      const sessionId = get().activeSessionId;
      if (!sessionId) return;
      set((state) => ({
        queuedPrompts: removeQueuedPrompt(
          state.queuedPrompts,
          sessionId,
          promptId,
        ),
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
    },

    sendQueuedNow: async (promptId) => {
      const sessionId = get().activeSessionId;
      if (!sessionId) return;
      const item = queuedPromptForSession(
        get().queuedPrompts,
        sessionId,
        promptId,
      );
      if (!item || item.id.startsWith("pending:") || item.sendNowRequested) return;
      set((state) => ({
        queuedPrompts: prioritizeQueuedPrompt(
          state.queuedPrompts,
          sessionId,
          promptId,
        ),
      }));
      try {
        await api.prioritizeQueuedPrompt(promptId);
        if (get().runningSessions[sessionId]) {
          const result = await api.stop(sessionId);
          if (!result.requested) {
            set((state) => ({
              queuedPrompts: clearQueuedPromptSendNow(
                state.queuedPrompts,
                sessionId,
              ),
            }));
          }
        }
      } catch (error) {
        set((state) => ({
          queuedPrompts: clearQueuedPromptSendNow(
            state.queuedPrompts,
            sessionId,
          ),
        }));
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

    sendPrompt: async (content, draft, requestedSessionId) => {
      let sessionId = requestedSessionId ?? get().activeSessionId;
      if (sessionId && get().pendingPlans[sessionId]?.status === "pending") {
        return false;
      }
      if (!sessionId) {
        const intent = runtime.beginNavigationIntent();
        const createdId = await materializeDraftSession(intent);
        if (!createdId) return false;
        sessionId = createdId;
      }
      if (!sessionId) throw new Error(i18n.t("errors.noActiveSession"));
      if (get().pendingPlans[sessionId]?.status === "pending") return false;
      if (get().runningSessions[sessionId]) {
        get().enqueuePrompt(content, draft, sessionId);
        return true;
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
        set((state) => ({
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
            ? { messages: [...state.messages, assistantErrorMessage(messageError)] }
            : {}),
        }));
        return false;
      }
    },
  };
}
