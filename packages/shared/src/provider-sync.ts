/**
 * Which local providers may be copied to a remote host (D628). The renderer
 * offers exactly these, and Electron main re-checks the chosen ids with the
 * same rule before a key leaves the machine.
 */
import type { ProviderPublic } from "./types/providers.js";

/** Most providers one sync may carry; pi-host enforces the same cap. */
export const PROVIDER_SYNC_MAX_PROVIDERS = 64;

/**
 * OAuth logins are bound to this machine, plugin rows are recreated by their
 * plugin, and a keyless row that needs a key would only move the failure to
 * the host.
 */
export function isSyncableProvider(
  provider: Pick<ProviderPublic, "enabled" | "ownerPluginId" | "hasOauth" | "authKind" | "hasSecret">,
): boolean {
  if (!provider.enabled || provider.ownerPluginId) return false;
  if (provider.hasOauth || provider.authKind === "oauth") return false;
  return provider.hasSecret || provider.authKind === "none";
}
