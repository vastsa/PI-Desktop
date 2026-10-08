/**
 * The services a new AI service row can start from, and the search over them.
 *
 * Filtering never talks to the host. The haystack covers the localized label,
 * the preset's canonical name, id, vendor key, aliases, base URL and host, so
 * "kimi", "moonshot" and "api.moonshot.cn" all land on the same entry.
 */
import {
  NAMED_ENDPOINT_PRESETS,
  TYPESAFE_SYSTEM_ONE_URL,
  type PluginProviderCatalogMeta,
  type ProviderPublic,
  type NamedEndpointPreset,
} from "@pi-desktop/shared";

/**
 * Jev is offered where a service is added, not where a provider is edited: it
 * owns no provider row and no model list, so it is never a target of "change
 * the service on this row".
 */
export const JEV_SERVICE = "jev";

export const CUSTOM_SERVICE = "custom";

type Translate = (key: string) => string;

export type ServiceOption = {
  id: string;
  label: string;
  /** Endpoint host and path shown under the label; empty for the custom endpoint. */
  endpoint: string;
  haystack: string;
};

/** A declared API-key provider shown in the plugin's Add Service category. */
export type PluginProviderServiceOption = ServiceOption & {
  category: string;
  pluginName: string;
  description: string;
};

export function endpointLabel(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.host + parsed.pathname.replace(/\/+$/, "");
  } catch {
    return url;
  }
}

function presetOption(preset: NamedEndpointPreset, translate: Translate): ServiceOption {
  const label = translate(preset.labelKey);
  const endpoint = endpointLabel(preset.baseUrl);
  const aliases = preset.aliases?.join(" ") ?? "";
  return {
    id: preset.id,
    label,
    endpoint,
    haystack:
      `${label} ${preset.name} ${preset.id} ${preset.vendorKey} ${aliases} ${preset.baseUrl} ${endpoint}`.toLowerCase(),
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
    endpoint: "",
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

/**
 * TypeSafe Jev, the classifier on the add path. Its detail line names the
 * address the key is spent on, because there is no model list to describe.
 */
export function jevServiceOption(translate: Translate): ServiceOption {
  const label = translate("settings.jevTitle");
  const endpoint = endpointLabel(TYPESAFE_SYSTEM_ONE_URL);
  return {
    id: JEV_SERVICE,
    label,
    endpoint,
    haystack:
      `${label} jev typesafe classifier ${endpoint} ${TYPESAFE_SYSTEM_ONE_URL}`.toLowerCase(),
  };
}

/**
 * Resolve catalog declarations to their Host-owned provider rows. Rows with a
 * stored key are already configured and stay in the provider list rather than
 * being offered as a second add action.
 */
export function pluginProviderServiceOptions(
  declarations: readonly PluginProviderCatalogMeta[],
  providers: readonly ProviderPublic[],
): PluginProviderServiceOption[] {
  const rowsById = new Map(providers.map((provider) => [provider.id, provider]));
  return declarations.flatMap((declaration) => {
    const provider = rowsById.get(declaration.providerId);
    if (
      !provider ||
      provider.ownerPluginId !== declaration.pluginId ||
      !provider.enabled ||
      provider.authKind !== "api_key" ||
      provider.hasSecret ||
      !provider.baseUrl
    ) {
      return [];
    }
    const endpoint = endpointLabel(provider.baseUrl);
    const models = provider.models.map((model) => `${model.id} ${model.alias ?? ""}`).join(" ");
    return [{
      id: provider.id,
      label: provider.name,
      endpoint: `${endpoint} · ${declaration.pluginName}`,
      category: declaration.category.trim() || declaration.pluginName,
      pluginName: declaration.pluginName,
      description: declaration.description ?? "",
      haystack: [
        provider.name,
        provider.id,
        provider.baseUrl,
        endpoint,
        declaration.category,
        declaration.pluginName,
        declaration.description ?? "",
        models,
      ].join(" ").toLowerCase(),
    }];
  }).sort((a, b) =>
    a.category.localeCompare(b.category) ||
    a.label.localeCompare(b.label) ||
    a.pluginName.localeCompare(b.pluginName),
  );
}
