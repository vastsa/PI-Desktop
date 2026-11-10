import {
  IPC, type UpdatePreference,
  normalizeProviderRetryMaxAttempts,
  normalizeProviderRetryInitialDelayMs,
  normalizeProviderRetryFixedDelayMs,
  providerRetrySettingsWriteError,
} from "@pi-desktop/shared";
import type { AgentSidecar } from "../agent-sidecar";
import type { HostProcess } from "../host-process";
import type { IpcRegistrar } from "./types";
import type { LiveCallService } from "../live-voice/call-service";
import type { AppSettings } from "@pi-desktop/shared";
import { currentNetworkDns, currentSystemProxyRelayUrl, ensureSystemProxyRelay } from "../network-proxy";

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
    fontScale?: unknown;
  } | null) => void;
  applyDeveloperMode: (settings?: { developerMode?: unknown } | null) => void;
  applyPreventScreenSleep: (settings?: { preventScreenSleep?: unknown } | null) => void;
  applyKeepAwakeWhileRunning: (settings?: { keepAwakeWhileRunning?: unknown } | null) => void;
  applyUpdatePreference: (preference: UpdatePreference) => void;
  resolveEffectiveCommandShell: () => Promise<unknown>;
  liveCallService?: Pick<LiveCallService, "beginSettingsWrite" | "settingsWritten">;
};

function normalizeRetrySettings(settings: unknown): unknown {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return settings;
  const normalized: Record<string, unknown> = { ...settings };
  for (const [field, normalize] of [
    ["providerRetryMaxAttempts", normalizeProviderRetryMaxAttempts],
    ["providerRetryInitialDelayMs", normalizeProviderRetryInitialDelayMs],
    ["providerRetryFixedDelayMs", normalizeProviderRetryFixedDelayMs],
  ] as const) {
    const value = normalize(normalized[field]);
    if (value === undefined) delete normalized[field];
    else normalized[field] = value;
  }
  return normalized;
}

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
  applyPreventScreenSleep,
  applyKeepAwakeWhileRunning,
  applyUpdatePreference,
  resolveEffectiveCommandShell,
  liveCallService,
}: SettingsIpcDependencies): void {
  let host: HostProcess | null = null;
  let settingsWriteQueue = Promise.resolve();
  const queueSettingsWrite = (write: () => Promise<AppSettings>): Promise<AppSettings> => {
    const operation = settingsWriteQueue.then(write);
    settingsWriteQueue = operation.then(() => {}, () => {});
    return operation;
  };
  const handle = (channel: string, fn: (...args: any[]) => Promise<any>) => {
    registrar.handle(channel, async (...args) => {
      host = getHost();
      return fn(...args);
    });
  };

  handle(IPC.invoke.settingsGet, async () => {
    if (!host) throw new Error("host unavailable");
    const settings = await host.call("settings.get");
    return normalizeRetrySettings(normalizeSettings(settings));
  });

  handle(IPC.invoke.networkProxyTest, async (settings: unknown) => {
    return testNetworkProxy(settings);
  });

  handle(IPC.invoke.settingsSet, (settings: unknown) => queueSettingsWrite(async () => {
    const host = getHost();
    if (!host) throw new Error("host unavailable");
    const assertCurrentHost = () => {
      if (getHost() !== host) throw new Error("host changed during network setup");
    };
    if (settings && typeof settings === "object" && !Array.isArray(settings)) {
      const problem = providerRetrySettingsWriteError(settings);
      if (problem !== undefined) {
        throw Object.assign(new Error(problem), { errorCode: "INVALID_PARAMS" });
      }
    }
    const validatedSettings = validateSettingsWrite(settings);
    const currentSettings = await host.call<AppSettings>("settings.get");
    assertCurrentHost();
    const prospectiveSettings = validatedSettings && typeof validatedSettings === "object" && !Array.isArray(validatedSettings)
      ? { ...currentSettings, ...(validatedSettings as Partial<AppSettings>) }
      : currentSettings;
    const releaseSettingsWrite = liveCallService?.beginSettingsWrite(prospectiveSettings);
    let result: AppSettings;
    try {
      result = await host.call<AppSettings>("settings.set", validatedSettings);
      assertCurrentHost();
      await liveCallService?.settingsWritten(result);
      assertCurrentHost();
    } finally {
      releaseSettingsWrite?.();
    }
    const updatePreference = (validatedSettings as { updatePreference?: unknown })
      .updatePreference;
    if (updatePreference === "automatic" || updatePreference === "manual") {
      applyUpdatePreference(updatePreference);
    }
    if (typeof (validatedSettings as { keepAwakeWhileRunning?: unknown })
      .keepAwakeWhileRunning === "boolean") {
      applyKeepAwakeWhileRunning(validatedSettings as { keepAwakeWhileRunning: boolean });
    }
    if (typeof (validatedSettings as { preventScreenSleep?: unknown })
      .preventScreenSleep === "boolean") {
      applyPreventScreenSleep(validatedSettings as { preventScreenSleep: boolean });
    }
    // settings.set acknowledges a write; only the persisted merged snapshot
    // can preserve DNS/proxy preferences omitted by an unrelated partial save.
    const persistedSettings = await host.call<AppSettings>("settings.get");
    assertCurrentHost();
    await applyNetworkProxyFromAppSettings(persistedSettings);
    assertCurrentHost();
    const desktopDnsEnabled = currentNetworkDns().mode === "doh";
    const relayUrl = desktopDnsEnabled
      ? await ensureSystemProxyRelay()
      : currentSystemProxyRelayUrl();
    assertCurrentHost();
    if (relayUrl) {
      await host.call("network.configureSystemProxyRelay", {
        url: relayUrl,
        desktopDnsEnabled,
      });
      assertCurrentHost();
    }
    const sidecar = getSidecar();
    if (sidecar) {
      try {
        await sidecar.call("sidecar.configure", {
          hostBinary: host.binaryPath,
          dataDir,
          networkProxy: currentNetworkProxy(),
          systemProxyRelayUrl: relayUrl,
          desktopDnsEnabled,
        });
      } catch (error) {
        // A stopped sidecar is configured on spawn. Secure DNS cannot report
        // successful live application while its provider transport is unchanged.
        if (desktopDnsEnabled) throw error;
        console.warn("Sidecar network settings will be applied on its next start", error);
      }
      assertCurrentHost();
      if (getSidecar() !== sidecar) throw new Error("sidecar changed during network setup");
    }
    applyApplicationMenuSettings(
      validatedSettings as {
        language?: unknown;
        theme?: unknown;
        keybindings?: unknown;
        developerMode?: unknown;
        // A docked plugin view follows the saved type scale (D343), so the
        // Appearance write has to carry it to the host's view zoom.
        fontScale?: unknown;
      } | null,
    );
    applyDeveloperMode(validatedSettings as { developerMode?: unknown } | null);
    return result;
  }));

  handle(IPC.invoke.commandShellList, async () => resolveEffectiveCommandShell());
}
