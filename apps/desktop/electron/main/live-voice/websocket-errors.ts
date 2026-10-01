export function responseCodeError(status: number): { code: string; retriable: boolean } {
  if (status === 401) return { code: "LIVE_AUTH_REQUIRED", retriable: false };
  if (status === 403) return { code: "LIVE_ACCESS_DENIED", retriable: false };
  if (status === 429) return { code: "LIVE_RATE_LIMITED", retriable: true };
  if (status === 404 || status === 426) return { code: "LIVE_PROTOCOL_UNSUPPORTED", retriable: false };
  return { code: "LIVE_NETWORK_ERROR", retriable: status >= 500 };
}
