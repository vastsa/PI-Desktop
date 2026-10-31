import { useMemo } from "react";
import { EMPTY_TRANSCRIPT, isTranscriptAtLiveTail, transcriptViewMessages } from "../lib/transcript-reading";
import { useAppStore } from "../stores/app-store";

/** Main transcript and subagent details consume the same renderer reading range. */
export function useTranscriptView(sessionId: string) {
  const live = useAppStore((state) =>
    state.activeSessionId === sessionId
      ? state.messages
      : (state.retainedTranscripts[sessionId] ?? EMPTY_TRANSCRIPT),
  );
  const history = useAppStore((state) => state.sessionHistory[sessionId]);
  const view = useAppStore((state) => state.transcriptViews[sessionId]);
  const messages = useMemo(() => transcriptViewMessages(live, view), [live, view]);
  return {
    messages,
    hasMoreBefore: view?.hasMoreBefore ?? history?.hasMoreBefore ?? false,
    hasMoreAfter: view?.hasMoreAfter ?? false,
    focus: view?.focus ?? null,
    parentMessage: view?.parentMessage,
    historical: Boolean(view?.focus || view?.restored),
    liveTail: isTranscriptAtLiveTail(live, messages, view),
    loading: Boolean(view?.loading),
  };
}
