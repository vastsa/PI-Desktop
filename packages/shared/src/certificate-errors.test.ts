import { expect, it } from "vitest";
import { isCertificateVerificationError } from "./certificate-errors.js";

it("recognizes explicit certificate failures without treating all TLS errors as terminal", () => {
  for (const code of ["SELF_SIGNED_CERT_IN_CHAIN", "CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID"]) {
    expect(isCertificateVerificationError(code)).toBe(true);
  }
  for (const code of ["EPROTO", "ERR_SSL_PROTOCOL_ERROR", "UND_ERR_SOCKET", "ENOTFOUND"]) {
    expect(isCertificateVerificationError(code)).toBe(false);
  }
});

it("rejects malformed or free-text persisted diagnostics", () => {
  for (const value of [null, undefined, 1, {}, ["CERT_HAS_EXPIRED"], "certificate failed", "cert_has_expired"]) {
    expect(isCertificateVerificationError(value)).toBe(false);
  }
});
