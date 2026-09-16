import type { HostProcess } from "./host-process";

/**
 * Tell the host which language the app is displaying, so plugin rows resolve
 * their labels in it.
 *
 * A plugin ships its display strings per locale (`manifest.i18n`, and the same
 * block on a marketplace catalog entry) and the host picks the entry that
 * matches the app language. The host keeps that language itself because rows
 * are read long after a request was answered, and because no plugin RPC carries
 * a locale.
 *
 * A failure is deliberately swallowed: the host then falls back to English,
 * which is the source language of the plugin contract, and no language change
 * may turn a settings write into an error.
 */
export async function syncPluginDisplayLocale(
  host: HostProcess | null,
  locale: string,
): Promise<void> {
  if (!host) return;
  try {
    await host.call("plugins.setLocale", { locale });
  } catch {
    // A host that predates this RPC keeps its English labels.
  }
}
