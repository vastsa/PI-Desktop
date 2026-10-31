import type { AssistantActivityItem } from "./assistant-turns";

/** A settled ordinary group stays open up to this many visible rows. */
export const ACTIVITY_GROUP_AUTO_OPEN_MAX_ITEMS = 4;

/**
 * Whether a rendered activity group starts open.
 *
 * Folding is decided once per state, not per row: work the turn still owns stays
 * visible, reader-requested reasoning stays visible, and only a settled group of
 * plain tool rows falls back to the small-group rule. Explicit user choices are
 * applied on top of this default and are never derived from it.
 */
export function activityGroupStartsOpen(
  visibleItems: readonly AssistantActivityItem[],
  state: {
    /** Task fan-out is its own topology and keeps its released open default. */
    subagentTopology: boolean;
    /** The assistant turn is still running. */
    turnActive: boolean;
    /** This group still owns live work, including running delegations. */
    groupActive: boolean;
  },
): boolean {
  // `visibleItems` already excludes reasoning hidden by the preference, so a
  // remaining Thinking row is content the reader asked to see. Folding it away
  // would make `Show thinking` look broken.
  const visibleReasoning = visibleItems.some((item) => item.kind === "thinking");
  return (
    state.subagentTopology ||
    state.turnActive ||
    state.groupActive ||
    visibleReasoning ||
    visibleItems.length <= ACTIVITY_GROUP_AUTO_OPEN_MAX_ITEMS
  );
}
