import { describe, expect, it } from "vitest";
import {
  normalizeProviderRetryInitialDelayMs,
  normalizeProviderRetryMaxAttempts,
  PROVIDER_RETRY_INITIAL_DELAY_MS,
  PROVIDER_RETRY_MAX_RETRIES,
} from "./provider-retry.js";

describe("provider retry settings normalization", () => {
  it("passes through non-negative integers unchanged", () => {
    expect(normalizeProviderRetryMaxAttempts(0)).toBe(0);
    expect(normalizeProviderRetryMaxAttempts(1)).toBe(1);
    expect(normalizeProviderRetryMaxAttempts(10_000)).toBe(10_000);
    expect(normalizeProviderRetryInitialDelayMs(0)).toBe(0);
    expect(normalizeProviderRetryInitialDelayMs(2_000)).toBe(2_000);
    expect(normalizeProviderRetryInitialDelayMs(600_000)).toBe(600_000);
  });

  it("floors fractional values instead of rejecting them", () => {
    expect(normalizeProviderRetryMaxAttempts(2.9)).toBe(2);
    expect(normalizeProviderRetryInitialDelayMs(1_500.9)).toBe(1_500);
  });

  it("falls back for absent, NaN, and negative values", () => {
    for (const value of [undefined, Number.NaN]) {
      expect(normalizeProviderRetryMaxAttempts(value)).toBeUndefined();
      expect(normalizeProviderRetryInitialDelayMs(value)).toBeUndefined();
    }
    expect(normalizeProviderRetryMaxAttempts(-1)).toBeUndefined();
    expect(normalizeProviderRetryInitialDelayMs(-2_000)).toBeUndefined();
  });

  it("ships the documented defaults", () => {
    expect(PROVIDER_RETRY_MAX_RETRIES).toBe(10);
    expect(PROVIDER_RETRY_INITIAL_DELAY_MS).toBe(2_000);
  });
});
