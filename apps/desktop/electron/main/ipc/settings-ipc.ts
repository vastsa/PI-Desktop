import { IPC } from "@pi-desktop/shared";
import { testNetworkProxy } from "../network-proxy";
import type { AgentSidecar } from "../agent-sidecar";
import type { HostProcess } from "../host-process";
import type { IpcRegistrar } from "./types";

export type SettingsIpcDependencies = {
  registrar: IpcRegistrar;
  getHost: () => HostProcess | null;
  getSidecar: () => AgentSidecar | null;
  dataDir: string;
  normalizeSettings: (settings: unknown) => unknown;
  validateSettingsWrite: (settings: unknown) => any;
  testNetworkProxy: (settings: unknown) => Promise<unknown>;
  applyNetworkProxyFromAppSettings: (settings: unknown) => Promise<unknown>;
  currentNetworkProxy: () => unknown;
  applyApplicationMenuSettings: (settings?: {
    language?: unknown;
    theme?: unknown;
    keybindings?: unknown;
    developerMode?: unknown;
  } | null) => void;
  applyDeveloperMode: (settings?: { developerMode?: unknown } | null) => void;
  resolveEffectiveCommandShell: () => Promise<unknown>;
};

/** Register app settings and command-shell channels. */
export function registerSettingsIpc({
  registrar,
  getHost,
  getSidecar,
  dataDir,
  normalizeSettings,
  validateSettingsWrite,
  testNetworkProxy,
  applyNetworkProxyFromAppSettings,
  currentNetworkProxy,
  applyApplicationMenuSettings,
  applyDeveloperMode,
  resolveEffectiveCommandShell,
}: SettingsIpcDependencies): void {
  let host: HostProcess | null = null;
  let sidecar: AgentSidecar | null = null;
  const handle = (channel: string, fn: (...args: any[]) => Promise<any>) => {
    registrar.handle(channel, async (...args) => {
      host = getHost();
      sidecar = getSidecar();
      return fn(...args);
    });
  };

  handle(IPC.invoke.settingsGet, async () => {
    if (!host) throw new Error("host unavailable");
    const settings = await host.call("settings.get");
    return normalizeSettings(settings);
  });

  handle(IPC.invoke.networkProxyTest, async (settings: unknown) => {
    return testNetworkProxy(settings);
  });

  handle(IPC.invoke.settingsSet, async (settings: unknown) => {
    if (!host) throw new Error("host unavailable");
    const validatedSettings = validateSettingsWrite(settings);
    const result = await host.call("settings.set", validatedSettings);
    await applyNetworkProxyFromAppSettings(validatedSettings);
    if (sidecar) {
      try {
        await sidecar.call("sidecar.configure", {
          hostBinary: host.binaryPath,
          dataDir,
          networkProxy: currentNetworkProxy(),
        });
      } catch {
        // Sidecar will pick up PI_DESKTOP_PROXY_JSON on the next spawn.
      }
    }
    applyApplicationMenuSettings(
      validatedSettings as {
        language?: unknown;
        theme?: unknown;
        keybindings?: unknown;
        developerMode?: unknown;
      } | null,
    );
    applyDeveloperMode(validatedSettings as { developerMode?: unknown } | null);
    return result;
  });

  handle(IPC.invoke.commandShellList, async () => resolveEffectiveCommandShell());
}
