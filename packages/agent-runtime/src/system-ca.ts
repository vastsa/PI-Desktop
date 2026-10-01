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
 */
export function applyAdditiveDefaultCaCertificates(): void {
  if (typeof tls.setDefaultCACertificates !== "function") return;
  const bundled = tls.getCACertificates("bundled");
  const extra = tls.getCACertificates("extra");
  const system = tls.getCACertificates("system");
  if (system.length === 0) return;
  const seen = new Set(bundled.map((cert) => cert));
  const merged = [...bundled, ...extra.filter((cert) => !seen.has(cert))];
  for (const cert of system) {
    if (!seen.has(cert)) {
      seen.add(cert);
      merged.push(cert);
    }
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
