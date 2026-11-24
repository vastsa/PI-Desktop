import { IPC } from "@pi-desktop/shared";

/** Capabilities shipped in the Pie Code desktop edition. */
export const desktopFeatures = {
  onlineServices: false,
  voice: false,
  scheduledTasks: false,
  computerUse: false,
};

const onlineChannels = new Set<string>([
  IPC.invoke.mcpMarketSearch,
  IPC.invoke.skillMarketSearch,
  IPC.invoke.skillMarketFetch,
  IPC.invoke.pluginLauncherOpenMarket,
  IPC.invoke.pluginSetAutoUpdate,
  IPC.invoke.providersOauthStart,
  IPC.invoke.providersOauthRespond,
  IPC.invoke.jevTest,
  IPC.invoke.networkProxyTest,
]);

export function desktopChannelEnabled(channel: string): boolean {
  if (!desktopFeatures.onlineServices &&
    (channel.startsWith("pi-desktop/market/") || onlineChannels.has(channel))) return false;
  if (!desktopFeatures.voice &&
    (channel.startsWith("pi-desktop/voice/") || channel.startsWith("pi-desktop/speech/"))) return false;
  if (!desktopFeatures.scheduledTasks && channel.startsWith("pi-desktop/scheduled/")) return false;
  if (!desktopFeatures.computerUse && channel.startsWith("pi-desktop/computer/")) return false;
  return true;
}
