import { API_STYLES, matchNamedPreset, normalizeApiStyle, OAUTH_AUTH_KIND, type CatalogApiStyle, type ModelBinding, type ProviderPublic } from "@pi-desktop/shared";

/** A creation draft cannot identify a stored provider or reuse its credentials. */
export type ProviderCopyDraft = {
  name: string;
  baseUrl: string;
  apiStyle: CatalogApiStyle;
  models: ModelBinding[];
};

export function copyProviderConfiguration(provider: ProviderPublic, name: string): ProviderCopyDraft {
  if (provider.authKind === OAUTH_AUTH_KIND) throw new Error("Vendor accounts cannot be copied as API-key services");
  let baseUrl = provider.baseUrl ?? "";
  try {
    const url = new URL(baseUrl);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) baseUrl = "";
  } catch {
    baseUrl = "";
  }
  return {
    name,
    baseUrl,
    apiStyle: API_STYLES.some((style) => style === provider.apiStyle)
      ? normalizeApiStyle(provider.apiStyle)
      : matchNamedPreset({ vendorKey: provider.vendorKey, baseUrl: provider.baseUrl, apiStyle: provider.apiStyle })?.apiStyle
        ?? normalizeApiStyle(provider.apiStyle),
    // Explicit fields also keep unknown nested metadata out of the draft.
    models: provider.models.map((model) => ({
      id: model.id,
      ...(model.alias !== undefined ? { alias: model.alias } : {}),
      contextWindow: model.contextWindow,
      // Provenance travels with the value, so a copied catalog window keeps
      // following models.dev and a copied override stays the user's.
      ...(model.contextWindowSource !== undefined
        ? { contextWindowSource: model.contextWindowSource }
        : {}),
      maxTokens: model.maxTokens,
      ...(model.maxTokensSource !== undefined
        ? { maxTokensSource: model.maxTokensSource }
        : {}),
      thinkingLevels: [...model.thinkingLevels],
      defaultThinkingLevel: model.defaultThinkingLevel,
      ...(model.supportsImages !== undefined ? { supportsImages: model.supportsImages } : {}),
      ...(model.supportsDocuments !== undefined ? { supportsDocuments: model.supportsDocuments } : {}),
      ...(model.availableForSubagents !== undefined ? { availableForSubagents: model.availableForSubagents } : {}),
      ...(model.nativeWebSearch !== undefined ? { nativeWebSearch: model.nativeWebSearch } : {}),
    })),
  };
}
