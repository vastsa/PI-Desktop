/**
 * Compact copy for a failed live model-list probe.
 *
 * The host forwards the raw fetch/HTTP/JSON error. Those strings are useful
 * for logs, not for the picker: a 401, a timeout, and an HTML 404 page must
 * not dump a stack or a document into the empty pane.
 */

export type ModelsFetchErrorKind =
  | "unauthorized"
  | "notFound"
  | "rateLimited"
  | "timeout"
  | "network"
  | "invalidResponse"
  | "http"
  | "unknown";

export type ModelsFetchErrorView = {
  kind: ModelsFetchErrorKind;
  /** i18n key for the one-line summary. */
  summaryKey: string;
  summaryParams?: Record<string, string | number>;
  /** Short technical remainder; omitted when it repeats the summary. */
  detail?: string;
};

const STATUS_RE =
  /\((\d{3})\)|\bHTTP\s+(\d{3})\b|\bstatus(?:\s*code)?[:\s]+(\d{3})\b/i;

function statusFrom(text: string): number | undefined {
  const match = text.match(STATUS_RE);
  if (!match) return undefined;
  const value = Number(match[1] ?? match[2] ?? match[3]);
  return Number.isInteger(value) ? value : undefined;
}

function sanitizeDetail(raw: string): string | undefined {
  const collapsed = raw.replace(/\s+/g, " ").trim();
  if (!collapsed) return undefined;
  if (collapsed.startsWith("<") || collapsed.length > 180) return undefined;
  if (/not valid JSON|Unexpected token|JSON\.parse/i.test(collapsed)) {
    return undefined;
  }
  return collapsed.length > 140 ? `${collapsed.slice(0, 140)}…` : collapsed;
}

export function describeModelsFetchError(raw?: string): ModelsFetchErrorView {
  const text = raw?.replace(/\s+/g, " ").trim() ?? "";
  if (!text) {
    return { kind: "unknown", summaryKey: "settings.modelsFetchFailed" };
  }

  const status = statusFrom(text);

  if (
    status === 401 ||
    status === 403 ||
    /\b(unauthorized|forbidden|invalid api key|api key (?:was )?rejected)\b/i.test(
      text,
    )
  ) {
    return { kind: "unauthorized", summaryKey: "errors.PROVIDER_UNAUTHORIZED" };
  }
  if (status === 404) {
    return { kind: "notFound", summaryKey: "settings.modelsFetchNotFound" };
  }
  if (status === 429) {
    return { kind: "rateLimited", summaryKey: "errors.PROVIDER_RATE_LIMITED" };
  }
  if (
    status === 408 ||
    /\b(aborted|abort(?:error)?|timed? ?out|timeout)\b/i.test(text)
  ) {
    return { kind: "timeout", summaryKey: "errors.TIMEOUT" };
  }
  if (
    /\b(failed to fetch|fetch failed|network(?:\s*error)?|ENOTFOUND|ECONNREFUSED|ECONNRESET|ERR_CONNECTION|CERT_|SSL)\b/i.test(
      text,
    )
  ) {
    return { kind: "network", summaryKey: "errors.NETWORK_ERROR" };
  }
  if (
    /not valid JSON|Unexpected token|Unexpected end of JSON|JSON\.parse|invalid json/i.test(
      text,
    )
  ) {
    return {
      kind: "invalidResponse",
      summaryKey: "settings.modelsFetchInvalidResponse",
    };
  }
  if (status && status >= 400) {
    return {
      kind: "http",
      summaryKey: "settings.modelsFetchFailedStatus",
      summaryParams: { status },
    };
  }
  return {
    kind: "unknown",
    summaryKey: "settings.modelsFetchFailed",
    detail: sanitizeDetail(text),
  };
}
