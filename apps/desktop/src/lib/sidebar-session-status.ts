export type SidebarSessionStatus =
  | "running"
  | "selected"
  | "completed"
  | "failed"
  | "permission";
export type SidebarSessionOutcome = Extract<
  SidebarSessionStatus,
  "completed" | "failed"
>;

export { latestSessionOutcomes } from "@pi-desktop/shared";

export function sidebarSessionStatus({
  running,
  selected,
  outcome,
  hasPendingPermission,
}: {
  running: boolean;
  selected: boolean;
  outcome?: "completed" | "failed";
  hasPendingPermission?: boolean;
}): SidebarSessionStatus | null {
  if (hasPendingPermission) return "permission";
  if (running) return "running";
  if (selected) return "selected";
  return outcome ?? null;
}
