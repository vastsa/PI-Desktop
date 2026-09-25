/**
 * The services a new AI service row can start from, and the search over them.
 *
 * Filtering never talks to the host. The haystack covers the localized label,
 * the preset's canonical name, id, vendor key, aliases, base URL and host, so
 * "kimi", "moonshot" and "api.moonshot.cn" all land on the same entry.
 */
import { NAMED_ENDPOINT_PRESETS, type NamedEndpointPreset } from "@pi-desktop/shared";

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

/** Every named endpoint preset, in the order the shared table lists them. */
export function namedServiceOptions(translate: Translate): ServiceOption[] {
  return NAMED_ENDPOINT_PRESETS.map((preset) => presetOption(preset, translate));
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
