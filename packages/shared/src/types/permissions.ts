/** Shared public types grouped by the owning application domain. */
export type Risk = "low" | "medium" | "high";
export type PermissionDecision = "allow-once" | "allow-session" | "deny";
/** Permission mode (D115): how high-risk tool calls are approved.
 * `inherit` (sessions only) falls back to the global default. */
export const PERMISSION_MODES = ["inherit", "ask", "accept-edits", "auto"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];
/** Global default: `inherit` is not meaningful at the settings level. */
export type GlobalPermissionMode = Exclude<PermissionMode, "inherit">;

export function isGlobalPermissionMode(
  value: unknown,
): value is GlobalPermissionMode {
  return value === "ask" || value === "accept-edits" || value === "auto";
}

export function normalizeGlobalPermissionMode(
  value: unknown,
  fallback: GlobalPermissionMode = "ask",
): GlobalPermissionMode {
  return isGlobalPermissionMode(value) ? value : fallback;
}
