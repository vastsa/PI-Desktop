import type { GlobalPermissionMode, PermissionMode } from "@pi-desktop/shared";

export const PLAN_APPROVAL_FALLBACK_MODE: GlobalPermissionMode = "ask";

function isApprovalMode(value: unknown): value is GlobalPermissionMode {
  return value === "ask" || value === "accept-edits" || value === "auto";
}

export function readPlanApprovalMode(
  permissionMode?: PermissionMode,
  defaultPermissionMode?: GlobalPermissionMode,
): GlobalPermissionMode {
  if (isApprovalMode(permissionMode)) return permissionMode;
  return isApprovalMode(defaultPermissionMode)
    ? defaultPermissionMode
    : PLAN_APPROVAL_FALLBACK_MODE;
}
