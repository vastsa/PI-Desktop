/**
 * Provider/model error classification for the agent path.
 *
 * pi-ai folds provider failures into `errorMessage` strings (often
 * "<status>: <body>") and SDK error objects carry the HTTP status under
 * shape-specific fields, so classification probes structured fields first and
 * falls back to message keywords. Used by both the stream (stopReason
 * "error") and the rejected-promise paths.
 */

import { isCertificateVerificationError } from "@pi-desktop/shared";
import { readLocalRequestErrorDetails } from "./local-request-errors.js";

export type ClassifiedAgentError = {
  code: string;
  message: string;
  retriable: boolean;
  /** Safe, low-cardinality diagnostics for logs and the error details panel. */
  details?: Record<string, unknown>;
  /** Local-only original failure; non-enumerable so UI/JSON never receives it. */
  cause?: unknown;
};

/** Keep envelopes/persisted rows small; provider bodies can be huge. */
const MAX_ERROR_MESSAGE_CHARS = 600;

const NETWORK_PATTERN =
  /ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EPIPE|ENETUNREACH|EHOSTUNREACH|UND_ERR|fetch failed|socket hang up|network error|connection error|connection refused|dns/i;

const CONTEXT_PATTERN =
  /context[ _-]?length|maximum context|context window|too many tokens|prompt is too long|input token count|exceeds the (?:maximum|model)|token limit/i;

const STREAM_TERMINATION_PATTERN =
  /\bterminated\b|stream ended without finish_reason|premature(?:ly)?\s+(?:closed|ended)|(?:stream|response).*(?:closed|interrupted)/i;

/** An adapter refusing a request option, e.g. "Custom fetch is not supported
 * by the Google Generative AI adapter" (issue #1072). */
const UNSUPPORTED_ADAPTER_OPTION_PATTERN = /is not supported by the .{0,60}adapter/i;

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

/**
 * Coarse transport layer behind a `NETWORK_ERROR`. Deliberately low-cardinality:
 * it answers "which layer failed" — name lookup, TLS handshake, connect, a
 * timeout, a connection that opened and then died, the proxy — without
 * inventing a user-visible error code per cause (and therefore without an i18n
 * string per cause).
 */
export type NetworkFailureCategory =
  | "dns"
  | "tls"
  | "timeout"
  | "refused"
  | "unreachable"
  | "reset"
  | "proxy"
  | "unknown";

export type NetworkFailure = {
  category: NetworkFailureCategory;
  /** errno-style code from the cause chain, e.g. ENOTFOUND or UND_ERR_SOCKET. */
  code?: string;
  /** Node syscall that failed, e.g. getaddrinfo, connect, read. */
  syscall?: string;
  /** Bare hostname only; never a URL, port, path, query or credentials. */
  hostname?: string;
};

/** errno-ish shapes only, so provider/proxy free text can never pass through. */
const SAFE_NETWORK_CODE_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;
const SAFE_NETWORK_SYSCALL_PATTERN = /^[a-z][a-z_]{0,31}$/;
/**
 * A hostname, not a URL: only letters, digits, dots and inner hyphens may
 * appear, so `user:pass@host`, `host:8080`, `https://host/path?k=v`, IPv6
 * literals and any path/query text can never match.
 */
const SAFE_HOSTNAME_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
/**
 * A hostname read out of the *message* is untrusted text, so it additionally
 * has to be dotted: a bare API-key-shaped token, or the `user` left over when
 * `getaddrinfo ENOTFOUND user:pass@host` is truncated at the colon, is not a
 * hostname and must not be reported as one.
 */
const SAFE_MESSAGE_HOSTNAME_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

const NETWORK_CATEGORY_PATTERNS: ReadonlyArray<
  readonly [RegExp, NetworkFailureCategory]
> = [
  // Anchored on the code, not on any occurrence of "proxy" inside it, so a
  // provider body word cannot be read as a proxy layer.
  [/(?:^|_)PROXY(?:_|$)|^EPROXY/i, "proxy"],
  [/^(?:ENOTFOUND|EAI_(?:AGAIN|FAIL|NODATA|NONAME))$|^ERR_DNS_/i, "dns"],
  [
    /(?:^|_)(?:CERT|TLS|SSL)(?:_|$)|^EPROTO$|^UNABLE_TO_|^HPE_|^CERT_|^DEPTH_ZERO_SELF_SIGNED_CERT$|^SELF_SIGNED_CERT_IN_CHAIN$/i,
    "tls",
  ],
  [/^(?:ETIMEDOUT|ESOCKETTIMEDOUT|ETIME)$|TIMEOUT$/i, "timeout"],
  [/^ECONNREFUSED$/i, "refused"],
  [
    /^(?:ENETUNREACH|EHOSTUNREACH|ENETDOWN|EHOSTDOWN|EADDRNOTAVAIL|ENONET)$/i,
    "unreachable",
  ],
  [
    /^(?:ECONNRESET|ECONNABORTED|EPIPE|ERR_STREAM_PREMATURE_CLOSE|UND_ERR_SOCKET|UND_ERR_CLOSED)$/i,
    "reset",
  ],
];

function networkCategoryForCode(
  code: string,
): NetworkFailureCategory | undefined {
  if (isCertificateVerificationError(code)) return "tls";
  for (const [pattern, category] of NETWORK_CATEGORY_PATTERNS) {
    if (pattern.test(code)) return category;
  }
  return undefined;
}

/**
 * A concrete certificate rejection wins over a generic socket/proxy wrapper:
 * retrying cannot repair trust. Otherwise prefer the proxy layer's own code.
 */
function pickNetworkCode(codes: readonly string[]): {
  code?: string;
  category?: NetworkFailureCategory;
} {
  const certificate = codes.find(isCertificateVerificationError);
  if (certificate) return { code: certificate, category: "tls" };
  for (const candidate of codes) {
    if (networkCategoryForCode(candidate) === "proxy") {
      return { code: candidate, category: "proxy" };
    }
  }
  for (const candidate of codes) {
    const category = networkCategoryForCode(candidate);
    if (category !== undefined) return { code: candidate, category };
  }
  return { code: codes.find((candidate) => NETWORK_PATTERN.test(candidate)) };
}

/**
 * Last resort when no errno survived: classify by wording. Order matters —
 * "proxy" outranks the transport wording it usually wraps.
 */
function networkCategoryFromText(text: string): NetworkFailureCategory {
  if (/proxy|tunnel/i.test(text)) return "proxy";
  if (/getaddrinfo|ENOTFOUND|EAI_AGAIN|dns|name resolution/i.test(text)) {
    return "dns";
  }
  if (
    /certificate|self[- ]signed|(?:^|[^a-z])(?:tls|ssl)(?:[^a-z]|$)|EPROTO|handshake/i.test(
      text,
    )
  ) {
    return "tls";
  }
  if (/timed?\s?out|timeout/i.test(text)) return "timeout";
  if (/ECONNREFUSED|connection refused/i.test(text)) return "refused";
  if (/ENETUNREACH|EHOSTUNREACH|no route to host|unreachable/i.test(text)) {
    return "unreachable";
  }
  if (
    /ECONNRESET|ECONNABORTED|EPIPE|socket hang up|premature close|reset by peer|connection (?:was )?(?:closed|lost|reset)/i.test(
      text,
    )
  ) {
    return "reset";
  }
  return "unknown";
}

/** Every field is validated against a strict shape; no raw text is retained. */
function networkDetailFields(network: NetworkFailure): Record<string, unknown> {
  return {
    networkCategory: network.category,
    ...(network.code ? { networkCode: network.code } : {}),
    ...(network.syscall ? { networkSyscall: network.syscall } : {}),
    ...(network.hostname ? { networkHost: network.hostname } : {}),
  };
}

/**
 * Summarize the transport failure behind a network error for the log record and
 * the error details. The cause chain is where node/undici keep the real errno
 * (`fetch failed` alone names nothing), including undici's happy-eyeballs
 * `AggregateError.errors`; pi-ai also flattens causes into `errorMessage`, so a
 * bare "getaddrinfo ENOTFOUND host" string has to yield the same fields.
 */
export function describeNetworkFailure(
  err: unknown,
  message: string,
): NetworkFailure {
  const codes: string[] = [];
  const seen = new Set<unknown>();
  let syscall: string | undefined;
  let hostname: string | undefined;

  const visit = (node: unknown, depth: number): void => {
    if (depth > 5 || seen.size > 12) return;
    if (!node || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    const record = node as Record<string, unknown>;
    if (
      typeof record.code === "string" &&
      SAFE_NETWORK_CODE_PATTERN.test(record.code)
    ) {
      codes.push(record.code);
    }
    if (
      syscall === undefined &&
      typeof record.syscall === "string" &&
      SAFE_NETWORK_SYSCALL_PATTERN.test(record.syscall)
    ) {
      syscall = record.syscall;
    }
    if (hostname === undefined) {
      for (const key of ["hostname", "host"]) {
        const value = record[key];
        if (typeof value === "string" && SAFE_HOSTNAME_PATTERN.test(value)) {
          hostname = value;
          break;
        }
      }
    }
    visit(record.cause, depth + 1);
    if (Array.isArray(record.errors)) {
      for (const child of record.errors.slice(0, 4)) visit(child, depth + 1);
    }
  };
  visit(err, 0);

  // The message is untrusted provider text, so a candidate must look like an
  // errno (bounded, errno-shaped) before it can be reported; the object chain
  // above is probed first and its codes are kept.
  for (const match of message.matchAll(
    /\b[A-Z][A-Z0-9_]{2,63}\b/g,
  )) {
    if (codes.length >= 16) break;
    if (networkCategoryForCode(match[0]) !== undefined || NETWORK_PATTERN.test(match[0])) {
      codes.push(match[0]);
    }
  }
  if (hostname === undefined) {
    const dnsHost = message.match(
      /(?:ENOTFOUND|EAI_AGAIN|EAI_NONAME|EAI_FAIL)\s+([A-Za-z0-9][A-Za-z0-9.-]{0,252})/,
    );
    if (dnsHost && SAFE_MESSAGE_HOSTNAME_PATTERN.test(dnsHost[1])) {
      hostname = dnsHost[1];
    }
  }

  const picked = pickNetworkCode(codes);
  return {
    category: picked.category ?? networkCategoryFromText(message),
    ...(picked.code ? { code: picked.code } : {}),
    ...(syscall ? { syscall } : {}),
    ...(hostname ? { hostname } : {}),
  };
}

/**
 * Network diagnosis for a caller that still holds the rejected request's Error.
 *
 * `classifyAgentError` normally sees pi-ai's flattened `errorMessage`, so an
 * errno that only lives in `error.cause` is invisible to it and `fetch failed`
 * collapses to `networkCategory: "unknown"` (issue #234). The fetch wrapper in
 * `provider-retry.ts` is the last layer that still sees the original object, so
 * it describes the cause chain there and hands these validated fields to the
 * runtime. The fields come from `describeNetworkFailure`, so a captured cause is
 * exactly as narrow as a classified one: an errno-shaped code, a lowercase
 * syscall, and a bare hostname — never a URL, port, path, query, or credential.
 */
export function networkFailureDiagnostics(
  err: unknown,
  message: string,
): { category: NetworkFailureCategory; fields: Record<string, unknown> } {
  const network = describeNetworkFailure(err, message);
  return { category: network.category, fields: networkDetailFields(network) };
}

export function classifyAgentError(err: unknown): ClassifiedAgentError {
  const envelope = err !== null && typeof err === "object"
    ? err as Record<string, unknown> : undefined;
  const local = readLocalRequestErrorDetails(err);
  // Cancellation outranks local diagnostics: pi-ai wraps a synchronous AbortError
  // that fired before `signal.aborted` flipped in a LocalRequestError, whose own
  // name says nothing about it, so the marker's preserved cause name is the only
  // trace of the user's Stop — the same field the runtime reads off a settled
  // message.
  const explicitlyAborted =
    (err instanceof Error && err.name === "AbortError") ||
    envelope?.stopReason === "aborted" ||
    local?.causeName === "AbortError";
  if (local && !explicitlyAborted) {
    // Local preparation cannot be repaired by provider retries. Keep the
    // original chain in-process, but never copy its payload/message/stack to UI.
    const classified: ClassifiedAgentError = {
      code: "INTERNAL",
      message: local.message,
      retriable: false,
      details: {
        origin: "local",
        phase: local.phase,
        ...(local.causeName ? { causeName: local.causeName } : {}),
      },
    };
    return Object.defineProperty(classified, "cause", { value: err });
  }
  const rawMessage =
    typeof err === "string"
      ? err
      : err instanceof Error
        ? err.message
        : typeof envelope?.errorMessage === "string"
          ? envelope.errorMessage
          : envelope?.role === "assistant"
            ? "provider stream failed"
            : String(err);
  const safeMessage = local && explicitlyAborted
    ? "Request aborted" : redactSensitiveErrorText(rawMessage);
  const message =
    safeMessage.length > MAX_ERROR_MESSAGE_CHARS
      ? `${safeMessage.slice(0, MAX_ERROR_MESSAGE_CHARS)}…`
      : safeMessage;
  const status = extractStatus(err, rawMessage);
  const providerCode = extractErrorCode(err);
  const details: Record<string, unknown> = {
    ...(status !== undefined ? { providerStatus: status } : {}),
    ...(providerCode !== undefined ? { providerCode } : {}),
  };
  const result = (
    code: string,
    retriable: boolean,
    extra?: Record<string, unknown>,
  ): ClassifiedAgentError => {
    const merged = { ...details, ...extra };
    // `extractErrorCode` walks the cause chain, so a network failure usually
    // repeats its own transport errno as `providerCode`. Keep the
    // network-namespaced key and drop the duplicate instead of logging one
    // string twice.
    if (
      merged.networkCode !== undefined &&
      merged.networkCode === merged.providerCode
    ) {
      delete merged.providerCode;
    }
    return {
      code,
      message,
      retriable,
      ...(Object.keys(merged).length > 0 ? { details: merged } : {}),
    };
  };

  // An abort wins over every other classification: a user Stop that lands
  // while a checkpoint is being summarized fails the compaction with an abort
  // cause, and that turn must read as stopped, not as a compaction failure.
  if (
    explicitlyAborted ||
    /\babort/i.test(rawMessage)
  ) {
    return result("TURN_ABORTED", false);
  }
  if (/CONTEXT_COMPACTION_FAILED/i.test(rawMessage)) {
    return result("CONTEXT_COMPACTION_FAILED", false);
  }
  // Network failures never carry an HTTP status; probe before status logic so
  // "fetch failed" causes don't fall through to the generic bucket. The cause
  // chain is summarized as a coarse category plus the transport errno, so the
  // failing layer is identifiable without a user-visible code per layer.
  const network = describeNetworkFailure(err, rawMessage);
  const certificateFailure = isCertificateVerificationError(network.code);
  if (hasNetworkCause(err, rawMessage) || (status === undefined && certificateFailure)) {
    return result(
      "NETWORK_ERROR",
      !certificateFailure,
      networkDetailFields(network),
    );
  }

  // The adapter itself refuses how the request was built, so re-sending it
  // produces the identical failure. Probed before the status table so a status
  // some layer attached to the same message cannot re-arm the retry budget.
  if (UNSUPPORTED_ADAPTER_OPTION_PATTERN.test(rawMessage)) {
    return result("PROVIDER_ERROR", false);
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
