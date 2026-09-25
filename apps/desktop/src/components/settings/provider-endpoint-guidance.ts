/**
 * The settings dialog's view of endpoint resolution.
 *
 * All of the rules live in `@pi-desktop/shared/provider-endpoint`; this module
 * is the thin adapter the form uses, so the dialog and the Electron main process
 * cannot answer "which address will this row use?" differently.
 */
import {
  canonicalEndpointUrl,
  inferEndpointProfile,
  matchEndpointOperation,
  parseEndpointInput,
  type CatalogApiStyle,
} from "@pi-desktop/shared";

/**
 * Whether a typed Base URL can be addressed at all.
 *
 * A bare host is valid input: `api.example.com` is completed with `https://`
 * inside the origin the user named, which is input normalization rather than a
 * cross-origin guess. Credentials, query strings and fragments stay refused —
 * a Base URL never carries them.
 */
export function getBaseUrlIssue(value: string): "invalid" | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  return parseEndpointInput(trimmed) ? null : "invalid";
}

export type EndpointDraft = {
  /** The address this row will really use. */
  effectiveBaseUrl: string;
  /** The wire format the endpoint evidence implies. */
  apiStyle: CatalogApiStyle;
  /**
   * True when the endpoint itself decided the format, so the form may say so.
   * False when the value is the generic fallback and nothing was inferred.
   */
  autoDetected: boolean;
  /** `explicit`, `url_suffix`, `known_endpoint`, … — the strongest claim, for display. */
  evidence?: string;
};

/**
 * Resolve a typed Base URL for the form.
 *
 * `apiStyle` is the format currently selected in the form and `explicit` says
 * whether the user chose it. An explicit pick always wins: the endpoint may
 * never quietly change a format the user selected.
 */
export function resolveEndpointDraft(
  value: string,
  apiStyle: CatalogApiStyle,
  explicit: boolean,
): EndpointDraft {
  const profile = inferEndpointProfile({
    baseUrl: value,
    apiStyle,
    explicitApiStyle: explicit,
  });
  if (!profile) return { effectiveBaseUrl: value.trim(), apiStyle, autoDetected: false };
  const strongest = profile.evidence.at(-1);
  const inferred = strongest !== undefined && strongest.type !== "fallback";
  return {
    effectiveBaseUrl: profile.effectiveBaseUrl,
    // An explicit pick, or a format some piece of evidence actually names,
    // replaces the current value. The bare `chat_completions` fallback is not an
    // inference: it must not overwrite a persisted style the user never touched.
    apiStyle: explicit || inferred ? profile.apiStyle : apiStyle,
    autoDetected: !explicit && inferred,
    ...(strongest ? { evidence: strongest.type } : {}),
  };
}

/**
 * URL evidence is a suggestion, never a successful capability probe.
 *
 * Only a pasted operation URL whose format contradicts the selected one is
 * offered: the endpoint's base address plus the format that suffix names.
 */
export function endpointSuggestion(
  value: string,
  current: CatalogApiStyle,
): { baseUrl: string; apiStyle: CatalogApiStyle } | undefined {
  const trimmed = value.trim();
  if (!trimmed || getBaseUrlIssue(trimmed)) return undefined;
  const parsed = parseEndpointInput(trimmed);
  if (!parsed) return undefined;
  const operation = matchEndpointOperation(parsed.pathname);
  if (!operation?.apiStyle) return undefined;
  // The suffix belongs to the selected format, so the form is already right.
  const asSelected = resolveEndpointDraft(trimmed, current, true);
  if (asSelected.effectiveBaseUrl !== parsed.normalizedInput) return undefined;
  const resolved = inferEndpointProfile({ baseUrl: trimmed });
  return {
    baseUrl: resolved?.effectiveBaseUrl ?? parsed.normalizedInput,
    apiStyle: operation.apiStyle,
  };
}

/**
 * Strip only operations belonging to the selected protocol.
 *
 * A pasted operation of another format is left in place: it describes a
 * mismatch the user has to resolve, and silently retargeting the row would be a
 * hidden rewrite of what they typed.
 */
export function normalizeBaseUrlInput(value: string, apiStyle: CatalogApiStyle): string {
  const trimmed = value.trim();
  if (!trimmed || getBaseUrlIssue(trimmed)) return trimmed;
  const profile = inferEndpointProfile({
    baseUrl: trimmed,
    apiStyle,
    explicitApiStyle: true,
  });
  return profile ? profile.effectiveBaseUrl : trimmed;
}

/** Whether two typed addresses name the same endpoint. */
export function endpointsEqual(left: string, right: string): boolean {
  return canonicalEndpointUrl(left) === canonicalEndpointUrl(right);
}
