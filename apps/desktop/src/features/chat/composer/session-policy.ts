import { isGlobalPermissionMode, type Mode } from "@pi-desktop/shared";

/** Operating mode never grants permissions; only Plan projects live planning. */
export function composerSessionPolicy(input: {
  mode: Mode;
  permissionMode: unknown;
  defaultPermissionMode: unknown;
  isRunning: boolean;
  planningState: string | undefined;
}) {
  const inherited = isGlobalPermissionMode(input.defaultPermissionMode) ? input.defaultPermissionMode : "ask";
  return {
    composerPermissionMode: isGlobalPermissionMode(input.permissionMode) ? input.permissionMode : inherited,
    planningLive: input.isRunning && input.planningState === "planning" && input.mode === "plan",
  };
}
