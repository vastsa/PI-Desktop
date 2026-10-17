import { useEffect, useRef, useState } from "react";
import type {
  AgentActivity,
  SessionSummary,
  UiMessage,
} from "@pi-desktop/shared";
import { api } from "../../../lib/api";
import {
  calculateSessionTimingBreakdown,
  calculateSessionTiming,
  loadEarlierSessionTiming,
  type SessionTimingBreakdown,
  type SessionTiming,
  type SessionTimingTotals,
} from "../../../lib/session-timing";
import type { SessionHistoryWindow } from "../../../stores/app-state";

type HistoryLoadState = {
  key: string;
  status: "loading" | "ready" | "error";
  totals?: SessionTimingTotals;
};

type CachedSessionTiming = {
  key: string;
  totals: SessionTimingTotals;
};

const MAX_CACHED_SESSION_TIMINGS = 16;

export type SessionTimingView = {
  timing?: SessionTiming;
  breakdown?: SessionTimingBreakdown;
  historyStatus: "loading" | "ready" | "error";
};

export function useSessionTiming({
  enabled,
  session,
  sessionId,
  messages,
  history,
  isRunning,
  modelRequestActivity,
}: {
  enabled: boolean;
  session?: Pick<SessionSummary, "createdAt" | "updatedAt">;
  sessionId?: string;
  messages: UiMessage[];
  history?: SessionHistoryWindow;
  isRunning: boolean;
  modelRequestActivity?: AgentActivity;
}): SessionTimingView {
  const messageStart = history?.messageStart ?? 0;
  const hasMoreBefore = history?.hasMoreBefore === true;
  const historyKey = `${sessionId ?? ""}:${messageStart}:${session?.updatedAt ?? ""}`;
  const historyCache = useRef(new Map<string, CachedSessionTiming>());
  const [historyLoad, setHistoryLoad] = useState<HistoryLoadState>();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [enabled]);

  useEffect(() => {
    if (!enabled || !sessionId || !hasMoreBefore || messageStart <= 0) return;

    const cachedTiming = historyCache.current.get(sessionId);
    if (cachedTiming?.key === historyKey) {
      historyCache.current.delete(sessionId);
      historyCache.current.set(sessionId, cachedTiming);
      setHistoryLoad({
        key: historyKey,
        status: "ready",
        totals: cachedTiming.totals,
      });
      return;
    }

    const controller = new AbortController();
    setHistoryLoad({ key: historyKey, status: "loading" });
    void loadEarlierSessionTiming(
      messageStart,
      async (options) => {
        const result = await api.getSession(sessionId, options);
        return result.session
          ? {
              messages: result.session.messages,
              messageStart: result.session.messageStart,
              hasMoreBefore: result.session.hasMoreBefore,
            }
          : null;
      },
      controller.signal,
    ).then(
      (totals) => {
        if (controller.signal.aborted) return;
        if (
          !historyCache.current.has(sessionId) &&
          historyCache.current.size >= MAX_CACHED_SESSION_TIMINGS
        ) {
          const oldestSessionId = historyCache.current.keys().next().value;
          if (oldestSessionId) historyCache.current.delete(oldestSessionId);
        }
        historyCache.current.set(sessionId, { key: historyKey, totals });
        setHistoryLoad({ key: historyKey, status: "ready", totals });
      },
      () => {
        if (controller.signal.aborted) return;
        setHistoryLoad({ key: historyKey, status: "error" });
      },
    );

    return () => controller.abort();
  }, [enabled, hasMoreBefore, historyKey, messageStart, sessionId]);

  const historyStatus = !hasMoreBefore
    ? "ready"
    : historyLoad?.key === historyKey
      ? historyLoad.status
      : "loading";
  const earlierTotals =
    historyStatus === "ready" && historyLoad?.key === historyKey
      ? historyLoad.totals
      : undefined;
  const timing = enabled && session
    ? calculateSessionTiming({
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        isRunning,
        messages,
        now,
        earlierModelResponseMs: earlierTotals?.modelResponseMs ?? 0,
      })
    : undefined;
  const breakdown = timing
    ? calculateSessionTimingBreakdown({
        elapsedMs: timing.elapsedMs,
        messages,
        now,
        ...(earlierTotals ? { earlierTotals } : {}),
        ...(modelRequestActivity?.phase === "waiting-model"
          ? { activeNetworkRequestStartedAt: modelRequestActivity.since }
          : {}),
      })
    : undefined;

  return { timing, breakdown, historyStatus };
}
