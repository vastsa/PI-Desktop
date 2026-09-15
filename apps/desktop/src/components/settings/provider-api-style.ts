import {
  API_STYLES,
  OPENCODE_GO_API_STYLE,
  matchNamedPreset,
  type CatalogApiStyle,
  type ProviderPublic,
} from "@pi-desktop/shared";

export function isAccountOnlyApiStyle(style?: string): boolean {
  return style === "openai_codex_responses" || style === "pi_messages";
}

/** The transport vocabulary also contains account-only and named-service APIs. */
export const CUSTOM_PROVIDER_API_STYLES = API_STYLES.filter(
  (style) => !isAccountOnlyApiStyle(style) && style !== OPENCODE_GO_API_STYLE,
);

export function needsCustomApiStyleChoice(
  style: CatalogApiStyle,
  savedStyle?: string,
): boolean {
  // Editing may retain a legacy value; creation/copy must explicitly choose.
  return isAccountOnlyApiStyle(style) && style !== savedStyle;
}

export function providerSetupPreset(provider?: ProviderPublic | null) {
  if (!provider || isAccountOnlyApiStyle(provider.apiStyle)) return undefined;
  return matchNamedPreset({
    vendorKey: provider.vendorKey,
    baseUrl: provider.baseUrl,
    apiStyle: provider.apiStyle,
  });
}
