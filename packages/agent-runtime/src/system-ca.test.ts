import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import * as tls from "node:tls";
import { expect, it } from "vitest";
import {
  applyAdditiveDefaultCaCertificates,
  filterUnexpiredSystemCertificates,
} from "./system-ca.js";

const certificateFixture = readFileSync(
  new URL("../../../scripts/e2e/fixtures/certificates/localhost-cert.pem", import.meta.url),
  "utf8",
);

// `setDefaultCACertificates` re-serializes its input, so later reads return
// strings that differ in encoding whitespace; identity is the certificate
// content, compared by SHA-256 fingerprint.
function fingerprints(certs: readonly string[]): Set<string> {
  return new Set(certs.map((cert) => new X509Certificate(cert).fingerprint256));
}

it("applyAdditiveDefaultCaCertificates keeps pre-existing default roots", () => {
  const before = fingerprints(tls.getCACertificates("default"));
  applyAdditiveDefaultCaCertificates();
  const after = fingerprints(tls.getCACertificates("default"));
  // The default set can only grow: every pre-existing root (bundled, extra,
  // or a flag-added system root) is preserved.
  for (const fingerprint of before) {
    expect(after.has(fingerprint)).toBe(true);
  }
});

it("applyAdditiveDefaultCaCertificates is idempotent", () => {
  applyAdditiveDefaultCaCertificates();
  const once = fingerprints(tls.getCACertificates("default")).size;
  applyAdditiveDefaultCaCertificates();
  const twice = fingerprints(tls.getCACertificates("default")).size;
  expect(twice).toBe(once);
});

it("applyAdditiveDefaultCaCertificates never adds an already expired system anchor", () => {
  const now = Date.now();
  const bundled = fingerprints(tls.getCACertificates("bundled"));
  const expiredSystem = tls
    .getCACertificates("system")
    .filter((pem) => {
      try {
        return new Date(new X509Certificate(pem).validTo).getTime() <= now;
      } catch {
        return false;
      }
    })
    .map((pem) => new X509Certificate(pem).fingerprint256);

  applyAdditiveDefaultCaCertificates();

  const after = fingerprints(tls.getCACertificates("default"));
  for (const fingerprint of expiredSystem) {
    // A bundled root that happens to be expired stays: the bundled set is the
    // runtime's own baseline. Only the system merge is filtered, because a
    // stale cache entry there can act as the anchor for a live chain.
    if (bundled.has(fingerprint)) continue;
    expect(after.has(fingerprint)).toBe(false);
  }
});

it("filters expired system certificates while retaining valid and unparseable entries", () => {
  const expiresAt = Date.parse(new X509Certificate(certificateFixture).validTo);
  const unparseable = "unparseable certificate";

  expect(
    filterUnexpiredSystemCertificates(
      [certificateFixture, unparseable],
      expiresAt - 1,
    ),
  ).toEqual([certificateFixture, unparseable]);
  expect(
    filterUnexpiredSystemCertificates(
      [certificateFixture, unparseable],
      expiresAt,
    ),
  ).toEqual([unparseable]);
});
