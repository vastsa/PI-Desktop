/**
 * Per-provider outbound HTTP headers.
 *
 * Adapters (pi-ai, Anthropic SDK, Codex) stamp User-Agent after extra headers.
 * A fetch wrapper is therefore the last writer for the whole map, and the same
 * values are also placed on stream-option headers so OpenCode's "caller header
 * wins" rule stays true.
 *
 * Empty / omitted keeps adapter defaults. Authorization, Host, Content-Type,
 * and other hop-by-hop or auth keys are rejected so this cannot smash signing.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { FetchFunction, ProviderHeaders, SimpleStreamOptions } from "@earendil-works/pi-ai";

export const PROVIDER_HEADERS_MAX = 32;
export const PROVIDER_HEADER_KEY_MAX_BYTES = 256;
export const PROVIDER_HEADER_VALUE_MAX_BYTES = 4096;

const FORBIDDEN_HEADER_KEYS = new Set([
  "authorization",
  "proxy-authorization",
  "host",
  "content-type",
  "content-length",
  "cookie",
  "set-cookie",
  "connection",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "keep-alive",
  "x-api-key",
  "api-key",
  "chatgpt-account-id",
  "x-opencode-session",
]);

const oauthHeaders = new AsyncLocalStorage<Record<string, string>>();
let wrappedGlobalFetch: typeof fetch | undefined;

export type ProviderHeaderMap = Record<string, string>;

function validHeaderKey(key: string): boolean {
  if (!key) return false;
  const first = key.charCodeAt(0);
  const firstOk =
    (first >= 48 && first <= 57) ||
    (first >= 65 && first <= 90) ||
    (first >= 97 && first <= 122);
  if (!firstOk) return false;
  for (let i = 1; i < key.length; i += 1) {
    const code = key.charCodeAt(i);
    const ok =
      (code >= 48 && code <= 57) ||
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      code === 45;
    if (!ok) return false;
  }
  return true;
}

function overlayHeaders(
  target: Record<string, string>,
  extra: Record<string, string>,
): void {
  for (const [key, value] of Object.entries(extra)) {
    for (const existing of Object.keys(target)) {
      if (existing.toLowerCase() === key.toLowerCase()) delete target[existing];
    }
    target[key] = value;
  }
}

/** Drop invalid rows. Host persistence rejects the same cases with an error. */
export function normalizeProviderHeaders(
  value: unknown,
): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const byLower = new Map<string, { key: string; value: string }>();
  for (const [rawKey, rawValue] of Object.entries(value as Record<string, unknown>)) {
    if (typeof rawValue !== "string") continue;
    const key = rawKey.trim();
    const headerValue = rawValue.trim();
    if (!key || !headerValue) continue;
    if (key.length > PROVIDER_HEADER_KEY_MAX_BYTES) continue;
    if (headerValue.length > PROVIDER_HEADER_VALUE_MAX_BYTES) continue;
    if (key.includes("\r") || key.includes("\n")) continue;
    if (headerValue.includes("\r") || headerValue.includes("\n")) continue;
    if (!validHeaderKey(key)) continue;
    const lower = key.toLowerCase();
    if (FORBIDDEN_HEADER_KEYS.has(lower)) continue;
    byLower.set(lower, { key, value: headerValue });
  }
  if (byLower.size === 0) return undefined;
  const next: Record<string, string> = {};
  let count = 0;
  for (const entry of byLower.values()) {
    if (count >= PROVIDER_HEADERS_MAX) break;
    next[entry.key] = entry.value;
    count += 1;
  }
  return next;
}

export function providerHeadersDigest(
  headers: Record<string, string> | undefined,
): string {
  const normalized = normalizeProviderHeaders(headers);
  if (!normalized) return "";
  return Object.entries(normalized)
    .map(([key, value]) => `${key.toLowerCase()}:${value}`)
    .sort()
    .join("\n");
}

export function providerHeadersEqual(
  left: Record<string, string> | undefined,
  right: Record<string, string> | undefined,
): boolean {
  return providerHeadersDigest(left) === providerHeadersDigest(right);
}

export function optionalProviderHeaders(
  headers: Record<string, string> | undefined,
): { headers: Record<string, string> } | Record<string, never> {
  const normalized = normalizeProviderHeaders(headers);
  return normalized ? { headers: normalized } : {};
}

export function mergeProviderHeaders(
  base: ProviderHeaders | Record<string, string> | undefined,
  extra: Record<string, string> | undefined,
): Record<string, string> | undefined {
  const next: Record<string, string> = {};
  if (base) {
    for (const [key, value] of Object.entries(base)) {
      if (typeof value === "string") next[key] = value;
    }
  }
  const normalized = normalizeProviderHeaders(extra);
  if (normalized) overlayHeaders(next, normalized);
  return Object.keys(next).length > 0 ? next : undefined;
}

export function applyProviderHeadersToRequestInit(
  init: RequestInit | undefined,
  headers: Record<string, string>,
): RequestInit {
  const next = new Headers(init?.headers);
  for (const [key, value] of Object.entries(headers)) next.set(key, value);
  return { ...(init ?? {}), headers: next };
}

export function withProviderHeadersFetch(
  fetchFn: FetchFunction | undefined,
  headers: Record<string, string> | undefined,
): FetchFunction | undefined {
  const normalized = normalizeProviderHeaders(headers);
  if (!normalized) return fetchFn;
  const baseFetch = fetchFn ?? globalThis.fetch.bind(globalThis);
  return (input, init) =>
    baseFetch(input, applyProviderHeadersToRequestInit(init, normalized));
}

/** Merge the override onto stream headers and wrap fetch so adapters cannot win. */
export function withProviderHeaders(
  options: SimpleStreamOptions | undefined,
  headers: Record<string, string> | undefined,
): SimpleStreamOptions {
  const normalized = normalizeProviderHeaders(headers);
  if (!normalized) return options ?? {};
  const merged = mergeProviderHeaders(options?.headers, normalized);
  const fetch = withProviderHeadersFetch(options?.fetch, normalized);
  return {
    ...(options ?? {}),
    ...(merged ? { headers: merged } : {}),
    ...(fetch ? { fetch } : {}),
  };
}

/**
 * Scope a header override to one async chain. Pair with
 * `installProviderHeadersFetch` so pi-ai's global `fetch` (OAuth
 * login/refresh) honors the store. Empty store is a no-op.
 */
export function runWithProviderHeaders<T>(
  headers: Record<string, string> | undefined,
  fn: () => T,
): T {
  const normalized = normalizeProviderHeaders(headers);
  if (!normalized) return fn();
  installProviderHeadersFetch();
  return oauthHeaders.run(normalized, fn);
}

export function applyStoredProviderHeadersToInit(
  init?: RequestInit,
): RequestInit | undefined {
  const stored = oauthHeaders.getStore();
  if (!stored) return init;
  return applyProviderHeadersToRequestInit(init, stored);
}

/**
 * Patch global fetch so ALS-scoped OAuth HTTP can override headers.
 * Re-wraps when another layer (the user proxy) replaced `globalThis.fetch`.
 */
export function installProviderHeadersFetch(): void {
  if (globalThis.fetch === wrappedGlobalFetch) return;
  const inner = globalThis.fetch.bind(globalThis);
  wrappedGlobalFetch = ((input, init) =>
    inner(input, applyStoredProviderHeadersToInit(init))) as typeof fetch;
  globalThis.fetch = wrappedGlobalFetch;
}
