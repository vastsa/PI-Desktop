import {
  IPC,
  type ComputerCapabilities,
  type ComputerCaptureMode,
  type ComputerCursorEvent,
  type ComputerGrantView,
  type ComputerInputPolicy,
  type ComputerTarget,
} from "@pi-desktop/shared";

/**
 * The renderer's computer-use surface (ADR 0340).
 *
 * Read, pick, and revoke — nothing here dispatches input, because the renderer
 * is the one process that must never hold that authority. A refusal keeps its
 * `COMPUTER_*` code so the UI can name it instead of guessing.
 */

export type ComputerUseError = Error & { code: string };

function computerError(code: string, message: string): ComputerUseError {
  return Object.assign(new Error(message), { code });
}

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const bridge = window.piDesktop;
  if (!bridge) throw computerError("HOST_UNAVAILABLE", "Desktop bridge unavailable");
  const result = await bridge.invoke<T>(channel, ...args);
  if (!result.ok) throw computerError(result.error.code, result.error.message);
  return result.data;
}

export const computerUseApi = {
  capabilities: () => invoke<ComputerCapabilities>(IPC.invoke.computerCapabilities),
  listTargets: () => invoke<{ targets: ComputerTarget[] }>(IPC.invoke.computerListTargets),
  grant: () => invoke<{ grant: ComputerGrantView | null }>(IPC.invoke.computerGrantDescribe),
  createGrant: (request: {
    targetId: string;
    sessionId: string;
    inputPolicy?: ComputerInputPolicy;
    capture?: ComputerCaptureMode;
  }) => invoke<ComputerGrantView>(IPC.invoke.computerGrantCreate, request),
  revokeGrant: (reason: string) =>
    invoke<{ revoked: boolean }>(IPC.invoke.computerGrantRevoke, { reason }),
  onGrantChanged: (handler: (grant: ComputerGrantView | null) => void): (() => void) => {
    const bridge = window.piDesktop;
    if (!bridge) return () => undefined;
    return bridge.on(IPC.event.computerGrantChanged, (payload: unknown) => {
      const grant = (payload as { grant?: ComputerGrantView | null } | undefined)?.grant ?? null;
      handler(grant);
    });
  },
  onCursor: (handler: (event: ComputerCursorEvent) => void): (() => void) => {
    const bridge = window.piDesktop;
    if (!bridge) return () => undefined;
    return bridge.on(IPC.event.computerCursor, (payload: unknown) => {
      handler(payload as ComputerCursorEvent);
    });
  },
};
