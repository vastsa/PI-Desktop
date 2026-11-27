import {
  configuredChatModels,
  imageGenerationBindings,
  isChatProviderReady,
  trustedExtensionAgentKeyFromProviderId,
  type AppSettings,
  type LanModelOption,
  type ModelInfo,
  type ProviderPublic,
} from "@pi-desktop/shared";
import type { LanHost } from "./workspace";

export type ReadCachedModels = (providerId: string) => Promise<readonly ModelInfo[]>;
type CatalogProvider = Pick<ProviderPublic, "id" | "name" | "enabled" | "hasSecret" | "authKind" | "models" | "defaultModelId">;

/** Project only saved Composer choices. No remote discovery or credential reads. */
export async function readLanModelOptions(
  host: LanHost,
  readCachedModels: ReadCachedModels,
  providerId?: string,
): Promise<LanModelOption[]> {
  const [{ providers }, settings] = await Promise.all([
    host.call<{ providers: CatalogProvider[] }>("providers.list", { includeDisabled: false }),
    host.call<Pick<AppSettings, "imageGenerationModels" | "imageGeneration">>("settings.get"),
  ]);
  const imageGeneration = imageGenerationBindings(settings.imageGenerationModels, settings.imageGeneration);
  const items: LanModelOption[] = [];
  for (const provider of providers) {
    if ((providerId !== undefined && provider.id !== providerId) ||
      !isChatProviderReady(provider) || trustedExtensionAgentKeyFromProviderId(provider.id)) continue;
    const cache = await readCachedModels(provider.id);
    for (const { modelId, binding } of configuredChatModels(provider, cache, imageGeneration)) {
      items.push({
        providerId: provider.id,
        modelId,
        label: binding?.alias?.trim() || modelId,
        providerLabel: provider.name,
      });
    }
  }
  return items;
}
