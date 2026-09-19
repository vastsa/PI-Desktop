import {
  capabilitiesFromModelConfig, extensionModelError, genericModelConfig,
  modelConfigWithBinding, optionalProviderHeaders, type RuntimeProviderConfig,
} from "@pi-desktop/agent-runtime";
import { OAUTH_AUTH_KIND, resolveBindingContextWindow } from "@pi-desktop/shared";
import { modelConfigFromModelsDev, type ModelsDevCatalog } from "../models-dev-catalog";
import type { VendorOAuth } from "../oauth";
import type { RuntimeProvider } from "./provider-catalog";

export type ExtensionProviderDependencies = {
  listProviders(): Promise<RuntimeProvider[]>;
  getSecret(providerId: string): Promise<string | undefined>;
  catalog: Pick<ModelsDevCatalog, "ensureLoaded" | "findModel">;
  oauth: Pick<VendorOAuth, "bindingFor" | "resolveAuth">;
};

/** Strict selection, unlike a session launch: a missing target never falls back. */
export async function resolveExtensionModelProvider(
  deps: ExtensionProviderDependencies, providerId: string, modelId: string,
): Promise<RuntimeProviderConfig> {
  const provider = (await deps.listProviders()).find((row) => row.id === providerId && row.enabled !== false);
  const binding = provider?.models?.find((row) => row.id === modelId);
  if (!provider || (!binding && (provider.models?.length || provider.defaultModelId !== modelId))) {
    throw extensionModelError("MODEL_NOT_CONFIGURED", "The requested provider/model is unavailable");
  }
  const oauth = provider.authKind === OAUTH_AUTH_KIND;
  const vendorBinding = oauth ? await deps.oauth.bindingFor(providerId, modelId) : undefined;
  if (oauth && !vendorBinding) throw extensionModelError("MODEL_NOT_CONFIGURED", "The account does not offer this model");
  const apiKey = oauth || provider.authKind === "none" ? "" : await deps.getSecret(providerId);
  if (!oauth && provider.authKind !== "none" && !apiKey) {
    throw extensionModelError("PROVIDER_SECRET_MISSING", "The provider has no credential");
  }
  await deps.catalog.ensureLoaded();
  const baseUrl = vendorBinding?.baseUrl ?? provider.baseUrl;
  const known = deps.catalog.findModel({ vendorKey: provider.vendorKey, baseUrl, modelId });
  const config = vendorBinding?.modelConfig ?? (known
    ? modelConfigFromModelsDev(known, baseUrl) : genericModelConfig(modelId, baseUrl ?? ""));
  const resolved = resolveBindingContextWindow(config, binding);
  const modelConfig = modelConfigWithBinding(resolved.catalogConfig, resolved.binding);
  const capabilities = capabilitiesFromModelConfig(modelConfig);
  return {
    id: providerId, name: provider.name, vendorKey: provider.vendorKey, modelId,
    baseUrl, apiStyle: vendorBinding?.apiStyle ?? provider.apiStyle,
    authKind: provider.authKind, apiKey: apiKey ?? "", modelConfig,
    ...capabilities, supportedThinkingLevels: [...capabilities.supportedThinkingLevels], ...optionalProviderHeaders(provider.headers),
    ...(oauth ? { resolveAuth: () => deps.oauth.resolveAuth(providerId) } : {}),
  };
}
