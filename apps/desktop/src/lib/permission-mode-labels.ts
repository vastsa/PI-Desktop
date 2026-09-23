import type { PermissionMode } from "@pi-desktop/shared";

/** One label mapping shared by Composer and task configuration surfaces. */
export const PERMISSION_MODE_I18N_KEYS: Record<PermissionMode, string> = {
  inherit: "chat.permissionInherit",
  ask: "chat.permissionAsk",
  "accept-edits": "chat.permissionAcceptEdits",
  auto: "chat.permissionAuto",
};
