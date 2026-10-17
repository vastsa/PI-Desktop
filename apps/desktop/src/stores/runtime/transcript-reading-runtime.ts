import type { SessionDetail } from "@pi-desktop/shared";
import type { SessionHistoryReadOptions } from "../../lib/api";
import { isRemoteSession } from "../../lib/remote-session-safety";
import {
  EMPTY_TRANSCRIPT,
  extendTranscriptView,
  TRANSCRIPT_CONTENT_LIMIT,
  TRANSCRIPT_PAGE_SIZE,
  TRANSCRIPT_SEARCH_PAGE_SIZE,
  transcriptViewFromSession,
  transcriptWasRewritten,
  type TranscriptSearchTarget,
  type TranscriptView,
} from "../../lib/transcript-reading";
import type { AppState } from "../app-state";
import type { StoreAccess } from "../slices/types";

type ReadSession = (
  id: string,
  options: SessionHistoryReadOptions,
) => Promise<{ session: SessionDetail | null }>;
type ReadingActions = Pick<
  AppState,
  "navigateTranscript" | "loadTranscriptPage" | "returnToLatestTranscript" | "restoreTranscriptReading"
>;

/** Read workflows publish renderer views and never write the runtime/model cache. */
export function createTranscriptReadingRuntime({ get, set }: StoreAccess, read: ReadSession) {
  let nextRequestId = 0;

  function currentView(sessionId: string): TranscriptView {
    const state = get();
    return (
      state.transcriptViews[sessionId] ?? {
        messages:
          state.activeSessionId === sessionId
            ? state.messages
            : (state.retainedTranscripts[sessionId] ?? EMPTY_TRANSCRIPT),
        messageStart: state.sessionHistory[sessionId]?.messageStart ?? 0,
        hasMoreBefore: state.sessionHistory[sessionId]?.hasMoreBefore === true,
        hasMoreAfter: false,
        focus: null,
        loading: null,
      }
    );
  }

  function publish(sessionId: string, view: TranscriptView) {
    set((state) => ({ transcriptViews: { ...state.transcriptViews, [sessionId]: view } }));
  }

  function returnToLatestTranscript(sessionId: string) {
    set((state) => {
      if (!state.transcriptViews[sessionId]) return {};
      const { [sessionId]: _released, ...transcriptViews } = state.transcriptViews;
      return { transcriptViews };
    });
  }

  function reportError(sessionId: string, pending: TranscriptView, error: unknown) {
    if (get().transcriptViews[sessionId] !== pending) return;
    publish(sessionId, { ...pending, loading: null });
    if (get().activeSessionId === sessionId)
      get().showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
  }

  const actions: ReadingActions = {
    returnToLatestTranscript,
    restoreTranscriptReading: async (sessionId, position, signal) => {
      if (signal.aborted || get().activeSessionId !== sessionId || !position.messageId) return false;
      const previous = get().transcriptViews[sessionId];
      const range = currentView(sessionId);
      if (get().selectingSessionId !== sessionId &&
        range.messages.some((message) => message.id === position.messageId)) return true;
      // A user navigation already in flight always wins over automatic restore.
      if (range.focus || range.loading) return false;
      const pending: TranscriptView = { ...range, restored: true, loading: "target" };
      const rollback = () => {
        if (get().transcriptViews[sessionId] !== pending) return;
        if (previous) publish(sessionId, previous);
        else returnToLatestTranscript(sessionId);
      };
      publish(sessionId, pending);
      signal.addEventListener("abort", rollback, { once: true });
      try {
        const { session } = await read(sessionId, {
          messageAround: position.messageId,
          messageLimit: TRANSCRIPT_SEARCH_PAGE_SIZE,
          contentLimit: TRANSCRIPT_CONTENT_LIMIT,
        });
        if (signal.aborted || get().transcriptViews[sessionId] !== pending) return false;
        if (get().activeSessionId !== sessionId) {
          rollback();
          return false;
        }
        const message = session?.messages.find((row) => row.id === position.messageId);
        if (!session || !message || (message.parentToolCallId && !session.navigationParent)) {
          rollback();
          return false;
        }
        publish(sessionId, { ...transcriptViewFromSession(session), restored: true });
        return true;
      } catch (error) {
        if (!signal.aborted && get().transcriptViews[sessionId] === pending) {
          rollback();
          if (get().activeSessionId === sessionId)
            get().showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
        }
        return false;
      } finally {
        signal.removeEventListener("abort", rollback);
      }
    },
    navigateTranscript: async (input) => {
      const { sessionId } = input;
      if (get().activeSessionId !== sessionId) return;
      const focus: TranscriptSearchTarget = { ...input, requestId: ++nextRequestId };
      const previous: TranscriptView = { ...currentView(sessionId), loading: null };
      const pending: TranscriptView = { ...previous, loading: "target" };
      publish(sessionId, pending);
      try {
        const { session } = await read(sessionId, {
          messageAround: focus.messageId,
          messageLimit: TRANSCRIPT_SEARCH_PAGE_SIZE,
          contentLimit: TRANSCRIPT_CONTENT_LIMIT,
        });
        if (get().transcriptViews[sessionId] !== pending) return;
        if (get().activeSessionId !== sessionId) {
          returnToLatestTranscript(sessionId);
          return;
        }
        const message = session?.messages.find((candidate) => candidate.id === focus.messageId);
        if (!session || !message) throw new Error("Message no longer exists in this conversation.");
        if (message.parentToolCallId && !session.navigationParent)
          throw new Error("The task for this message no longer exists in this conversation.");
        set((state) => ({
          transcriptViews: {
            ...state.transcriptViews,
            [sessionId]: transcriptViewFromSession(session, focus),
          },
        }));
      } catch (error) {
        if (get().transcriptViews[sessionId] !== pending) return;
        publish(sessionId, previous);
        if (get().activeSessionId === sessionId)
          get().showToast(error instanceof Error ? error.message : String(error), {
            variant: "error",
          });
      }
    },
    loadTranscriptPage: async (sessionId, direction) => {
      const view = currentView(sessionId);
      const remote = isRemoteSession({ id: sessionId });
      // Remote history exposes older-item cursors only; never synthesize a
      // forward cursor by applying local physical-offset arithmetic.
      if (remote && direction === "after") return;
      if (view.loading || !(direction === "before" ? view.hasMoreBefore : view.hasMoreAfter))
        return;
      const limit = view.focus ? TRANSCRIPT_SEARCH_PAGE_SIZE : TRANSCRIPT_PAGE_SIZE;
      const pending: TranscriptView = { ...view, loading: direction };
      publish(sessionId, pending);
      try {
        const { session } = await read(sessionId, {
          messageBefore:
            direction === "before" ? view.messageStart : (view.messageEnd ?? 0) + limit,
          messageLimit: limit,
          contentLimit: TRANSCRIPT_CONTENT_LIMIT,
        });
        if (get().transcriptViews[sessionId] !== pending) return;
        if (!session) throw new Error("Conversation no longer exists.");
        const extended = extendTranscriptView(pending, session, direction);
        // Remote numeric values represent opaque Host item cursors. Preserve
        // the returned cursor rather than depending on its ordering. Local
        // transcripts continue merging physical message offsets unchanged.
        publish(sessionId, remote ? {
          ...extended,
          messageStart: session.messageStart ?? 0,
          messageEnd: undefined,
          hasMoreAfter: false,
        } : extended);
      } catch (error) {
        reportError(sessionId, pending, error);
      }
    },
  };

  /** One lifecycle boundary for pane eviction, new turns, and authoritative edits. */
  function reconcile(state: AppState, previous: AppState) {
    for (const [id, view] of Object.entries(state.transcriptViews)) {
      const evicted = !state.retainedSessionIds.includes(id);
      const started =
        (view.focus || view.restored || view.loading === "target") &&
        state.runningSessions[id] &&
        !previous.runningSessions[id];
      const rewritten =
        state.activeSessionId === id &&
        previous.activeSessionId === id &&
        !state.runningSessions[id] &&
        !previous.runningSessions[id] &&
        !(view.restored && previous.selectingSessionId === id) &&
        state.messages !== previous.messages &&
        transcriptWasRewritten(previous.messages, state.messages);
      if (evicted || started || rewritten) returnToLatestTranscript(id);
    }
  }

  return { actions, reconcile };
}
