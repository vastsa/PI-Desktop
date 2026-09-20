/** Certificate validation failures, not every TLS handshake/protocol failure. */
const CERTIFICATE_VERIFICATION_CODES: ReadonlySet<string> = new Set([
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CERT_REVOKED",
  "CERT_UNTRUSTED",
  "CERT_REJECTED",
  "CERT_SIGNATURE_FAILURE",
  "INVALID_CA",
  "INVALID_PURPOSE",
  "PATH_LENGTH_EXCEEDED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

/** Shared by transport recovery and localized error presentation. */
export function isCertificateVerificationError(code: unknown): boolean {
  return typeof code === "string" && CERTIFICATE_VERIFICATION_CODES.has(code);
}
