import type { AppSettings } from "@pi-desktop/shared";

/*
 * Which levels of a settled turn fold themselves (issue #2094).
 *
 * Both preferences are opt-out on purpose: a completed turn should read as its
 * answer plus a compact list of what the agent did, and the two switches are
 * there for readers who would rather keep the rows open. Absent, invalid, and
 * `true` all mean "fold", so a settings file written before these fields
 * existed behaves the way the product ships today.
 */

/**
 * Whether a settled activity group folds itself.
 *
 * `false` means every settled group stays open - it is not "keep the old
 * size-based tier": the four-row rule that used to decide this is gone, because
 * a switch labelled "auto-collapse" must not still collapse something.
 */
export function resolveAutoCollapseSettledGroups(
  settings: AppSettings | undefined,
): boolean {
  return settings?.autoCollapseSettledGroups !== false;
}

/** Whether reasoning that is no longer being generated folds itself. */
export function resolveAutoCollapseThinking(
  settings: AppSettings | undefined,
): boolean {
  return settings?.autoCollapseThinking !== false;
}
