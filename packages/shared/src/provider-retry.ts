/** Shared automatic provider retry budget used by runtime and renderer status. */
export const PROVIDER_RETRY_MAX_RETRIES = 10;

/** Larger setTimeout delays overflow and must be split into abortable slices. */
export const PROVIDER_RETRY_MAX_TIMER_DELAY_MS = 2_147_483_647;

/** Untrusted persisted settings or launch values, normalized at each boundary. */
export type ProviderRetrySettingsInput = {
  infiniteProviderRetry?: unknown;
  providerRetryMaxAttempts?: unknown;
  providerRetryInitialDelayMs?: unknown;
  providerRetryFixedDelayMs?: unknown;
};

/** The resolved retry policy for one launch; each failure class has its own budget. */
export type ProviderRetryPolicy = {
  unlimited: boolean;
  /** Retries after the initial request; Infinity when unlimited. */
  maxAttempts: number;
  /** Absence preserves the released per-class first waits and caps. */
  initialDelayMs?: number;
  /** Overrides exponential backoff, jitter and server Retry-After when present. */
  fixedDelayMs?: number;
};

function isRetryInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Invalid reads and explicit resets normalize to absence, never a new default. */
export function normalizeProviderRetryMaxAttempts(value: unknown): number | undefined {
  return isRetryInteger(value) ? value : undefined;
}

/** Zero means immediate; absence preserves each class's released first wait. */
export function normalizeProviderRetryInitialDelayMs(value: unknown): number | undefined {
  return isRetryInteger(value) ? value : undefined;
}

/** Zero means immediate every time; absence preserves exponential schedules. */
export function normalizeProviderRetryFixedDelayMs(value: unknown): number | undefined {
  return isRetryInteger(value) ? value : undefined;
}

/** Omission preserves a value, null resets it, and own undefined is rejected. */
export function providerRetrySettingsWriteError(
  value: ProviderRetrySettingsInput,
): string | undefined {
  for (const field of [
    "providerRetryMaxAttempts", "providerRetryInitialDelayMs", "providerRetryFixedDelayMs",
  ] as const) {
    if (Object.prototype.hasOwnProperty.call(value, field) &&
        value[field] !== null && !isRetryInteger(value[field])) {
      return `${field} is invalid`;
    }
  }
  return undefined;
}

export function resolveProviderRetryPolicy(input: ProviderRetrySettingsInput): ProviderRetryPolicy {
  const configuredMaxAttempts = normalizeProviderRetryMaxAttempts(input.providerRetryMaxAttempts);
  const initialDelayMs = normalizeProviderRetryInitialDelayMs(input.providerRetryInitialDelayMs);
  const fixedDelayMs = normalizeProviderRetryFixedDelayMs(input.providerRetryFixedDelayMs);
  const unlimited = input.infiniteProviderRetry === true || configuredMaxAttempts === 0;
  return {
    unlimited,
    maxAttempts: unlimited ? Number.POSITIVE_INFINITY : (configuredMaxAttempts ?? PROVIDER_RETRY_MAX_RETRIES),
    ...(initialDelayMs === undefined ? {} : { initialDelayMs }),
    ...(fixedDelayMs === undefined ? {} : { fixedDelayMs }),
  };
}

/** A configured first wait raises, but never lowers, the released class cap. */
export function providerRetryDelayCapMs(categoryCapMs: number, initialDelayMs: number | undefined): number {
  return Math.max(categoryCapMs, initialDelayMs ?? 0);
}

/** Bound the exponent so unlimited runs cannot overflow into immediate timers. */
export function providerRetryBackoffMs(initialDelayMs: number, attempt: number, capMs: number): number {
  if (!Number.isFinite(initialDelayMs) || initialDelayMs <= 0) return 0;
  const safeCap = Number.isFinite(capMs) && capMs > 0 ? capMs : initialDelayMs;
  const step = Number.isFinite(attempt) ? Math.max(1, Math.floor(attempt)) : 1;
  const exponent = Math.min(step - 1, 52);
  return Math.min(safeCap, Math.ceil(initialDelayMs * 2 ** exponent));
}

/** Timer-safe slices preserving the total planned wait. Nonpositive/nonfinite waits schedule nothing. */
export function retryWaitSlices(totalMs: number): number[] {
  if (!Number.isFinite(totalMs) || totalMs <= 0) return [];
  const slices: number[] = [];
  let remaining = Math.ceil(totalMs);
  while (remaining > 0) {
    const slice = Math.min(remaining, PROVIDER_RETRY_MAX_TIMER_DELAY_MS);
    slices.push(slice);
    remaining -= slice;
  }
  return slices;
}
