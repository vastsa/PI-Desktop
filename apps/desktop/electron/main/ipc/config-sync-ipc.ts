import { IPC } from "@pi-desktop/shared";
import type { HostProcess } from "../host-process";
import type { IpcRegistrar } from "./types";

export type ConfigSyncIpcDependencies = {
  registrar: IpcRegistrar;
  getHost: () => HostProcess | null;
  sendToRenderer: (channel: string, payload?: unknown) => void;
};

/** Keep WebDAV credentials and vault passwords inside Host IPC calls. */
export function registerConfigSyncIpc({
  registrar,
  getHost,
  sendToRenderer,
}: ConfigSyncIpcDependencies): void {
  const callHost = (method: string, params?: unknown) => {
    const host = getHost();
    if (!host) throw new Error("host unavailable");
    return params === undefined ? host.call(method) : host.call(method, params);
  };
  const handle = (channel: string, fn: (...args: unknown[]) => Promise<unknown>) => {
    registrar.handle(channel, async (...args: unknown[]) => {
      const host = getHost();
      if (!host) throw new Error("host unavailable");
      const result = await fn(...args);
      if (channel !== IPC.invoke.configSyncTest) {
        sendToRenderer(IPC.event.configSyncChanged, result);
      }
      return result;
    });
  };

  handle(IPC.invoke.configSyncGetState, () => callHost("configSync.getState"));
  handle(IPC.invoke.configSyncConfigure, (input: unknown) =>
    callHost("configSync.configure", input),
  );
  handle(IPC.invoke.configSyncTest, (input: unknown) =>
    callHost("configSync.test", input),
  );
  handle(IPC.invoke.configSyncSyncNow, () => callHost("configSync.syncNow"));
  handle(IPC.invoke.configSyncPause, (input: unknown) =>
    callHost("configSync.pause", input),
  );
  handle(IPC.invoke.configSyncUnlock, (input: unknown) =>
    callHost("configSync.unlock", input),
  );
  handle(IPC.invoke.configSyncApprove, (input: unknown) =>
    callHost("configSync.approve", input),
  );
  handle(IPC.invoke.configSyncReject, (input: unknown) =>
    callHost("configSync.reject", input),
  );
  handle(IPC.invoke.configSyncMapProject, (input: unknown) =>
    callHost("configSync.mapProject", input),
  );
  handle(IPC.invoke.configSyncListHistory, () => callHost("configSync.listHistory"));
  handle(IPC.invoke.configSyncRestore, (input: unknown) =>
    callHost("configSync.restore", input),
  );
  handle(IPC.invoke.configSyncChangePassword, (input: unknown) =>
    callHost("configSync.changePassword", input),
  );
  handle(IPC.invoke.configSyncDisconnect, () =>
    callHost("configSync.disconnect"),
  );
}
