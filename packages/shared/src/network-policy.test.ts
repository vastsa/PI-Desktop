import { describe, expect, it } from "vitest";
import {
  DEFAULT_NETWORK_POLICY,
  allowInsecureUserEndpoints,
  isRelaxedNetworkPolicy,
  needsInsecureEndpointNotice,
  normalizeNetworkPolicy,
  validateNetworkPolicy,
} from "./network-policy.js";

describe("normalizeNetworkPolicy", () => {
  it("defaults to the relaxed mode", () => {
    expect(DEFAULT_NETWORK_POLICY.mode).toBe("relaxed");
    expect(normalizeNetworkPolicy(undefined)).toEqual({ mode: "relaxed" });
    expect(normalizeNetworkPolicy({})).toEqual({ mode: "relaxed" });
  });

  it("keeps a stored mode and the one-time notice flag", () => {
    expect(normalizeNetworkPolicy({ mode: "strict" })).toEqual({ mode: "strict" });
    expect(normalizeNetworkPolicy({ mode: "relaxed", insecureNoticeAcknowledged: true })).toEqual({
      mode: "relaxed",
      insecureNoticeAcknowledged: true,
    });
  });

  it("migrates the pre-mode plaintext flag", () => {
    // A build before the mode existed stored one bare flag. Its `false` is the
    // user's own answer and survives as `strict`; `true` means the default.
    expect(normalizeNetworkPolicy({ allowInsecureUserEndpoints: false })).toEqual({
      mode: "strict",
    });
    expect(normalizeNetworkPolicy({ allowInsecureUserEndpoints: true })).toEqual({
      mode: "relaxed",
    });
    // An explicit mode wins over the legacy key.
    expect(
      normalizeNetworkPolicy({ mode: "strict", allowInsecureUserEndpoints: true }),
    ).toEqual({ mode: "strict" });
  });

  it("drops unusable values", () => {
    expect(normalizeNetworkPolicy({ mode: "loose" })).toEqual({ mode: "relaxed" });
    expect(normalizeNetworkPolicy({ insecureNoticeAcknowledged: "yes" })).toEqual({
      mode: "relaxed",
    });
    expect(normalizeNetworkPolicy("strict")).toEqual({ mode: "relaxed" });
  });
});

describe("validateNetworkPolicy", () => {
  it("accepts an absent section and a well-formed one", () => {
    expect(validateNetworkPolicy(undefined)).toEqual({
      ok: true,
      value: { mode: "relaxed" },
    });
    expect(validateNetworkPolicy({ mode: "strict" })).toEqual({
      ok: true,
      value: { mode: "strict" },
    });
    expect(validateNetworkPolicy({ mode: "relaxed", insecureNoticeAcknowledged: true })).toEqual({
      ok: true,
      value: { mode: "relaxed", insecureNoticeAcknowledged: true },
    });
  });

  it("refuses a non-object, an unknown mode and a non-boolean flag", () => {
    expect(validateNetworkPolicy([]).ok).toBe(false);
    expect(validateNetworkPolicy("networkPolicy").ok).toBe(false);
    expect(validateNetworkPolicy({ mode: "loose" }).ok).toBe(false);
    expect(validateNetworkPolicy({ insecureNoticeAcknowledged: 1 }).ok).toBe(false);
  });
});

describe("isRelaxedNetworkPolicy", () => {
  it("reads the section of a settings object and defaults to relaxed", () => {
    expect(isRelaxedNetworkPolicy({ networkPolicy: { mode: "relaxed" } })).toBe(true);
    expect(isRelaxedNetworkPolicy({ networkPolicy: { mode: "strict" } })).toBe(false);
    expect(isRelaxedNetworkPolicy({})).toBe(true);
    expect(isRelaxedNetworkPolicy(null)).toBe(true);
    // Only the section is read: nothing sets a top-level lookalike.
    expect(isRelaxedNetworkPolicy({ mode: "strict" })).toBe(true);
  });

  it("is the same reading as allowInsecureUserEndpoints", () => {
    const strict = { networkPolicy: { mode: "strict" as const } };
    expect(allowInsecureUserEndpoints(strict)).toBe(false);
    expect(allowInsecureUserEndpoints({})).toBe(true);
  });
});

describe("needsInsecureEndpointNotice", () => {
  it("owes the notice once, in the relaxed mode only", () => {
    expect(needsInsecureEndpointNotice({})).toBe(true);
    expect(
      needsInsecureEndpointNotice({
        networkPolicy: { mode: "relaxed", insecureNoticeAcknowledged: true },
      }),
    ).toBe(false);
    expect(needsInsecureEndpointNotice({ networkPolicy: { mode: "strict" } })).toBe(false);
  });
});
