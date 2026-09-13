import type { AppNotification } from "./types/workspace.js";

export function latestSessionOutcomes(
  notifications: AppNotification[],
): Record<string, "completed" | "failed"> {
  const outcomes: Record<string, "completed" | "failed"> = {};
  const seen = new Set<string>();

  // The host and renderer both keep notifications newest-first, so the first
  // entry per session is its latest terminal result. The badge means "a result
  // you have not looked at yet": once the notification is read — opening the
  // conversation reads it — the session gets no indicator at all.
  for (const notification of notifications) {
    if (seen.has(notification.sessionId)) continue;
    seen.add(notification.sessionId);
    if (notification.readAt) continue;
    outcomes[notification.sessionId] =
      notification.kind === "task.failed" ? "failed" : "completed";
  }

  return outcomes;
}
