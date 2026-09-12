export type CatalogRuntime = {
  beginProviderRefresh: () => number;
  providerGeneration: () => number;
  refreshedProviderModels: Set<string>;
  providerModelLoads: Map<string, Promise<void>>;
  getPluginRefresh: () => Promise<void> | null;
  setPluginRefresh: (request: Promise<void> | null) => void;
};

/** Coalesces catalog reads without putting mutable request state in the store. */
export function createCatalogRuntime(): CatalogRuntime {
  let providerModelsGeneration = 0;
  let pluginRefreshInFlight: Promise<void> | null = null;
  const refreshedProviderModels = new Set<string>();
  const providerModelLoads = new Map<string, Promise<void>>();

  return {
    beginProviderRefresh: () => {
      providerModelsGeneration += 1;
      refreshedProviderModels.clear();
      return providerModelsGeneration;
    },
    providerGeneration: () => providerModelsGeneration,
    refreshedProviderModels,
    providerModelLoads,
    getPluginRefresh: () => pluginRefreshInFlight,
    setPluginRefresh: (request) => {
      pluginRefreshInFlight = request;
    },
  };
}
