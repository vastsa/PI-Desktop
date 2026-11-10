import { describe, expect, it } from "vitest";
import * as retry from "./provider-retry.js";

const fields = [
  "providerRetryMaxAttempts", "providerRetryInitialDelayMs", "providerRetryFixedDelayMs",
] as const;
const valid = [0, 1, 7, Number.MAX_SAFE_INTEGER];
const invalid = [-1, 1.5, NaN, Infinity, -Infinity, "3", true, undefined, {}, [], Number.MAX_SAFE_INTEGER + 1];

// Namespace lookup gives the released constant-only module a runnable red baseline.
describe("configurable provider retry contract", () => {
  it("exposes the shared normalization and policy API", () => {
    for (const name of [
      "normalizeProviderRetryMaxAttempts", "normalizeProviderRetryInitialDelayMs",
      "normalizeProviderRetryFixedDelayMs", "providerRetrySettingsWriteError",
      "resolveProviderRetryPolicy", "providerRetryDelayCapMs", "providerRetryBackoffMs",
      "retryWaitSlices",
    ]) expect(retry).toHaveProperty(name, expect.any(Function));
  });

  it("normalizes only nonnegative safe integers, preserving zero", () => {
    for (const normalize of [retry.normalizeProviderRetryMaxAttempts,
      retry.normalizeProviderRetryInitialDelayMs, retry.normalizeProviderRetryFixedDelayMs]) {
      for (const value of valid) expect(normalize(value)).toBe(value);
      for (const value of [...invalid, null]) expect(normalize(value)).toBeUndefined();
    }
  });

  it("rejects invalid writes including own undefined, but permits omission and null resets", () => {
    expect(retry.providerRetrySettingsWriteError({})).toBeUndefined();
    for (const field of fields) {
      for (const value of [...valid, null]) {
        expect(retry.providerRetrySettingsWriteError({ [field]: value })).toBeUndefined();
      }
      for (const value of invalid) {
        expect(retry.providerRetrySettingsWriteError({ [field]: value })).toBe(`${field} is invalid`);
      }
    }
  });

  it("retains released defaults and treats corrupt or cleared overrides as absent", () => {
    const defaults = { unlimited: false, maxAttempts: retry.PROVIDER_RETRY_MAX_RETRIES };
    expect(defaults.maxAttempts).toBe(10);
    expect(retry.resolveProviderRetryPolicy({})).toEqual(defaults);
    for (const value of [...invalid, null]) {
      expect(retry.resolveProviderRetryPolicy({
        infiniteProviderRetry: "true", providerRetryMaxAttempts: value,
        providerRetryInitialDelayMs: value, providerRetryFixedDelayMs: value,
      })).toEqual(defaults);
    }
  });

  it("resolves the budget, first wait and fixed interval without losing zero", () => {
    expect(retry.resolveProviderRetryPolicy({ providerRetryMaxAttempts: 3,
      providerRetryInitialDelayMs: 500, providerRetryFixedDelayMs: 30_000 })).toEqual({
      unlimited: false, maxAttempts: 3, initialDelayMs: 500, fixedDelayMs: 30_000,
    });
    expect(retry.resolveProviderRetryPolicy({ providerRetryMaxAttempts: 0,
      providerRetryInitialDelayMs: 0, providerRetryFixedDelayMs: 0 })).toEqual({
      unlimited: true, maxAttempts: Infinity, initialDelayMs: 0, fixedDelayMs: 0,
    });
    expect(retry.resolveProviderRetryPolicy({ infiniteProviderRetry: true,
      providerRetryMaxAttempts: 3 })).toEqual({ unlimited: true, maxAttempts: Infinity });
  });
});

describe("provider retry backoff", () => {
  it("preserves both released schedules", () => {
    const rateCap = retry.providerRetryDelayCapMs(30_000, undefined);
    const transientCap = retry.providerRetryDelayCapMs(8_000, undefined);
    expect([1, 2, 3, 4, 5].map((n) => retry.providerRetryBackoffMs(2_000, n, rateCap)))
      .toEqual([2_000, 4_000, 8_000, 16_000, 30_000]);
    expect([1, 2, 3, 4, 10].map((n) => retry.providerRetryBackoffMs(1_000, n, transientCap)))
      .toEqual([1_000, 2_000, 4_000, 8_000, 8_000]);
  });

  it("raises a class cap to the configured first wait without lowering released caps", () => {
    const cap = retry.providerRetryDelayCapMs(8_000, 60_000);
    expect(cap).toBe(60_000);
    expect(retry.providerRetryBackoffMs(60_000, 1, cap)).toBe(60_000);
    expect(retry.providerRetryBackoffMs(60_000, 2, cap)).toBe(60_000);
    expect(retry.providerRetryDelayCapMs(30_000, 500)).toBe(30_000);
    expect(retry.providerRetryBackoffMs(500, 9, 30_000)).toBe(30_000);
  });

  it("keeps unlimited-run delays finite, bounded and timer safe", () => {
    for (const attempt of [1, 2, 52, 53, 1_000, 1e9]) {
      const delay = retry.providerRetryBackoffMs(2_000, attempt, 30_000);
      expect(Number.isFinite(delay)).toBe(true);
      expect(delay).toBeGreaterThan(0);
      expect(delay).toBeLessThanOrEqual(30_000);
    }
    expect(retry.providerRetryBackoffMs(0, 4, 30_000)).toBe(0);
    expect(retry.providerRetryBackoffMs(2_000, NaN, 30_000)).toBe(2_000);
  });
});

describe("timer-safe retry waits", () => {
  it("omits timers for nonpositive or nonfinite waits", () => {
    for (const value of [0, -5, NaN, Infinity]) expect(retry.retryWaitSlices(value)).toEqual([]);
  });

  it("preserves ordinary and fractional waits", () => {
    expect(retry.retryWaitSlices(2_500)).toEqual([2_500]);
    expect(retry.retryWaitSlices(0.4)).toEqual([1]);
    expect(retry.retryWaitSlices(retry.PROVIDER_RETRY_MAX_TIMER_DELAY_MS))
      .toEqual([retry.PROVIDER_RETRY_MAX_TIMER_DELAY_MS]);
  });

  it("splits a long wait without losing time or overflowing a timer", () => {
    const total = retry.PROVIDER_RETRY_MAX_TIMER_DELAY_MS * 2 + 500;
    const slices = retry.retryWaitSlices(total);
    expect(slices).toHaveLength(3);
    expect(slices.every((slice) => slice <= retry.PROVIDER_RETRY_MAX_TIMER_DELAY_MS)).toBe(true);
    expect(slices.reduce((sum, slice) => sum + slice, 0)).toBe(total);
  });
});
