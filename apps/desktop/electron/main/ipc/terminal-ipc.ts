import { ErrorCodes, IPC } from "@pi-desktop/shared";
import type { IpcRegistrar } from "./types.js";

export type RegisterTerminalIpcOptions = {
  registrar: Pick<IpcRegistrar, "handle">;
};

/**
 * Register the remote-only terminal IPC surface. Remote sessions are routed
 * before these local fallbacks run; a local session has no terminal entry
 * point in Desktop and must fail closed here.
 */
export function registerTerminalIpc({ registrar }: RegisterTerminalIpcOptions): void {
  const channels = [
    IPC.invoke.remoteTerminalOpen,
    IPC.invoke.remoteTerminalInput,
    IPC.invoke.remoteTerminalResize,
    IPC.invoke.remoteTerminalClose,
  ];
  for (const channel of channels) {
    registrar.handle(channel, async () => {
      throw Object.assign(
        new Error("interactive terminals are available only for paired remote sessions"),
        { errorCode: ErrorCodes.CAPABILITY_UNAVAILABLE },
      );
    });
  }
}
