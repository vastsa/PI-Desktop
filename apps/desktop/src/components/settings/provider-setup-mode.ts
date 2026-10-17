/** Whether the provider setup dialog is targeting a selected plugin-owned row. */
export function isPluginCatalogSetupForProvider(
  selection: { providerId: string } | null,
  provider: { id: string } | null,
): boolean {
  return selection !== null &&
    provider !== null &&
    selection.providerId === provider.id;
}
