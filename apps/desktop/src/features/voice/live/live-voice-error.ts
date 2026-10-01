const errorKeys: Record<string, string> = {
  LIVE_MICROPHONE_DENIED: "liveVoice.microphoneDenied",
  LIVE_MICROPHONE_BUSY: "liveVoice.microphoneBusy",
  LIVE_MICROPHONE_UNAVAILABLE: "liveVoice.microphoneUnavailable",
  LIVE_AUTH_REQUIRED: "liveVoice.authRequired",
  LIVE_ACCOUNT_ID_MISSING: "liveVoice.authRequired",
  LIVE_ACCESS_DENIED: "liveVoice.accessDenied",
  LIVE_PROTOCOL_UNSUPPORTED: "liveVoice.protocolUnsupported",
  LIVE_AUTH_KIND_UNSUPPORTED: "liveVoice.readiness.wrong-auth-kind",
  LIVE_PROVIDER_NOT_FOUND: "liveVoice.providerUnavailable",
  LIVE_RATE_LIMITED: "errors.PROVIDER_RATE_LIMITED",
  LIVE_NETWORK_ERROR: "errors.NETWORK_ERROR",
  LIVE_TIMEOUT: "errors.TIMEOUT",
  LIVE_NETWORK_POLICY_UNSUPPORTED: "errors.NETWORK_POLICY_BLOCKED",
};

export function liveVoiceErrorKey(code: string): string {
  return Object.hasOwn(errorKeys, code) ? errorKeys[code] : "liveVoice.errorGeneric";
}
