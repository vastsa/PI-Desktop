import { X509Certificate } from "node:crypto";
import * as tls from "node:tls";

/**
 * Explicit, additive default CA set for the sidecar (#1187).
 *
 * `--use-system-ca` is documented as additive: bundled roots, plus the system
 * store, plus `NODE_EXTRA_CA_CERTS`. On the Electron 43 macOS build the flag
 * instead replaces the bundled Mozilla roots with the enumerated system set,
 * and that enumeration misses public anchors it should include — a chain
 * anchored at GlobalSign Root CA - R3 fails with `UNABLE_TO_GET_ISSUER_CERT`
 * while the same runtime without the flag verifies it. Homebrew's stock Node
 * 24 with the same flag verifies the same chain, so the divergence is in the
 * Electron build, not Node's contract.
 *
 * Reproducing the documented additive semantics here keeps every trust source
 * the app promised (ADR: sidecar uses the OS trust store): bundled roots stay,
 * locally installed inspection roots still enter through the system store,
 * and an inherited `NODE_EXTRA_CA_CERTS` still lands in the `extra` set.
 * Certificate chain, expiration and hostname validation are untouched — this
 * widens the trust set, it never disables verification.
 *
 * The OS stores are a cache, so they keep entries that already expired: Windows
 * still lists Let's Encrypt's `ISRG Root X2` and `R3` with a 2025-09-15 expiry
 * long after the fact. Merging one of those makes OpenSSL accept an expired
 * certificate as the anchor for any chain that names it as issuer, and the
 * handshake then fails with `CERT_HAS_EXPIRED` even though the server's own
 * chain is valid and reaches a current root. An anchor that has already
 * expired can verify nothing, so it is never merged.
 */
function isExpiredCertificate(pem: string, now: number): boolean {
  try {
    return new Date(new X509Certificate(pem).validTo).getTime() <= now;
  } catch {
    // Unparseable input is left to the runtime: dropping it would silently
    // narrow the trust set this function exists to widen.
    return false;
  }
}

export function filterUnexpiredSystemCertificates(
  certificates: readonly string[],
  now: number,
): string[] {
  return certificates.filter((certificate) => !isExpiredCertificate(certificate, now));
}

export function applyAdditiveDefaultCaCertificates(): void {
  if (typeof tls.setDefaultCACertificates !== "function") return;
  const bundled = tls.getCACertificates("bundled");
  const extra = tls.getCACertificates("extra");
  const system = tls.getCACertificates("system");
  if (system.length === 0) return;
  const seen = new Set(bundled.map((cert) => cert));
  const merged = [...bundled, ...extra.filter((cert) => !seen.has(cert))];
  for (const cert of filterUnexpiredSystemCertificates(system, Date.now())) {
    if (seen.has(cert)) continue;
    seen.add(cert);
    merged.push(cert);
  }
  try {
    tls.setDefaultCACertificates(merged);
  } catch (error) {
    // A rejection here leaves the runtime default (the flag's outcome) in
    // place; say so once on stderr instead of failing the sidecar.
    process.stderr.write(
      `[agent-sidecar] default CA merge failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
  }
}
