/**
 * Reachability check for the configured Jev System One credential.
 *
 * This performs the smallest real classification request against the same
 * normalized endpoint and model that Agent runtime will use. It stores nothing,
 * never logs the credential, and follows redirects only inside the configured
 * origin so Bearer auth cannot escape to another service.
 */
import {
  DEFAULT_JEV_CLASSIFIER_BINDING,
  jevSystemOneUrl,
  normalizeJevClassifierBinding,
  type JevClassifierBinding,
  type JevKeyCheckResult,
} from "@pi-desktop/shared";

export const JEV_PROBE_TIMEOUT_MS = 20_000;
const MAX_DETAIL_LENGTH = 300;
const MAX_REDIRECTS = 3;

export type JevProbeOptions = {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Production injects the app's DNS/route/network-policy guard. */
  assertEndpoint?: (url: string) => Promise<void>;
};

function isProbeOptions(value: unknown): value is JevProbeOptions {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  // The legacy `(key, options)` shape allowed an empty object. New bindings
  // always identify themselves with at least one binding field, including
  // malformed partial bindings that must fail validation rather than fall back.
  return !("baseUrl" in record || "modelId" in record);
}

function probeRequestBody(modelId: string) {
  return {
    model: modelId,
    state: { probe: true },
    questions: {
      reachable: {
        type: "noul",
        instructions: "Did this request reach the classifier?",
        criteria: {
          true: "The request reached the classifier.",
          false: "The request did not reach the classifier.",
        },
      },
    },
  };
}

function redact(value: string, apiKey: string): string {
  return apiKey ? value.split(apiKey).join("[redacted]") : value;
}

async function postWithSameOriginRedirects(
  startUrl: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
): Promise<Response> {
  const allowedOrigin = new URL(startUrl).origin;
  let url = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await fetchImpl(url, { ...init, redirect: "manual" });
    const location = response.headers?.get?.("location");
    if (response.status < 300 || response.status >= 400 || !location) return response;
    const next = new URL(location, url);
    if (next.origin !== allowedOrigin) {
      throw Object.assign(
        new Error("System One redirect refused: it left the configured origin"),
        { status: response.status },
      );
    }
    url = next.toString();
  }
  throw new Error("System One request followed too many redirects");
}

/**
 * `bindingOrOptions` keeps the original `(key, options)` test/caller shape
 * compatible; new callers pass `(key, binding, options)`.
 */
export async function probeJevApiKey(
  apiKey: string,
  bindingOrOptions: JevClassifierBinding | JevProbeOptions = {
    ...DEFAULT_JEV_CLASSIFIER_BINDING,
  },
  explicitOptions: JevProbeOptions = {},
): Promise<JevKeyCheckResult> {
  const options = isProbeOptions(bindingOrOptions)
    ? bindingOrOptions
    : explicitOptions;
  const binding = isProbeOptions(bindingOrOptions)
    ? { ...DEFAULT_JEV_CLASSIFIER_BINDING }
    : bindingOrOptions;
  const key = apiKey.trim();
  if (!key) return { ok: false, message: "No System One API key was provided." };
  const normalized = normalizeJevClassifierBinding(binding);
  if (!normalized) {
    return { ok: false, message: "The System One endpoint or model is invalid." };
  }
  const requestUrl = jevSystemOneUrl(normalized);
  const timeoutMs = options.timeoutMs ?? JEV_PROBE_TIMEOUT_MS;
  const timeoutController = new AbortController();
  const timeoutTimer = setTimeout(() => timeoutController.abort(), timeoutMs);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutController.signal])
    : timeoutController.signal;
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  try {
    await options.assertEndpoint?.(requestUrl);
    const response = await postWithSameOriginRedirects(
      requestUrl,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(probeRequestBody(normalized.modelId)),
        signal,
      },
      doFetch,
    );
    if (response.ok) return { ok: true, status: response.status };
    const body = await response.text().catch(() => "");
    const detail = redact(body.trim(), key).slice(0, MAX_DETAIL_LENGTH);
    return {
      ok: false,
      status: response.status,
      message: detail
        ? `System One returned ${response.status}: ${detail}`
        : `System One returned ${response.status}`,
    };
  } catch (error) {
    if (options.signal?.aborted) {
      return { ok: false, message: "The System One key check was cancelled." };
    }
    const name = (error as { name?: unknown }).name;
    if (name === "TimeoutError" || name === "AbortError") {
      return {
        ok: false,
        message: `The System One endpoint did not answer within ${Math.round(timeoutMs / 1000)}s.`,
      };
    }
    const status = (error as { status?: unknown }).status;
    return {
      ok: false,
      ...(typeof status === "number" ? { status } : {}),
      message: redact(
        error instanceof Error ? error.message : String(error),
        key,
      ).slice(0, MAX_DETAIL_LENGTH),
    };
  } finally {
    clearTimeout(timeoutTimer);
  }
}
