/**
 * Provider/model error classification for the agent path.
 *
 * pi-ai folds provider failures into `errorMessage` strings (often
 * "<status>: <body>") and SDK error objects carry the HTTP status under
 * shape-specific fields, so classification probes structured fields first and
 * falls back to message keywords. Used by both the stream (stopReason
 * "error") and the rejected-promise paths.
 */

export type ClassifiedAgentError = {
  code: string;
  message: string;
  retriable: boolean;
  /** Safe, low-cardinality diagnostics for logs and the error details panel. */
  details?: Record<string, unknown>;
};

/** Keep envelopes/persisted rows small; provider bodies can be huge. */
const MAX_ERROR_MESSAGE_CHARS = 600;

const NETWORK_PATTERN =
  /ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EPIPE|ENETUNREACH|EHOSTUNREACH|UND_ERR|fetch failed|socket hang up|network error|connection error|connection refused|dns/i;

const CONTEXT_PATTERN =
  /context[ _-]?length|maximum context|context window|too many tokens|prompt is too long|input token count|exceeds the (?:maximum|model)|token limit/i;

const STREAM_TERMINATION_PATTERN =
  /\bterminated\b|stream ended without finish_reason|premature(?:ly)?\s+(?:closed|ended)|(?:stream|response).*(?:closed|interrupted)/i;

function redactSensitiveErrorText(message: string): string {
  return message
    .replace(
      /(["']?authorization["']?\s*[:=]\s*["']?\s*bearer\s+)[^\s,"'}]+/gi,
      "$1[REDACTED]",
    )
    .replace(
      /(["']?(?:api[_-]?key|access[_-]?token|password)["']?\s*[:=]\s*["']?)[^"',}\s]+/gi,
      "$1[REDACTED]",
    )
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

/**
 * Probe the HTTP status across SDK error shapes: `status`/`statusCode`
 * fields (walking the `cause` chain), then a leading "<status>:" or a
 * "(status)" / "status code NNN" marker in the message.
 */
function extractStatus(err: unknown, message: string): number | undefined {
  let current: any = err;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (typeof current.statusCode === "number") return current.statusCode;
    if (typeof current.status === "number") return current.status;
    current = current.cause;
  }
  const patterns = [
    /^\s*(\d{3})\s*:/,
    /^\s*(\d{3})\b/,
    /\((\d{3})\)/,
    /status(?: code)?[ :]+(\d{3})\b/i,
  ];
  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (match) {
      const status = Number(match[1]);
      if (status >= 400 && status < 600) return status;
    }
  }
  return undefined;
}

function hasNetworkCause(err: unknown, message: string): boolean {
  if (NETWORK_PATTERN.test(message)) return true;
  let current: any = err;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    const code = typeof current.code === "string" ? current.code : "";
    const msg = current instanceof Error ? current.message : "";
    if (NETWORK_PATTERN.test(code) || NETWORK_PATTERN.test(msg)) return true;
    current = current.cause;
  }
  return false;
}

function extractErrorCode(err: unknown): string | number | undefined {
  let current: any = err;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (typeof current.code === "number") {
      return Number.isSafeInteger(current.code) ? current.code : undefined;
    }
    if (
      typeof current.code === "string" &&
      /^[A-Za-z0-9_.:-]{1,64}$/.test(current.code)
    ) {
      return current.code;
    }
    current = current.cause;
  }
  return undefined;
}

export function classifyAgentError(err: unknown): ClassifiedAgentError {
  const rawMessage =
    typeof err === "string"
      ? err
      : err instanceof Error
        ? err.message
        : String(err);
  const safeMessage = redactSensitiveErrorText(rawMessage);
  const message =
    safeMessage.length > MAX_ERROR_MESSAGE_CHARS
      ? `${safeMessage.slice(0, MAX_ERROR_MESSAGE_CHARS)}…`
      : safeMessage;
  const status = extractStatus(err, rawMessage);
  const providerCode = extractErrorCode(err);
  const details = {
    ...(status !== undefined ? { providerStatus: status } : {}),
    ...(providerCode !== undefined ? { providerCode } : {}),
  };
  const result = (code: string, retriable: boolean): ClassifiedAgentError => ({
    code,
    message,
    retriable,
    ...(Object.keys(details).length > 0 ? { details } : {}),
  });

  if (/CONTEXT_COMPACTION_FAILED/i.test(rawMessage)) {
    return result("CONTEXT_COMPACTION_FAILED", false);
  }
  if (
    (err instanceof Error && err.name === "AbortError") ||
    /\babort/i.test(rawMessage)
  ) {
    return result("TURN_ABORTED", false);
  }
  // Network failures never carry an HTTP status; probe before status logic so
  // "fetch failed" causes don't fall through to the generic bucket.
  if (hasNetworkCause(err, rawMessage)) {
    return result("NETWORK_ERROR", true);
  }

  if (status !== undefined) {
    if (status === 401 || status === 403) return result("PROVIDER_UNAUTHORIZED", false);
    if (status === 408) return result("TIMEOUT", true);
    if (status === 413) return result("CONTEXT_TOO_LARGE", false);
    if (status === 429) return result("PROVIDER_RATE_LIMITED", true);
    if (status === 404) return result("MODEL_NOT_CONFIGURED", false);
    if (status >= 500) return result("PROVIDER_ERROR", true);
    if (status === 400 || status === 422) {
      if (CONTEXT_PATTERN.test(rawMessage)) return result("CONTEXT_TOO_LARGE", false);
      // Malformed request (wrong apiStyle, bad params) — retrying won't help.
      return result("PROVIDER_ERROR", false);
    }
    return result("PROVIDER_ERROR", true);
  }

  if (/invalid[ _]api[ _]key|api key not valid|unauthorized|authentication|permission denied/i.test(rawMessage)) {
    return result("PROVIDER_UNAUTHORIZED", false);
  }
  if (/rate.?limit|too many requests|quota|overloaded/i.test(rawMessage)) {
    return result("PROVIDER_RATE_LIMITED", true);
  }
  if (CONTEXT_PATTERN.test(rawMessage)) {
    return result("CONTEXT_TOO_LARGE", false);
  }
  if (/model.{0,20}(not found|does not exist|unknown)|unknown model/i.test(rawMessage)) {
    return result("MODEL_NOT_CONFIGURED", false);
  }
  if (/timeout|timed out/i.test(rawMessage)) {
    return result("TIMEOUT", true);
  }
  if (STREAM_TERMINATION_PATTERN.test(rawMessage) || /stream/i.test(rawMessage)) {
    return result("STREAM_FAILED", true);
  }
  return result("PROVIDER_ERROR", true);
}
