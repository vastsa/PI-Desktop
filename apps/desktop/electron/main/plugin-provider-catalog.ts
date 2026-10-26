import { bindingForCustomModel, type PluginProviderCatalogMeta } from "@pi-desktop/shared";
import {
  resolvePluginLocalizedString,
  type PluginManifest,
} from "@pi-desktop/plugin-sdk";

type PluginProviderCatalogSource = {
  manifest: PluginManifest;
  permissions: ReadonlySet<string>;
};

/** Resolve the static Add Service entries declared by currently loaded plugins. */
export function pluginProviderCatalogEntries(
  plugins: readonly PluginProviderCatalogSource[],
  locale: string,
): PluginProviderCatalogMeta[] {
  const entries: PluginProviderCatalogMeta[] = [];
  for (const plugin of plugins) {
    if (!plugin.permissions.has("provider.register")) continue;
    const providers = plugin.manifest.contributes?.providers ?? [];
    for (const provider of providers) {
      if ((provider.authKind ?? "api_key") !== "api_key" || !provider.baseUrl) continue;
      entries.push({
        pluginId: plugin.manifest.id,
        providerId: `plugin:${plugin.manifest.id}:${provider.id}`,
        pluginName: plugin.manifest.name,
        category: resolvePluginLocalizedString(
          provider.category,
          locale,
          plugin.manifest.name,
        ),
        ...(provider.description
          ? { description: resolvePluginLocalizedString(provider.description, locale, "") }
          : {}),
      });
    }
    for (const template of plugin.manifest.contributes?.providerTemplates ?? []) {
      if (template.authKind === "oauth") continue;
      entries.push({
        pluginId: plugin.manifest.id,
        providerId: `plugin-template:${plugin.manifest.id}:${template.id}`,
        templateId: template.id,
        pluginName: plugin.manifest.name,
        name: template.name,
        authKind: template.authKind ?? "api_key",
        baseUrl: template.baseUrl,
        apiStyle: template.apiStyle,
        models: (template.models ?? []).map(model => ({ ...bindingForCustomModel(model.id),
          ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
          ...(model.maxTokens ? { maxTokens: model.maxTokens } : {}),
        })),
        category: resolvePluginLocalizedString(template.category, locale, plugin.manifest.name),
        description: resolvePluginLocalizedString(template.description, locale, ""),
      });
    }
  }
  return entries.sort(
    (a, b) =>
      a.category.localeCompare(b.category) ||
      a.pluginName.localeCompare(b.pluginName) ||
      a.providerId.localeCompare(b.providerId),
  );
}
