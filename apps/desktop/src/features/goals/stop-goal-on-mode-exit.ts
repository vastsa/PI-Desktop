import type { Mode, SessionSummary } from "@pi-desktop/shared";
import { isRemoteSession } from "../../lib/remote-session-safety";

/** Staging a new mode must not allow the autonomous scheduler another turn. */
export function stopGoalOnModeExit(
  api: { abort(sessionId: string): Promise<unknown> },
  session: SessionSummary | undefined,
  nextMode: Mode,
): Promise<unknown> | undefined {
  if (!session || session.mode !== "goal" || nextMode === "goal" || isRemoteSession(session) || session.source === "pi-native") return;
  // Main persists the pause before aborting. Do not clear running state locally:
  // the normal turn-end event still owns the staged configuration flush.
  return api.abort(session.id);
}
