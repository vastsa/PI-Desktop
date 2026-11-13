export function subscribePluginCatalogRefresh(
  subscribe: (listener: () => void) => () => void,
  refreshPlugins: () => Promise<void>,
): () => void {
  const refresh = () => {
    void refreshPlugins().catch((error: unknown) => {
      // Plugin teardown can notify after the host has stopped. Background
      // refreshes must remain observable without rejecting the renderer turn.
      console.warn("[plugins] Background catalog refresh failed", error);
    });
  };
  refresh();
  return subscribe(refresh);
}
