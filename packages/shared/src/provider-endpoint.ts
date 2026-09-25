/**
 * Endpoint resolution for the provider setup flow.
 *
 * A user types a Base URL, but the questions that follow from it are four
 * different ones: which URL is actually addressed, what wire format the service
 * speaks, how a model-list probe should ask, and why any of that was decided.
 * This module answers all four from static evidence only — it performs no I/O —
 * so the settings dialog, the Electron main process and the tests share one
 * implementation instead of re-deriving the rules per surface.
 *
 * Two rules hold everywhere here:
 *
 * - The endpoint decides the protocol, never the model id. A gateway can serve
 *   `gpt-*`, `claude-*` and `gemini-*` behind a single Chat Completions route,
 *   so a model name may not change the wire style.
 * - Nothing automatic may leave the origin the user typed, because the probe
 *   carries the user's API key. Cross-origin candidates are dropped rather than
 *   probed.
 */

import type { CatalogApiStyle } from "./model-catalog.js";
import { NAMED_ENDPOINT_PRESETS } from "./provider-presets.js";

/**
 * How a model-list probe asks a service what it serves.
 *
 * This is deliberately narrower than {@link CatalogApiStyle}: a successful
 * `GET {base}/models` with `Authorization: Bearer` proves the endpoint answers
 * OpenAI-compatible discovery, and nothing about whether the generation call is
 * `/chat/completions`, `/responses` or something else.
 */
export type DiscoveryStyle = "openai_models" | "anthropic_models" | "google_models";

/** Where a resolved value came from, strongest first in the confidence table. */
export type EndpointEvidenceType =
  | "explicit"
  | "url_suffix"
  | "known_endpoint"
  | "known_host"
  | "provider_metadata"
  | "discovery"
  | "catalog_model"
  | "fallback";

/**
 * Confidence per evidence type. The order is the resolution order: a weaker
 * source never replaces a stronger one.
 */
export const ENDPOINT_EVIDENCE_CONFIDENCE: Readonly<Record<EndpointEvidenceType, number>> = {
  explicit: 100,
  url_suffix: 95,
  known_endpoint: 90,
  known_host: 85,
  provider_metadata: 80,
  discovery: 75,
  // Reserved for a model-metadata hint. The static resolver never emits it: a
  // model id is not allowed to decide the wire protocol, so this rank exists
  // only so a future layer cannot rank such a hint above real endpoint facts.
  catalog_model: 40,
  fallback: 0,
};

export interface EndpointEvidence {
  type: EndpointEvidenceType;
  confidence: number;
  detail?: string;
}

/** One base URL worth probing, with the discovery style it should be asked in. */
export interface EndpointCandidate {
  baseUrl: string;
  discoveryStyle: DiscoveryStyle;
  apiStyleHint?: CatalogApiStyle;
  evidence: EndpointEvidence;
}

export interface EndpointProfile {
  input: string;
  normalizedInput: string;

  origin: string;
  effectiveBaseUrl: string;

  apiStyle: CatalogApiStyle;
  discoveryStyle?: DiscoveryStyle;

  providerKey?: string;

  evidence: EndpointEvidence[];

  candidates: EndpointCandidate[];
}

/** One published provider endpoint, the shared home for what used to be scattered tables. */
export interface ProviderEndpointDefinition {
  providerKey: string;

  hosts?: string[];
  baseUrls?: string[];

  apiStyle?: CatalogApiStyle;
  discoveryStyle?: DiscoveryStyle;

  /** Documented path suffixes for this provider's endpoints. */
  paths?: string[];

  /** models.dev adapter package, when the provider publishes one. */
  npm?: string;
}

export const MAX_DISCOVERY_CANDIDATES = 4;

/** Wire style a discovery probe asks in, mirroring the transport adapter list. */
export function discoveryStyleForApiStyle(apiStyle?: string | null): DiscoveryStyle {
  if (apiStyle === "anthropic_messages") return "anthropic_models";
  if (apiStyle === "google_generative_ai") return "google_models";
  // `pi_messages`, `opencode_go`, `openai_codex_responses` and every
  // OpenAI-compatible style authenticate a model list the same way.
  return "openai_models";
}

/**
 * The URL a discovery probe addresses for one candidate.
 *
 * `modelListRequest` builds its request from this, so a candidate list and the
 * request it produces can never drift apart.
 */
export function discoveryProbeUrl(baseUrl: string, discoveryStyle: DiscoveryStyle): string {
  const base = baseUrl.trim().replace(/\/+$/, "");
  if (discoveryStyle === "anthropic_models") {
    // Anthropic base URLs conventionally exclude /v1; the endpoint appends it.
    return `${base.endsWith("/v1") ? base : `${base}/v1`}/models`;
  }
  return `${base}/models`;
}

function hostOf(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return undefined;
  }
}

function pathOf(value: string): string | undefined {
  try {
    const pathname = new URL(value).pathname.replace(/\/+$/, "");
    return pathname && pathname !== "/" ? pathname : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Unified endpoint registry.
 *
 * The named presets are the canonical table for first-class services, so the
 * registry is derived from them instead of restating their hosts and paths. A
 * preset's `baseUrl` already carries the provider's special path (`/v1beta`,
 * `/compatible-mode/v1`, `/api/paas/v4`), which is exactly why only registry
 * facts — never a generic heuristic — may produce those paths as candidates.
 */
export const PROVIDER_ENDPOINT_DEFINITIONS: readonly ProviderEndpointDefinition[] =
  NAMED_ENDPOINT_PRESETS.map((preset) => {
    const host = hostOf(preset.baseUrl);
    const path = pathOf(preset.baseUrl);
    return {
      providerKey: preset.vendorKey,
      baseUrls: [preset.baseUrl],
      ...(host ? { hosts: [host] } : {}),
      ...(path ? { paths: [path] } : {}),
      apiStyle: preset.apiStyle,
      discoveryStyle: discoveryStyleForApiStyle(preset.apiStyle),
    };
  });

/** Registry entries addressing this host. */
export function providerEndpointDefinitionsForHost(host: string): readonly ProviderEndpointDefinition[] {
  const normalized = host.trim().toLowerCase();
  if (!normalized) return [];
  return PROVIDER_ENDPOINT_DEFINITIONS.filter((definition) =>
    definition.hosts?.includes(normalized),
  );
}

/** Registry entry a URL addresses exactly, when one does. */
export function providerEndpointDefinitionForUrl(
  url: string,
  normalize: (value: string) => string,
): ProviderEndpointDefinition | undefined {
  const target = normalize(url);
  return PROVIDER_ENDPOINT_DEFINITIONS.find((definition) =>
    definition.baseUrls?.some((baseUrl) => normalize(baseUrl) === target),
  );
}

/** Canonical comparison form of an endpoint: scheme, host and path, no trailing slash. */
export function canonicalEndpointUrl(value: string | undefined): string {
  const raw = value?.trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    const pathname = parsed.pathname.replace(/\/+$/, "");
    return `${parsed.protocol.toLowerCase()}//${parsed.host.toLowerCase()}${pathname}`;
  } catch {
    return raw.replace(/\/+$/, "").toLowerCase();
  }
}

/**
 * Operation suffixes a pasted URL may carry. `/models` names no wire style: it
 * only says the user pasted a discovery URL rather than a base URL.
 */
const OPERATION_SUFFIXES: ReadonlyArray<{ suffix: string; apiStyle?: CatalogApiStyle }> = [
  { suffix: "/chat/completions", apiStyle: "chat_completions" },
  { suffix: "/responses", apiStyle: "responses" },
  { suffix: "/messages", apiStyle: "anthropic_messages" },
  { suffix: "/models" },
];

/**
 * Wire family a style belongs to for URL normalization: `opencode_go` addresses
 * Chat Completions and `openai_codex_responses` addresses Responses, so a
 * pasted operation of the same family is the user describing the scheme they
 * already selected.
 */
function wireStyleFamily(apiStyle: CatalogApiStyle): CatalogApiStyle {
  if (apiStyle === "opencode_go") return "chat_completions";
  if (apiStyle === "openai_codex_responses") return "responses";
  if (apiStyle === "pi_messages") return "anthropic_messages";
  return apiStyle;
}

export type ParsedEndpointInput = {
  input: string;
  /** Origin plus path, no trailing slash: what the user typed, canonicalized. */
  normalizedInput: string;
  origin: string;
  /** Path without a trailing slash; `""` for a host root. */
  pathname: string;
};

/**
 * Normalize a user-typed address into an absolute one.
 *
 * A bare host is completed with `https://`. That is input normalization inside
 * the origin the user named, not a cross-origin guess. Credentials, query
 * strings and fragments are rejected: a Base URL never carries them, and
 * accepting one would leak into a probe URL.
 */
export function parseEndpointInput(value: string): ParsedEndpointInput | undefined {
  const input = value.trim();
  if (!input) return undefined;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (!url.hostname) return undefined;
  if (url.username || url.password || url.search || url.hash) return undefined;
  const pathname = url.pathname.replace(/\/+$/, "");
  return {
    input,
    normalizedInput: `${url.origin}${pathname}`,
    origin: url.origin,
    pathname,
  };
}

/** The operation a pasted URL points at, with the base endpoint it implies. */
export function matchEndpointOperation(pathname: string): {
  suffix: string;
  apiStyle?: CatalogApiStyle;
  basePath: string;
} | undefined {
  const lower = pathname.toLowerCase();
  for (const entry of OPERATION_SUFFIXES) {
    if (!lower.endsWith(entry.suffix)) continue;
    return {
      suffix: entry.suffix,
      ...(entry.apiStyle ? { apiStyle: entry.apiStyle } : {}),
      basePath: pathname.slice(0, -entry.suffix.length).replace(/\/+$/, ""),
    };
  }
  return undefined;
}

export type EndpointProfileInput = {
  baseUrl: string;
  /** Style currently selected in the UI. */
  apiStyle?: CatalogApiStyle | null;
  /** True when the user picked that style, as opposed to inheriting a default. */
  explicitApiStyle?: boolean;
  /** models.dev vendor key of the configured row, when it has one. */
  providerKey?: string | null;
  /** Style implied by the publisher's models.dev `npm` adapter. */
  providerApiStyle?: CatalogApiStyle | null;
};

/** Strongest first-party evidence about the endpoint itself, not about the style. */
function endpointEvidenceOf(evidence: readonly EndpointEvidence[]): EndpointEvidence | undefined {
  const endpointTypes: ReadonlySet<EndpointEvidenceType> = new Set([
    "url_suffix",
    "known_endpoint",
    "known_host",
    "fallback",
  ]);
  return [...evidence]
    .filter((entry) => endpointTypes.has(entry.type))
    .sort((left, right) => right.confidence - left.confidence)[0];
}

/**
 * Resolve a typed Base URL into the endpoint that will really be used.
 *
 * Every claim is recorded as evidence, so the UI can explain the answer instead
 * of performing a hidden rewrite. `apiStyle` follows the documented order:
 * user choice, URL operation suffix, exact known endpoint, known host, then
 * published provider metadata, and finally the Chat Completions fallback.
 */
export function inferEndpointProfile(input: EndpointProfileInput): EndpointProfile | undefined {
  const parsed = parseEndpointInput(input.baseUrl);
  if (!parsed) return undefined;

  const evidence: EndpointEvidence[] = [];
  const operation = matchEndpointOperation(parsed.pathname);
  const registryByUrl = providerEndpointDefinitionForUrl(
    parsed.normalizedInput,
    canonicalEndpointUrl,
  );
  const registryByHost = providerEndpointDefinitionsForHost(new URL(parsed.origin).host);
  const hostDefinition = registryByHost.find(
    (definition) => definition.apiStyle !== undefined,
  );

  if (operation?.apiStyle) {
    evidence.push({
      type: "url_suffix",
      confidence: ENDPOINT_EVIDENCE_CONFIDENCE.url_suffix,
      detail: operation.suffix,
    });
  }
  if (registryByUrl?.apiStyle) {
    evidence.push({
      type: "known_endpoint",
      confidence: ENDPOINT_EVIDENCE_CONFIDENCE.known_endpoint,
      detail: registryByUrl.providerKey,
    });
  } else if (hostDefinition?.apiStyle) {
    evidence.push({
      type: "known_host",
      confidence: ENDPOINT_EVIDENCE_CONFIDENCE.known_host,
      detail: hostDefinition.providerKey,
    });
  }
  if (input.providerApiStyle) {
    evidence.push({
      type: "provider_metadata",
      confidence: ENDPOINT_EVIDENCE_CONFIDENCE.provider_metadata,
      detail: "npm",
    });
  }
  if (input.apiStyle && input.explicitApiStyle) {
    evidence.push({
      type: "explicit",
      confidence: ENDPOINT_EVIDENCE_CONFIDENCE.explicit,
      detail: input.apiStyle,
    });
  }
  evidence.push({
    type: "fallback",
    confidence: ENDPOINT_EVIDENCE_CONFIDENCE.fallback,
    detail: "chat_completions",
  });
  // Weakest first, so `evidence.at(-1)` is the strongest claim.
  evidence.sort((left, right) => left.confidence - right.confidence);

  /*
    Resolution order: the user's own choice, the pasted operation suffix, an
    exact known endpoint, a known host, then published provider metadata. A
    model id never participates, and a weaker source never overrides a stronger
    one — each step only answers when every step above it was silent.
  */
  const apiStyle: CatalogApiStyle =
    (input.apiStyle && input.explicitApiStyle ? input.apiStyle : undefined) ??
    operation?.apiStyle ??
    registryByUrl?.apiStyle ??
    hostDefinition?.apiStyle ??
    input.providerApiStyle ??
    "chat_completions";

  /*
    The pasted operation is stripped only when it belongs to the resolved wire
    format. A user who selected Chat Completions and pasted a `/responses` URL
    is describing a mismatch, not a base endpoint: stripping it would silently
    retarget the row, so the path is kept until they resolve it.
  */
  const operationFamily = operation?.apiStyle
    ? wireStyleFamily(operation.apiStyle)
    : undefined;
  const stripsOperation =
    operation !== undefined &&
    (operationFamily === undefined || operationFamily === wireStyleFamily(apiStyle));
  const effectiveBaseUrl = stripsOperation
    ? `${parsed.origin}${operation.basePath}`
    : parsed.normalizedInput;

  const providerKey = registryByUrl?.providerKey ?? hostDefinition?.providerKey ?? input.providerKey ?? undefined;

  const profile: EndpointProfile = {
    input: parsed.input,
    normalizedInput: parsed.normalizedInput,
    origin: parsed.origin,
    effectiveBaseUrl,
    apiStyle,
    ...(providerKey ? { providerKey } : {}),
    evidence,
    candidates: [],
  };
  /*
    The probe style follows the wire style that will actually be used, so
    "discovery succeeded" and "the row is configured this way" can never
    disagree. A registry entry for the same host may still offer its own style
    as a later candidate (see `buildDiscoveryCandidates`).
  */
  profile.discoveryStyle = discoveryStyleForApiStyle(apiStyle);
  profile.candidates = buildDiscoveryCandidates(profile);
  return profile;
}

/**
 * Base URLs worth probing for a resolved profile, strongest first.
 *
 * At most {@link MAX_DISCOVERY_CANDIDATES}. Every candidate stays on the
 * user-typed origin, because the probe sends the user's API key with it. The
 * only generic extra path is `/v1` for an unknown OpenAI-compatible endpoint;
 * provider-specific paths such as `/v1beta` or `/compatible-mode/v1` come from
 * the registry, never from a blanket heuristic.
 */
export function buildDiscoveryCandidates(profile: EndpointProfile): EndpointCandidate[] {
  const base = profile.effectiveBaseUrl.replace(/\/+$/, "");
  const discoveryStyle = profile.discoveryStyle ?? discoveryStyleForApiStyle(profile.apiStyle);
  const candidates: EndpointCandidate[] = [];
  const seen = new Set<string>();

  const add = (candidate: EndpointCandidate) => {
    const parsed = parseEndpointInput(candidate.baseUrl);
    if (!parsed || parsed.origin !== profile.origin) return;
    const key = `${discoveryProbeUrl(parsed.normalizedInput, candidate.discoveryStyle)}\u0000${candidate.discoveryStyle}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ ...candidate, baseUrl: parsed.normalizedInput });
  };

  const primary = endpointEvidenceOf(profile.evidence) ??
    profile.evidence.at(-1) ?? { type: "fallback" as const, confidence: 0 };
  add({
    baseUrl: base,
    discoveryStyle,
    ...(profile.apiStyle ? { apiStyleHint: profile.apiStyle } : {}),
    evidence: primary,
  });

  /*
    Registry paths are offered only for a host named without a path. A typed
    path is an answer about this deployment: Zhipu serves three API styles on
    three paths of one host, and replacing a typed `/api/v1` with its sibling
    `/api/paas/v4` because the first returned nothing would move the row to a
    different service while keeping its format.
  */
  const definitions = providerEndpointDefinitionsForHost(new URL(profile.origin).host);
  const typedPath = parseEndpointInput(profile.effectiveBaseUrl)?.pathname ?? "";
  if (typedPath === "") {
    for (const definition of definitions) {
      for (const baseUrl of definition.baseUrls ?? []) {
        add({
          baseUrl,
          discoveryStyle: definition.discoveryStyle ?? discoveryStyle,
          ...(definition.apiStyle ? { apiStyleHint: definition.apiStyle } : {}),
          evidence: {
            type: "known_host",
            confidence: ENDPOINT_EVIDENCE_CONFIDENCE.known_host,
            detail: definition.providerKey,
          },
        });
      }
    }
  }

  /*
    One generic extension only: an unknown OpenAI-compatible endpoint very
    often serves the same route under /v1. Provider-specific paths (/v1beta,
    /compatible-mode/v1) are registry facts and are never guessed, and a host
    the registry already describes is not extended on a hunch.
  */
  const keepsOperation = matchEndpointOperation(new URL(base).pathname) !== undefined;
  if (
    discoveryStyle === "openai_models" &&
    definitions.length === 0 &&
    !keepsOperation &&
    !base.toLowerCase().endsWith("/v1")
  ) {
    add({
      baseUrl: `${base}/v1`,
      discoveryStyle,
      evidence: {
        type: "fallback",
        confidence: ENDPOINT_EVIDENCE_CONFIDENCE.fallback,
        detail: "/v1",
      },
    });
  }

  return candidates.slice(0, MAX_DISCOVERY_CANDIDATES);
}
