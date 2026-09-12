/**
 * Provider model discovery: query the provider's own model-list endpoint so
 * users pick real model IDs instead of typing them (settings dialog and the
 * composer model menu both consume this).
 *
 * Per apiStyle:
 *  - chat_completions / responses → GET {base}/models        (Bearer auth)
 *  - anthropic_messages           → GET {base}/v1/models     (x-api-key)
 *  - google_generative_ai        → GET {base}/models?key=…
 */

export type DiscoveredModel = {
  modelId: string;
  displayName: string;
};

const DISCOVERY_TIMEOUT_MS = 10_000;
const MAX_MODELS = 500;
const OPENCODE_GO_API_STYLE = "opencode_go";
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

/** Normalize a model-list response body for the given apiStyle. Pure. */
export function normalizeModelList(
  apiStyle: string | undefined,
  body: unknown,
): DiscoveredModel[] {
  const record = asRecord(body);
  if (apiStyle === "google_generative_ai") {
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
  // the bare array.
  const data = Array.isArray(record?.data)
    ? record.data
    : Array.isArray(body)
      ? (body as unknown[])
      : [];
  return dedupeSort(
    data.flatMap((entry) => {
      const item = asRecord(entry);
      const modelId = typeof item?.id === "string" ? item.id : "";
      if (!modelId) return [];
      const displayName =
        typeof item?.display_name === "string" && item.display_name
          ? item.display_name
          : modelId;
      return [{ modelId, displayName }];
    }),
  );
}

/** Build the request for a provider's model-list endpoint. Pure. */
export function modelListRequest(opts: {
  baseUrl: string;
  apiKey?: string;
  apiStyle?: string;
  headers?: Record<string, string>;
}): { url: string; headers: Record<string, string> } {
  const base = opts.baseUrl.trim().replace(/\/+$/, "");
  const apiKey = opts.apiKey ?? "";
  const withHeaders = (headers: Record<string, string>): Record<string, string> =>
    withCustomHeaders(headers, opts.headers);
  if (opts.apiStyle === "google_generative_ai") {
    const params = new URLSearchParams({ pageSize: "1000" });
    if (apiKey) params.set("key", apiKey);
    return { url: `${base}/models?${params}`, headers: withHeaders({}) };
  }
  if (opts.apiStyle === "anthropic_messages") {
    // Anthropic base URLs conventionally exclude /v1 (runtime appends it).
    const root = base.endsWith("/v1") ? base : `${base}/v1`;
    return {
      url: `${root}/models?limit=1000`,
      headers: withHeaders({
        ...(apiKey ? { "x-api-key": apiKey } : {}),
        "anthropic-version": "2023-06-01",
      }),
    };
  }
  // OpenCode Go exposes the same authenticated OpenAI-compatible /models
  // endpoint as generic Chat Completions, but keeps a distinct UI style.
  if (opts.apiStyle === OPENCODE_GO_API_STYLE) {
    return {
      url: `${base}/models`,
      headers: withHeaders(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    };
  }
  return {
    url: `${base}/models`,
    headers: withHeaders(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  };
}

/** Fetch and normalize the provider's model list. Throws on HTTP/network errors. */
export async function discoverProviderModels(opts: {
  baseUrl: string;
  apiKey?: string;
  apiStyle?: string;
  headers?: Record<string, string>;
}): Promise<DiscoveredModel[]> {
  const { url, headers } = modelListRequest(opts);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) {
      throw Object.assign(new Error(`model list request failed (${res.status})`), {
        status: res.status,
      });
    }
    return normalizeModelList(opts.apiStyle, await res.json());
  } finally {
    clearTimeout(timer);
  }
}
