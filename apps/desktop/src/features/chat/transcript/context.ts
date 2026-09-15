import { createContext } from "react";
import { useAppStore } from "../../../stores/app-store";

/**
 * Whether this transcript is a passive projection of another session (D-LOCAL-message-quotes).
 *
 * A docked side chat renders a real session that is not the application's active
 * one, but the row toolbars resolve against the active session — Delete would
 * re-page the visible conversation, Edit/Retry/Fork would address ids the parent
 * does not own, and the inline permission card would duplicate the panel's own.
 * A read-only projection therefore renders content only, and the panel owns every
 * control for its child.
 */
export const TranscriptReadOnlyContext = createContext(false);

/** Visible conversation title: the quote attribution and the side-chat source. */
export function useActiveSessionTitle(): string {
  return useAppStore(
    (state) =>
      state.sessions.find((session) => session.id === state.activeSessionId)
        ?.title ?? "",
  );
}
