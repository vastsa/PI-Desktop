import type { ProviderPublic } from "./types/providers.js";

/** Read-only Host capabilities constrain custom adapters, never ordinary transports. */
export function providerModelSupportsChat(
  provider: Pick<ProviderPublic, "ownerPluginId" | "pluginModelOperations">,
  modelId: string,
): boolean {
  return !provider.ownerPluginId || !provider.pluginModelOperations ||
    provider.pluginModelOperations[modelId]?.includes("chat") === true;
}
