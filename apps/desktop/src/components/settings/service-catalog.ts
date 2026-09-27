/**
 * The services a new AI service row can start from, and the search over them.
 *
 * Filtering never talks to the host. The haystack covers the localized label,
 * the preset's canonical name, id, vendor key, aliases, base URL and host, so
 * "kimi", "moonshot" and "api.moonshot.cn" all land on the same entry.
 */
import { AI_PLATFORM_API_STYLES, AI_PLATFORM_VENDOR_KEY, isAIPlatformProvider, NAMED_ENDPOINT_PRESETS, type NamedEndpointPreset, type ProviderPublic } from "@pi-desktop/shared";

export const CUSTOM_SERVICE = "custom";

type Translate = (key: string) => string;

export type ServiceOption = {
  id: string;
  label: string;
  /** Endpoint host shown under the label; empty for the custom endpoint. */
  host: string;
  haystack: string;
};

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function presetOption(preset: NamedEndpointPreset, translate: Translate): ServiceOption {
  const label = translate(preset.labelKey);
  const host = hostOf(preset.baseUrl);
  const aliases = preset.aliases?.join(" ") ?? "";
  return {
    id: preset.id,
    label,
    host,
    haystack:
      `${label} ${preset.name} ${preset.id} ${preset.vendorKey} ${aliases} ${preset.baseUrl} ${host}`.toLowerCase(),
  };
}

/** Only the platform endpoint is offered in this distribution. */
export function namedServiceOptions(translate: Translate): ServiceOption[] {
  return NAMED_ENDPOINT_PRESETS
    .filter((preset) => preset.id === AI_PLATFORM_VENDOR_KEY)
    .map((preset) => presetOption(preset, translate));
}

/** Any OpenAI- or Anthropic-compatible address the presets do not cover. */
export function customServiceOption(translate: Translate): ServiceOption {
  const label = translate("settings.presetCustomEndpoint");
  return {
    id: CUSTOM_SERVICE,
    label,
    host: "",
    haystack: `${label} custom endpoint`.toLowerCase(),
  };
}

/** Case-insensitive substring match; an empty query keeps every option. */
export function filterServiceOptions<T extends { haystack: string }>(
  options: readonly T[],
  query: string,
): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...options];
  return options.filter((option) => option.haystack.includes(needle));
}

/** Platform model transports; subscription-only adapters stay unreachable. */
export { AI_PLATFORM_API_STYLES as PLATFORM_API_STYLES } from "@pi-desktop/shared";

export function isPlatformApiStyle(style?: string): style is typeof AI_PLATFORM_API_STYLES[number] {
  return AI_PLATFORM_API_STYLES.some((allowed) => allowed === style);
}

/** Plugin and subscription rows cannot supply this distribution's API token. */
export function isPlatformProvider(provider: ProviderPublic): boolean {
  return isAIPlatformProvider(provider) && !provider.ownerPluginId && !provider.hasOauth;
}
