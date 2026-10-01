import { X509Certificate } from "node:crypto";
import * as tls from "node:tls";
import { expect, it } from "vitest";
import { applyAdditiveDefaultCaCertificates } from "./system-ca.js";

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
