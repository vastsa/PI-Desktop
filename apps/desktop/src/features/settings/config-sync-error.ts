const ERROR_KINDS = {
  AUTH: "auth",
  PERMISSION: "permission",
  NOT_FOUND: "notFound",
  CONFLICT: "conflict",
  QUOTA: "quota",
  RATE_LIMIT: "rateLimit",
  SERVER: "server",
  TIMEOUT: "network",
  NETWORK: "network",
  REDIRECT: "redirect",
  UNSUPPORTED: "unsupported",
  LOCKED: "locked",
  INVALID: "invalid",
  DECRYPT: "password",
  PASSWORD: "password",
  CRYPTO: "password",
  LIMIT_EXCEEDED: "limit",
} as const;

/** Map a host error to a stable recovery message. Server text stays opt-in. */
export function configSyncErrorKind(message: string): string {
  const code = /CONFIG_SYNC_([A-Z0-9_]+)/.exec(message)?.[1];
  return code && Object.hasOwn(ERROR_KINDS, code)
    ? ERROR_KINDS[code as keyof typeof ERROR_KINDS]
    : "unknown";
}
