import assert from "node:assert/strict";
import test from "node:test";
import { liveVoiceErrorKey } from "../src/features/voice/live/live-voice-error.ts";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";

test("Live Voice distinguishes account access from microphone and transport failures", () => {
  const expected = {
    LIVE_AUTH_REQUIRED: "liveVoice.authRequired",
    LIVE_ACCOUNT_ID_MISSING: "liveVoice.authRequired",
    LIVE_ACCESS_DENIED: "liveVoice.accessDenied",
    LIVE_PROTOCOL_UNSUPPORTED: "liveVoice.protocolUnsupported",
    LIVE_AUTH_KIND_UNSUPPORTED: "liveVoice.readiness.wrong-auth-kind",
    LIVE_PROVIDER_NOT_FOUND: "liveVoice.providerUnavailable",
    LIVE_MICROPHONE_DENIED: "liveVoice.microphoneDenied",
    LIVE_MICROPHONE_BUSY: "liveVoice.microphoneBusy",
    LIVE_MICROPHONE_UNAVAILABLE: "liveVoice.microphoneUnavailable",
    LIVE_NETWORK_ERROR: "errors.NETWORK_ERROR",
    LIVE_RATE_LIMITED: "errors.PROVIDER_RATE_LIMITED",
    LIVE_TIMEOUT: "errors.TIMEOUT",
    LIVE_TIMEOUT: "errors.TIMEOUT",
    LIVE_NETWORK_POLICY_UNSUPPORTED: "errors.NETWORK_POLICY_BLOCKED",
  };
  for (const [code, key] of Object.entries(expected)) {
    assert.equal(liveVoiceErrorKey(code), key);
    for (const [locale, catalog] of Object.entries(catalogs)) {
      assert.equal(typeof flattenCatalog(catalog)[key], "string", `${locale}: ${key}`);
    }
  }
});

test("unknown Live error codes do not expose provider text or inherited properties", () => {
  for (const code of ["unknown", "", "constructor", "__proto__", "toString", "secret-sentinel"]) {
    assert.equal(liveVoiceErrorKey(code), "liveVoice.errorGeneric");
  }
});
