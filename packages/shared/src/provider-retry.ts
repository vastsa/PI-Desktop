/** Shared automatic provider retry budget used by runtime and renderer status. */
export const PROVIDER_RETRY_MAX_RETRIES = 10;
/** Shipped first-retry wait in milliseconds; settings may override it. */
export const PROVIDER_RETRY_INITIAL_DELAY_MS = 2_000;
/** Normalized retry ceiling for a raw settings value; 0 means unlimited. */
export function normalizeProviderRetryMaxAttempts(
  value: number | undefined,
): number | undefined {
  if (value === undefined || Number.isNaN(value)) return undefined;
  const n = Math.floor(value);
  if (n < 0) return undefined;
  return n;
}

/**
 * Normalized first-retry wait, in milliseconds, for a raw settings value.
 * 0 retries immediately; negative or non-numeric values fall back to default.
 */
export function normalizeProviderRetryInitialDelayMs(
  value: number | undefined,
): number | undefined {
  if (value === undefined || Number.isNaN(value)) return undefined;
  const n = Math.floor(value);
  if (n < 0) return undefined;
  return n;
}
