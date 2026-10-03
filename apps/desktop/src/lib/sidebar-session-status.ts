export type SidebarSessionStatus = "completed" | "failed" | "permission";
export type SidebarSessionOutcome = Extract<
  SidebarSessionStatus,
  "completed" | "failed"
>;

export { latestSessionOutcomes } from "@pi-desktop/shared";

/**
 * The indicator a row still carries. A running row says so by sheening its
 * title, and the selected row by its own background, so neither paints a dot
 * and neither can crowd the leading edge the other three share.
 */
export function sidebarSessionStatus({
  outcome,
  hasPendingPermission,
}: {
  outcome?: "completed" | "failed";
  hasPendingPermission?: boolean;
}): SidebarSessionStatus | null {
  if (hasPendingPermission) return "permission";
  return outcome ?? null;
}
