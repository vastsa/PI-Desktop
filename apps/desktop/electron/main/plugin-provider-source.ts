import type { PluginManifest, PluginProviderInferenceBindingV1 } from "@pi-desktop/plugin-sdk";

/** Data projected by Host; never populated from adapter output. */
export type PluginProviderSourceRow = {
  id: string;
  ownerPluginId?: string;
  pluginTemplateId?: string;
  pluginTemplateVersion?: number;
};

export type AccountInferenceBinding = PluginProviderInferenceBindingV1 & {
  accountId?: string;
  templateId?: string;
};

/** Legacy declarations and templates share transport/capability resolution, not row identity. */
export function providerContribution(manifest: PluginManifest, row: PluginProviderSourceRow) {
  if (manifest.id !== row.ownerPluginId) return undefined;
  if (row.pluginTemplateId) {
    if (row.pluginTemplateVersion !== 1) return undefined;
    return manifest.contributes?.providerTemplates?.find(entry => entry.id === row.pluginTemplateId);
  }
  return manifest.contributes?.providers?.find(entry => `plugin:${manifest.id}:${entry.id}` === row.id);
}

export function pluginOAuthSourceMatches(
  row: PluginProviderSourceRow,
  source: { pluginId: string; providerId: string; templateId?: string },
): boolean {
  return source.pluginId === row.ownerPluginId && (source.templateId
    ? row.pluginTemplateVersion === 1 && row.pluginTemplateId === source.templateId
    : !row.pluginTemplateId && row.id === source.providerId);
}
