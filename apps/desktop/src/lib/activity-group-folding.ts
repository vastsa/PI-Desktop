/*
 * Folding defaults for the two nested levels of a turn's process.
 *
 * A turn's process disclosure is one level; the activity groups and the
 * Thinking rows inside it are the two levels below. Each level answers only its
 * own question here; the disclosure machinery combines this default with the
 * reader's explicit choice, the parent's visibility, and transient reading
 * protection (see `disclosure.tsx`).
 *
 * Live work always stays visible. Everything else is settled, and the reader's
 * preference decides: by default a completed turn folds both levels, so opening
 * it reads as a compact list of what the agent did rather than a wall of rows.
 * Size is deliberately not part of either rule - the old "groups of up to four
 * rows stay open" tier was the reason `Show thinking` and small groups looked
 * permanently expanded, and it is replaced by the two switches.
 */

/** Whether a rendered activity group starts open. */
export function activityGroupStartsOpen(state: {
  /** The assistant turn this group belongs to is still running. */
  turnActive: boolean;
  /** This group still owns live work, including running delegations. */
  groupActive: boolean;
  /** `resolveAutoCollapseSettledGroups` for the current settings. */
  collapseSettled: boolean;
}): boolean {
  return state.turnActive || state.groupActive || !state.collapseSettled;
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
