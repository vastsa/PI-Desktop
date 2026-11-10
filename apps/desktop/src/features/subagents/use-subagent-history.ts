import type { UiMessage } from "@pi-desktop/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../lib/api";
import { mergeSubagentMessages } from "./model";
import { readSubagentIndexPage, readSubagentTranscriptPage, type SubagentHistoryPage } from "./history";

type HistoryState = {
  key: string | null;
  messages: UiMessage[];
  cursor?: number;
  hasMore: boolean;
  loading: boolean;
  error: Error | null;
};
type ReadPage = (cursor: number | undefined, signal: AbortSignal) => Promise<SubagentHistoryPage>;
const empty = (key: string | null): HistoryState => ({
  key, messages: [], hasMore: false, loading: false, error: null,
});

/** One owner for each reader; stale or disposed requests never commit their rows. */
function usePagedSubagentHistory(key: string | null, readPage: ReadPage) {
  const [state, setState] = useState<HistoryState>(() => empty(key));
  const active = useRef<AbortController | null>(null);
  const load = useCallback(async (cursor?: number, reset = false) => {
    if (!key || (active.current && !reset)) return;
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setState((previous) => ({ ...(reset || previous.key !== key ? empty(key) : previous),
      loading: true, error: null }));
    try {
      const page = await readPage(cursor, controller.signal);
      if (controller.signal.aborted) return;
      setState((previous) => previous.key !== key ? previous : {
        key,
        messages: mergeSubagentMessages(previous.messages, page.messages),
        cursor: page.before ?? page.after,
        hasMore: page.hasMore, loading: false, error: null,
      });
    } catch (error) {
      if (!controller.signal.aborted) {
        setState((previous) => previous.key !== key ? previous : {
          ...previous, loading: false,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    } finally {
      if (active.current === controller) active.current = null;
    }
  }, [key, readPage]);

  useEffect(() => {
    void load(undefined, true);
    return () => { active.current?.abort(); active.current = null; };
  }, [load]);
  const visible = state.key === key ? state : empty(key);
  return {
    ...visible,
    reload: () => void load(undefined, true),
    loadMore: () => { if (visible.hasMore && !visible.loading) void load(visible.cursor); },
  };
}

export function useSubagentIndex(sessionId: string | undefined) {
  const read = useCallback((cursor: number | undefined, signal: AbortSignal) =>
    readSubagentIndexPage(api.getSession, sessionId ?? "", cursor, signal), [sessionId]);
  return usePagedSubagentHistory(sessionId ? `${sessionId}:index` : null, read);
}

export function useSubagentTranscriptHistory(sessionId: string, calls: readonly UiMessage[]) {
  const signature = JSON.stringify(calls.map((call) => call.toolCallId ?? call.id));
  // This is our own serialized string array, not external input.
  const callIds = useMemo(() => JSON.parse(signature) as string[], [signature]);
  const read = useCallback((cursor: number | undefined, signal: AbortSignal) =>
    readSubagentTranscriptPage(api.getSession, sessionId, callIds, cursor, signal), [sessionId, callIds]);
  return usePagedSubagentHistory(`${sessionId}:transcript:${signature}`, read);
}
