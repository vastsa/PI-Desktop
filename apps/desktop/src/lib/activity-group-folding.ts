/*
 * Folding defaults for the two nested levels of a turn's process.
 *
 * A turn's process disclosure is one level; the activity groups and the
 * Thinking rows inside it are the two levels below. Each level answers only its
 * own question here; the disclosure machinery combines this default with the
 * reader's explicit choice, the parent's visibility, and transient reading
 * protection (see `disclosure.tsx`).
 *
 * A group can settle before its turn ends. Only the current group and groups
 * with live work stay open by default; finished groups and Thinking rows
 * follow their own switches, regardless of size.
 */

/** Whether a rendered activity group starts open. */
export function activityGroupStartsOpen(state: {
  /** This group still owns live work, including running delegations. */
  groupActive: boolean;
  /** `resolveAutoCollapseSettledGroups` for the current settings. */
  collapseSettled: boolean;
}): boolean {
  return state.groupActive || !state.collapseSettled;
}

/** Whether a rendered Thinking row starts open. */
export function thinkingRowStartsOpen(state: {
  /** The live turn is still producing this row's reasoning. */
  streaming: boolean;
  /** `resolveAutoCollapseThinking` for the current settings. */
  collapseSettled: boolean;
}): boolean {
  return state.streaming || !state.collapseSettled;
}
