import { IPC } from "@pi-desktop/shared";
import type { HostProcess } from "../host-process";
import type { IpcRegistrar } from "./types";

export type BackgroundTasksIpcDependencies = {
  registrar: IpcRegistrar;
  getHost: () => HostProcess | null;
};

/** The renderer sends `{ id }`; accept a bare string too for direct callers. */
function backgroundTaskId(payload: unknown): { id: string } {
  const candidate =
    typeof payload === "string"
      ? payload
      : (payload as { id?: unknown } | undefined)?.id;
  if (typeof candidate !== "string" || candidate.length === 0) {
    throw new Error("background task id required");
  }
  return { id: candidate };
}

/**
 * Chat-started background tasks (dev servers, watchers) live in host-core.
 * Main only relays the three calls; the lifecycle — including app-exit
 * cleanup — is host-owned so a renderer reload never kills a running server.
 */
export function registerBackgroundTasksIpc({
  registrar,
  getHost,
}: BackgroundTasksIpcDependencies): void {
  const callHost = (method: string, params?: unknown) => {
    const host = getHost();
    if (!host) throw new Error("host unavailable");
    // A background call returns as soon as the process is spawned, so the
    // default host-call timeout applies to relay latency only.
    return params === undefined ? host.call(method) : host.call(method, params);
  };

  registrar.handle(IPC.invoke.backgroundTasksList, () =>
    callHost("backgroundTasks.list"),
  );
  registrar.handle(IPC.invoke.backgroundTasksOutput, (payload: unknown) =>
    callHost("backgroundTasks.output", backgroundTaskId(payload)),
  );
  registrar.handle(IPC.invoke.backgroundTasksStop, (payload: unknown) =>
    callHost("backgroundTasks.stop", backgroundTaskId(payload)),
  );
}
