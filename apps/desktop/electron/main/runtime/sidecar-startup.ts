import type { NetworkProxySettings } from "@pi-desktop/shared";
import type { AgentSidecar } from "../agent-sidecar";
import type { RuntimeState } from "./context";

export type SidecarNetworkSettings = {
  networkProxy: NetworkProxySettings;
  systemProxyRelayUrl: string | null;
  desktopDnsEnabled: boolean;
};

/** Publish only a configured sidecar, never an unfinished or stale candidate. */
export async function activateSidecar(
  state: RuntimeState,
  sidecar: AgentSidecar,
  dataDir: string,
  getNetworkSettings: () => SidecarNetworkSettings,
  isQuitting: () => boolean = () => false,
): Promise<void> {
  const host = state.host;
  const previousSidecar = state.sidecar;
  try {
    if (isQuitting()) throw new Error("app shutting down during network setup");
    if (!host) throw new Error("host unavailable during network setup");
    sidecar.setHost(host);
    let network = getNetworkSettings();
    for (;;) {
      await sidecar.call("sidecar.configure", {
        hostBinary: host.binaryPath,
        dataDir,
        ...network,
      });
      if (isQuitting()) throw new Error("app shutting down during network setup");
      if (state.host !== host) throw new Error("host changed during network setup");
      if (state.sidecar !== previousSidecar) throw new Error("sidecar changed during network setup");
      const current = getNetworkSettings();
      // A settings write cannot configure this unpublished candidate. Catch up
      // before making it available, including after a sidecar-only restart.
      // Main replaces the normalized proxy object on every applied write.
      if (current.networkProxy !== network.networkProxy ||
          current.systemProxyRelayUrl !== network.systemProxyRelayUrl ||
          current.desktopDnsEnabled !== network.desktopDnsEnabled) {
        network = current;
        continue;
      }
      state.sidecar = sidecar;
      return;
    }
  } catch (error) {
    await sidecar.dispose();
    throw error;
  }
}
