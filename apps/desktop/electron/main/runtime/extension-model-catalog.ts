import {
  buildProviderModel, capabilitiesFromModelConfig, genericModelConfig,
  modelConfigWithBinding, publicExtensionModel, type TrustedExtensionHostModel,
} from "@pi-desktop/agent-runtime";
import { resolveBindingContextWindow } from "@pi-desktop/shared";
import { modelConfigFromModelsDev, type ModelsDevCatalog } from "../models-dev-catalog";
import type { RuntimeProvider } from "./provider-catalog";

/** Build a metadata-only catalog from host-owned rows; never resolve secrets here. */
export function extensionHostModels(
  providers: readonly RuntimeProvider[], catalog: Pick<ModelsDevCatalog, "findModel">,
): TrustedExtensionHostModel[] {
  return providers.filter((provider) => provider.enabled !== false).flatMap((provider) => {
    const bindings = provider.models?.length ? provider.models
      : provider.defaultModelId ? [{ id: provider.defaultModelId }] : [];
    return bindings.map(({ id }) => {
      const binding = provider.models?.find((row) => row.id === id);
      const known = catalog.findModel({ vendorKey: provider.vendorKey, baseUrl: provider.baseUrl, modelId: id });
      const resolved = resolveBindingContextWindow(known
        ? modelConfigFromModelsDev(known, provider.baseUrl)
        : genericModelConfig(id, provider.baseUrl ?? ""), binding);
      const modelConfig = modelConfigWithBinding(resolved.catalogConfig, resolved.binding);
      const capabilities = capabilitiesFromModelConfig(modelConfig);
      return {
        providerId: provider.id, providerName: provider.name,
        available: provider.authKind === "none" || provider.hasSecret === true || provider.hasOauth === true,
        model: publicExtensionModel(buildProviderModel({
          id: provider.id, name: provider.name, vendorKey: provider.vendorKey,
          baseUrl: provider.baseUrl, apiStyle: provider.apiStyle, modelId: id,
          apiKey: "", modelConfig, ...capabilities, supportedThinkingLevels: [...capabilities.supportedThinkingLevels],
        })),
      };
    });
  });
}
