import { IPC } from "@pi-desktop/shared";
import type { HostProcess } from "./host-process";
import type { PluginRuntime } from "./plugin-runtime";

export type PluginThemeServiceWiring = {
  plugins: PluginRuntime;
  getHost: () => HostProcess | null;
  sendToRenderer: (channel: string, payload: unknown) => void;
  applyAppThemePreference: (theme: string) => void;
  broadcastAppearance: () => void;
};

/**
 * Wire `app.setTheme` / `themes.*` host reactions after the application
 * lifecycle exists (ADR 0260). Kept out of `index.ts` so that file stays
 * under the architecture LOC ceiling.
 */
export function wirePluginThemeRuntimeServices({
  plugins,
  getHost,
  sendToRenderer,
  applyAppThemePreference,
  broadcastAppearance,
}: PluginThemeServiceWiring): void {
  plugins.setServices({
    setThemePreference: async (theme: string) => {
      const host = getHost();
      if (!host) throw new Error("host unavailable");
      await host.call("settings.set", { theme });
      applyAppThemePreference(theme);
      sendToRenderer(IPC.event.settingsChanged, { theme });
    },
    onPluginThemesChanged: (pluginId: string) => {
      sendToRenderer(IPC.event.pluginChanged, { reason: "themes", pluginId });
      broadcastAppearance();
    },
  });
}
