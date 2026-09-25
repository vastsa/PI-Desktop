/**
 * Provider model discovery: ask a service's own model-list endpoint what it
 * serves, so users pick real model IDs instead of typing them.
 *
 * Three responsibilities, deliberately separate:
 *
 *  - `normalizeModelList` turns a response body into rows and is pure;
 *  - `modelListRequest` builds the request one endpoint needs;
 *  - `probeModelList` performs exactly one request, with redirect safety.
 *
 * The candidate sweep that resolves an unknown Base URL lives in
 * `provider-endpoint-probe.ts` and drives `probeModelList`, so discovery and
 * "Test connection" cannot drift into two different URL or auth rules.
 */

import {
  discoveryProbeUrl,
  discoveryStyleForApiStyle,
  type DiscoveryStyle,
} from "@pi-desktop/shared";

export type DiscoveredModel = {
  modelId: string;
  displayName: string;
};

export const DISCOVERY_TIMEOUT_MS = 10_000;
/** Total budget for one endpoint-resolution sweep; its candidates share it. */
export const DISCOVERY_TOTAL_BUDGET_MS = 12_000;
const MAX_MODELS = 500;
const MAX_REDIRECTS = 3;
const RESERVED_DISCOVERY_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "host",
  "content-type",
  "content-length",
  "cookie",
  "set-cookie",
  "connection",
  "x-api-key",
  "api-key",
  "chatgpt-account-id",
]);

function withCustomHeaders(
  base: Record<string, string>,
  extra?: Record<string, string>,
): Record<string, string> {
  if (!extra) return base;
  const next = { ...base };
  for (const [rawKey, rawValue] of Object.entries(extra)) {
    const key = rawKey.trim();
    const value = rawValue.trim();
    if (!key || !value) continue;
    if (key.includes("\r") || key.includes("\n") || value.includes("\r") || value.includes("\n")) {
      continue;
    }
    const lower = key.toLowerCase();
    if (RESERVED_DISCOVERY_HEADERS.has(lower)) continue;
    for (const existing of Object.keys(next)) {
      if (existing.toLowerCase() === lower) delete next[existing];
    }
    next[key] = value;
  }
  return next;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function dedupeSort(models: DiscoveredModel[]): DiscoveredModel[] {
  const seen = new Map<string, DiscoveredModel>();
  for (const model of models) {
    if (model.modelId && !seen.has(model.modelId)) seen.set(model.modelId, model);
  }
  return [...seen.values()]
    .sort((a, b) => a.modelId.localeCompare(b.modelId))
    .slice(0, MAX_MODELS);
}

/**
 * Normalize a model-list response body. Pure.
 *
 * `style` is either a wire API style or a discovery style; both name the same
 * three response shapes. Two of them nest the rows under a key of their own:
 * Google publishes `{ models: [{ name: "models/…" }] }`, and Zhipu's OpenAI
 * Responses endpoint publishes `{ models: [{ slug }] }` — the same `models`
 * key with a `models/` prefix that never appears there.
 */
export function normalizeModelList(
  style: string | undefined,
  body: unknown,
): DiscoveredModel[] {
  const record = asRecord(body);
  if (style === "google_generative_ai" || style === "google_models") {
    const models = Array.isArray(record?.models) ? record.models : [];
    return dedupeSort(
      models.flatMap((entry) => {
        const item = asRecord(entry);
        const rawName = typeof item?.name === "string" ? item.name : "";
        const modelId = rawName.replace(/^models\//, "");
        if (!modelId) return [];
        const displayName =
          typeof item?.displayName === "string" && item.displayName
            ? item.displayName
            : modelId;
        return [{ modelId, displayName }];
      }),
    );
  }
  // OpenAI-style and Anthropic both use { data: [...] }; some gateways return
  // the bare array, and Zhipu's Responses endpoint wraps the rows in `models`.
  const data = Array.isArray(record?.data)
    ? record.data
    : Array.isArray(body)
      ? (body as unknown[])
      : Array.isArray(record?.models)
        ? record.models
        : [];
  return dedupeSort(
    data.flatMap((entry) => {
      const item = asRecord(entry);
      const modelId = listedModelId(item);
      if (!modelId) return [];
      const displayName =
        typeof item?.display_name === "string" && item.display_name
          ? item.display_name
          : modelId;
      return [{ modelId, displayName }];
    }),
  );
}

/**
 * The id one row of a model list carries.
 *
 * `id` is the OpenAI and Anthropic shape. `slug` is what Zhipu's OpenAI
 * Responses endpoint returns. The two are mutually exclusive, so either may be
 * read without ambiguity, and the wire id stays exactly as the service spelled
 * it.
 */
function listedModelId(item: Record<string, unknown> | null): string {
  if (typeof item?.id === "string" && item.id) return item.id;
  return typeof item?.slug === "string" ? item.slug : "";
}

/**
 * Build the request for a provider's model-list endpoint. Pure.
 *
 * The URL comes from the shared `discoveryProbeUrl`, so a candidate the
 * resolver offered and the request built for it can never disagree.
 */
export function modelListRequest(opts: {
  baseUrl: string;
  apiKey?: string;
  apiStyle?: string;
  discoveryStyle?: DiscoveryStyle;
  headers?: Record<string, string>;
}): { url: string; headers: Record<string, string> } {
  const apiKey = opts.apiKey ?? "";
  const discoveryStyle =
    opts.discoveryStyle ?? discoveryStyleForApiStyle(opts.apiStyle);
  const path = discoveryProbeUrl(opts.baseUrl, discoveryStyle);
  const withHeaders = (headers: Record<string, string>): Record<string, string> =>
    withCustomHeaders(headers, opts.headers);

  if (discoveryStyle === "google_models") {
    const params = new URLSearchParams({ pageSize: "1000" });
    if (apiKey) params.set("key", apiKey);
    return { url: `${path}?${params}`, headers: withHeaders({}) };
  }
  if (discoveryStyle === "anthropic_models") {
    return {
      url: `${path}?limit=1000`,
      headers: withHeaders({
        ...(apiKey ? { "x-api-key": apiKey } : {}),
        "anthropic-version": "2023-06-01",
      }),
    };
  }
  // Chat Completions, Responses, OpenCode Go and the Codex account all expose
  // the same authenticated OpenAI-compatible model list.
  return {
    url: path,
    headers: withHeaders(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  };
}

export type ModelListProbe = {
  /** The URL that answered, after any same-origin redirect. */
  url: string;
  status: number;
  models: DiscoveredModel[];
};

function originOf(value: string): string | undefined {
  try {
    return new URL(value.trim()).origin;
  } catch {
    return undefined;
  }
}

/**
 * One model-list request.
 *
 * Redirects are followed manually so a cross-origin hop can be refused before
 * the credential travels: the `Location` is compared against `allowOrigin`
 * first. Throws on a network error, a refused redirect, or a non-2xx status —
 * `error.status` carries the HTTP status when there was one.
 */
export async function probeModelList(opts: {
  baseUrl: string;
  apiKey?: string;
  apiStyle?: string;
  discoveryStyle?: DiscoveryStyle;
  headers?: Record<string, string>;
  /**
   * Credentials may only travel to this origin. Defaults to the configured base
   * URL's own origin, so a caller cannot widen it by accident.
   */
  allowOrigin?: string;
  /**
   * Caller-owned budget. The sweep shares one across its candidates and passes
   * it here; a caller that passes nothing gets the single-request default.
   */
  signal?: AbortSignal;
}): Promise<ModelListProbe> {
  const request = modelListRequest(opts);
  const allowOrigin = opts.allowOrigin ?? originOf(opts.baseUrl);
  const responseSignal = opts.signal ?? defaultTimeoutSignal();
  if (allowOrigin) {
    const origin = originOf(request.url);
    if (origin !== allowOrigin) {
      throw new Error("model list request refused: it left the configured origin");
    }
  }

  let url = request.url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const res = await fetch(url, {
      headers: request.headers,
      signal: responseSignal,
      // Never let fetch carry the credential to another origin on its own.
      redirect: "manual",
    });
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      const next = new URL(location, url);
      if (allowOrigin && next.origin !== allowOrigin) {
        throw Object.assign(
          new Error("model list redirect refused: it left the configured origin"),
          { status: res.status },
        );
      }
      url = next.toString();
      continue;
    }
    if (!res.ok) {
      throw Object.assign(new Error(`model list request failed (${res.status})`), {
        status: res.status,
      });
    }
    return {
      url,
      status: res.status,
      models: normalizeModelList(
        opts.discoveryStyle ?? opts.apiStyle,
        await res.json(),
      ),
    };
  }
  throw new Error("model list request followed too many redirects");
}

/**
 * Abort signal for a single request made without a caller budget.
 *
 * Resolution always passes its shared sweep budget; this keeps a direct caller
 * (a connection test with no budget of its own) from hanging on a silent host.
 */
function defaultTimeoutSignal(): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);
  return controller.signal;
}
