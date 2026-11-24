import {
  API_STYLES,
  OPENCODE_GO_API_STYLE,
  canonicalEndpointUrl,
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

/** Localized names for every transport in the catalog. */
export const API_STYLE_LABEL_KEYS: Record<CatalogApiStyle, string> = {
  chat_completions: "settings.apiStyleChatCompletions",
  responses: "settings.apiStyleResponses",
  anthropic_messages: "settings.apiStyleAnthropic",
  google_generative_ai: "settings.apiStyleGoogle",
  openai_codex_responses: "settings.apiStyleCodexResponses",
  pi_messages: "settings.apiStylePiMessages",
  opencode_go: "settings.apiStyleOpenCodeGo",
};

export function needsCustomApiStyleChoice(
  style: CatalogApiStyle,
  savedStyle?: string,
): boolean {
  // Editing may retain a legacy value; creation/copy must explicitly choose.
  return isAccountOnlyApiStyle(style) && style !== savedStyle;
}

export function providerSetupPreset(provider?: ProviderPublic | null) {
  if (!provider || provider.vendorKey === "custom" || isAccountOnlyApiStyle(provider.apiStyle)) return undefined;
  const preset = matchNamedPreset({
    vendorKey: provider.vendorKey,
    baseUrl: provider.baseUrl,
    apiStyle: provider.apiStyle,
  });
  // A persisted label must not retarget a custom address to a public preset.
  if (!preset || canonicalEndpointUrl(provider.baseUrl) !== canonicalEndpointUrl(preset.baseUrl)) return undefined;
  return provider.apiStyle && preset.apiStyle !== provider.apiStyle ? undefined : preset;
}
