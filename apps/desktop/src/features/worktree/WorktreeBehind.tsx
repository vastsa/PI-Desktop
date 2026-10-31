import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import type { SessionSummary } from "@pi-desktop/shared";
import { Badge } from "../../components/ui";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { useWorktreeUi } from "./worktree-ui-store";

/** A refocused window re-reads the counts at most this often. */
export const BEHIND_FOCUS_REFRESH_MS = 15_000;

/**
 * Changes whenever an isolated session appears, goes away, changes status, or
 * finishes a turn: the moments its "behind" count can change from inside the
 * app. Commits made outside the app are picked up on window focus.
 */
export function isolatedSessionsKey(sessions: readonly SessionSummary[]): string {
  return sessions
    .filter((session) => session.worktree && session.worktree.status !== "missing")
    .map((session) => `${session.id}:${session.worktree?.status}:${session.updatedAt}`)
    .sort()
    .join("|");
}

/**
 * Keeps the per-session "behind" counts current (ADR 0329). The sidebar list
 * never waits for git: the counts are read in the background and the marker
 * appears when they arrive. Renders nothing.
 */
export function WorktreeBehindWatcher() {
  const key = useAppStore((s) => isolatedSessionsKey(s.sessions));
  const revision = useWorktreeUi((s) => s.behindRevision);
  const refreshBehind = useWorktreeUi((s) => s.refreshBehind);

  useEffect(() => {
    const { setBehind } = useWorktreeUi.getState();
    if (!key) {
      setBehind({});
      return;
    }
    // A slower, older answer never overwrites a newer one.
    let current = true;
    api
      .getWorktreeBehindAll()
      .then((result) => {
        if (!current) return;
        setBehind(result.counts);
        // A conflict resolved outside the app cleared its badge on the host.
        if (result.statusesChanged) void useAppStore.getState().refreshSessions();
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [key, revision]);

  useEffect(() => {
    let last = Date.now();
    const onFocus = () => {
      if (Date.now() - last < BEHIND_FOCUS_REFRESH_MS) return;
      last = Date.now();
      refreshBehind();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refreshBehind]);

  return null;
}

/** "↓2" next to the badge of a session that lacks project commits. */
export function WorktreeBehindMarker({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const count = useWorktreeUi((s) => s.behind[sessionId] ?? 0);
  if (count <= 0) return null;
  return (
    <span
      className="thread-item-worktree"
      title={t("worktree.badge.behindTitle", { count })}
      data-worktree-behind={count}
    >
      <Badge tone="neutral">{t("worktree.badge.behind", { count })}</Badge>
    </span>
  );
}
