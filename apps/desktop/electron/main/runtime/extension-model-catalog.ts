/**
 * Ready-model catalogue projection for the trusted-extension surface (plan S1).
 *
 * Main owns the provider rows, the credentials, and the models.dev-derived
 * `ModelConfig`; this module folds them into the redacted
 * `HostModelDescriptor` rows the agent sidecar receives. Readiness, the default
 * fallback order, and the label convention deliberately mirror
 * `listReadyPluginModels` (`plugin-agent-complete.ts`), so a sandboxed plugin
 * and a trusted extension see the same ready set for the same provider rows.
 *
 * Only the descriptor fields leave this module: never `apiKey`, provider
 * headers, secret references, or the raw provider `config_json`.
 */

import {
  modelIdsMatch,
  resolveBindingContextWindow,
  type ModelBinding,
  type ProviderPublic,
} from "@pi-desktop/shared";
import {
  capabilitiesFromModelConfig,
  genericModelConfig,
  modelConfigWithBinding,
  visionFromModelConfig,
  type HostModelDescriptor,
  type ModelConfig,
} from "@pi-desktop/agent-runtime";
import type { HostProcess } from "../host-process";
import {
  modelConfigFromModelsDev,
  type ModelsDevCatalog,
} from "../models-dev-catalog";

export type ExtensionModelCatalog = {
  listReadyModels(): Promise<HostModelDescriptor[]>;
};

export type ExtensionModelCatalogOptions = {
  getHost: () => Pick<HostProcess, "call"> | null;
  modelsDevCatalog: ModelsDevCatalog;
};

/** The two settings fields the default assignment depends on. */
type CatalogDefaults = {
  defaultProviderId?: string;
  defaultModelId?: string;
};

function hasCredential(provider: ProviderPublic): boolean {
  return (
    provider.hasSecret === true ||
    provider.hasOauth === true ||
    provider.authKind === "none"
  );
}

export function createExtensionModelCatalog(
  options: ExtensionModelCatalogOptions,
): ExtensionModelCatalog {
  const { getHost, modelsDevCatalog } = options;

  const bindingForModel = (
    provider: ProviderPublic,
    modelId: string,
  ): ModelBinding | undefined =>
    provider.models?.find((binding) => modelIdsMatch(binding.id, modelId));

  /**
   * The same precedence session launch uses: models.dev metadata is the
   * baseline, and the user's stored binding owns the effective thinking
   * capability, context window, and output limit for this endpoint.
   */
  const effectiveModelConfig = (
    provider: ProviderPublic,
    modelId: string,
  ): ModelConfig => {
    const modelsDevModel = modelsDevCatalog.findModel({
      vendorKey: provider.vendorKey,
      baseUrl: provider.baseUrl,
      modelId,
    });
    const resolved = resolveBindingContextWindow(
      modelsDevModel
        ? modelConfigFromModelsDev(modelsDevModel, provider.baseUrl)
        : genericModelConfig(modelId, provider.baseUrl ?? ""),
      bindingForModel(provider, modelId),
    );
    return modelConfigWithBinding(resolved.catalogConfig, resolved.binding);
  };

  const descriptorFor = (
    provider: ProviderPublic,
    binding: Pick<ModelBinding, "id" | "alias">,
    modelId: string,
    isDefault: boolean,
  ): HostModelDescriptor => {
    const modelConfig = effectiveModelConfig(provider, modelId);
    const capabilities = capabilitiesFromModelConfig(modelConfig);
    const alias = binding.alias?.trim();
    const modalities = modelConfig.modalities;
    const cost = modelConfig.cost;
    return {
      providerId: provider.id,
      providerName: provider.name,
      modelId,
      label: `${modelId} (${provider.name})`,
      ...(alias ? { alias } : {}),
      ...(provider.apiStyle ? { apiStyle: provider.apiStyle } : {}),
      ...(modelConfig.api ? { modelApi: modelConfig.api } : {}),
      baseUrl: provider.baseUrl ?? "",
      ...(isDefault ? { isDefault: true } : {}),
      supportsReasoning: capabilities.supportsReasoning,
      supportsImages: visionFromModelConfig(modelConfig),
      hasSecret: provider.hasSecret === true,
      hasOauth: provider.hasOauth === true,
      authKind: provider.authKind ?? "",
      toolCall: modelConfig.toolCall === true,
      thinkingLevels: [...capabilities.supportedThinkingLevels],
      contextWindow: modelConfig.contextWindow,
      maxTokens: modelConfig.maxTokens,
      ...(cost
        ? {
            cost: {
              input: cost.input,
              output: cost.output,
              cacheRead: cost.cacheRead,
              cacheWrite: cost.cacheWrite,
            },
          }
        : {}),
      ...(modalities
        ? {
            modalities: {
              input: [...modalities.input],
              output: [...modalities.output],
            },
          }
        : {}),
    };
  };

  const listReadyModels = async (): Promise<HostModelDescriptor[]> => {
    const host = getHost();
    if (!host) throw new Error("host unavailable");
    // The default assignment needs the two settings fields only; an
    // unreadable settings row simply leaves the default unassigned.
    const loadDefaults = async (): Promise<CatalogDefaults> => {
      try {
        return await host.call<CatalogDefaults>("settings.get");
      } catch {
        return {};
      }
    };
    const [listed, defaults] = await Promise.all([
      // The readiness rule is `enabled !== false && has credential`.
      host.call<{ providers: ProviderPublic[] }>("providers.list", {
        includeDisabled: false,
      }),
      loadDefaults(),
    ]);
    // findModel() reads the catalog, so it must be loaded before any lookup.
    await modelsDevCatalog.ensureLoaded();
    const enabled = (listed.providers ?? []).filter(
      (provider) => provider.enabled !== false,
    );
    // Match the session-launch fallback order without advertising a default
    // the catalogue cannot actually reach.
    const defaultProvider =
      enabled.find((provider) => provider.id === defaults.defaultProviderId) ??
      enabled.find(hasCredential) ??
      enabled[0];
    const defaultModelId =
      (defaultProvider?.id === defaults.defaultProviderId
        ? defaults.defaultModelId
        : undefined) ||
      defaultProvider?.models?.[0]?.id ||
      defaultProvider?.defaultModelId;
    let defaultAssigned = false;
    const models: HostModelDescriptor[] = [];
    for (const provider of enabled) {
      if (!hasCredential(provider)) continue;
      const bindings: Array<Pick<ModelBinding, "id" | "alias">> =
        provider.models?.length
          ? provider.models
          : provider.defaultModelId
            ? [{ id: provider.defaultModelId }]
            : [];
      const seen = new Set<string>();
      for (const binding of bindings) {
        const modelId = String(binding.id ?? "").trim();
        // A row may repeat a binding; one descriptor per `provider/id` is the
        // unit the registry deduplicates by anyway.
        if (!modelId || seen.has(modelId)) continue;
        seen.add(modelId);
        const isDefault =
          !defaultAssigned &&
          provider.id === defaultProvider?.id &&
          modelId === defaultModelId;
        if (isDefault) defaultAssigned = true;
        models.push(descriptorFor(provider, binding, modelId, isDefault));
      }
    }
    return models;
  };

  return { listReadyModels };
}
