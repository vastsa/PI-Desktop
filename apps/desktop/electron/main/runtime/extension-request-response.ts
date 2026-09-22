/**
 * Response contract for the trusted-extension provider request surface
 * (extension-model-registry plan D6).
 *
 * An HTTP response — including 4xx and 5xx — is a **result**, not a host error:
 * the caller owns the protocol semantics, so translating a provider's 404 into
 * a PI error code would destroy information. Only host-side failures throw, and
 * they throw with a code (§5.4).
 *
 * A 3xx is never followed (`redirect: "manual"` is set by the request handler),
 * so the credential is never re-sent to a host the provider row did not name.
 */

import type { ExtensionProviderRequestResult } from "@pi-desktop/agent-runtime";
import { requestError } from "./extension-request-envelope";

/** D8: a larger body is rejected, never truncated. */
export const RESPONSE_BODY_MAX_BYTES = 4 * 1024 * 1024;

const TEXTUAL_MEDIA_TYPES: ReadonlySet<string> = new Set([
  "application/javascript",
  "application/x-www-form-urlencoded",
  "application/graphql",
  "application/xml",
]);

/** `Retry-After`, as milliseconds from now; absent when the header cannot be read. */
function retryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const at = Date.parse(value);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - Date.now());
}

/**
 * Headers a caller may see. `set-cookie` is stripped, and so is the credential
 * header the host applied — a provider that reflects it must not turn this API
 * into a way to read the user's key back out (D6).
 */
function responseHeaders(
  response: Response,
  credentialsHeader: string | undefined,
): Record<string, string> {
  const headers: Record<string, string> = {};
  const credential = credentialsHeader?.toLowerCase();
  response.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (lower === "set-cookie" || (credential && lower === credential)) return;
    headers[key] = value;
  });
  return headers;
}

function isTextual(mediaType: string): boolean {
  return (
    mediaType.startsWith("text/") ||
    mediaType.endsWith("+json") ||
    mediaType.endsWith("+xml") ||
    TEXTUAL_MEDIA_TYPES.has(mediaType)
  );
}

/**
 * Read the body under the cap, then decode it by content type: `json` when the
 * media type is JSON and parsing succeeds, `text` for textual types, `base64`
 * otherwise, always with the byte length.
 *
 * An oversized body throws `RESPONSE_TOO_LARGE` carrying the status and the
 * byte count that crossed the cap — the count observed, not a guess at the
 * total, which is exactly why the body is rejected instead of truncated.
 */
export async function readResponseBody(
  response: Response,
  maxBytes: number,
): Promise<{ kind: "json" | "text" | "base64"; value: unknown; bytes: number }> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw requestError(
      "RESPONSE_TOO_LARGE",
      "The response body exceeds the size cap",
      { status: response.status, bytes: declared },
    );
  }
  const chunks: Uint8Array[] = [];
  let seen = 0;
  const reader = response.body?.getReader();
  if (reader) {
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        seen += part.value.length;
        if (seen > maxBytes) {
          throw requestError(
            "RESPONSE_TOO_LARGE",
            "The response body exceeds the size cap",
            { status: response.status, bytes: seen },
          );
        }
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  const contentType = response.headers.get("content-type") ?? "";
  const [mediaType = ""] = contentType.split(";");
  const media = mediaType.trim().toLowerCase();
  const text = bytes.length ? bytes.toString("utf8") : "";
  if (media === "application/json" || media.endsWith("+json")) {
    try {
      return { kind: "json", value: JSON.parse(text), bytes: bytes.length };
    } catch {
      // A JSON media type whose body is not JSON is reported as text rather
      // than as a host error: the caller owns the protocol, and a provider that
      // mislabels its error page must not turn a result into a failure.
    }
  }
  if (isTextual(media) || media === "application/json") {
    return { kind: "text", value: text, bytes: bytes.length };
  }
  return {
    kind: "base64",
    value: bytes.toString("base64"),
    bytes: bytes.length,
  };
}

/**
 * The result the extension receives. `durationMs` is measured here so it covers
 * the whole request the caller asked for, including a redirect it must now
 * handle itself.
 */
export async function responseResult(options: {
  response: Response;
  /** The credential header the host applied, so it is never echoed back. */
  credentialsHeader?: string;
  startedAt: number;
  maxBytes?: number;
}): Promise<ExtensionProviderRequestResult> {
  const { response } = options;
  const body = await readResponseBody(
    response,
    options.maxBytes ?? RESPONSE_BODY_MAX_BYTES,
  );
  const contentType = response.headers.get("content-type") ?? undefined;
  const location = response.headers.get("location") ?? undefined;
  const retry = retryAfterMs(response.headers.get("retry-after"));
  return {
    status: response.status,
    ...(response.statusText ? { statusText: response.statusText } : {}),
    ok: response.ok,
    ...(contentType ? { contentType } : {}),
    headers: responseHeaders(response, options.credentialsHeader),
    body,
    ...(location ? { location } : {}),
    ...(retry !== undefined ? { retryAfterMs: retry } : {}),
    durationMs: Math.max(0, Date.now() - options.startedAt),
  };
}

/** The fields one audit row may carry; the emitter emits only those provided. */
export type ProviderRequestAuditEntry = {
  ok: boolean;
  sessionId: string;
  /** The session's contributing grants: what the gate accepted (plan D7). */
  pluginIds: string[];
  /** The plugin the brake is charged to — the owner of the claimed extension. */
  pluginId?: string;
  /** The claimed extension id; attribution only, never authority (plan D7). */
  extensionId?: string;
  ts: number;
  errorCode?: string;
  providerId?: string;
  modelId?: string;
  method?: string;
  /** The final request path, without its query (plan D10). */
  path?: string;
  status?: number;
  durationMs?: number;
  /** Multipart file count. */
  files?: number;
  /** The assembled request body, in bytes. */
  requestBytes?: number;
  /** The response body the caller received, in bytes. */
  responseBytes?: number;
};

/**
 * The audit row for one provider request, or for a gate decision that refused
 * one. One shape with two producers, so a refused call and a failed call are
 * comparable — and neither ever carries the query string (it can carry a
 * secret), a header value, a field value, or a credential (plan §12).
 */
export function providerRequestAudit(
  entry: ProviderRequestAuditEntry,
): Record<string, unknown> {
  return {
    api: "provider.request",
    ok: entry.ok,
    sessionId: entry.sessionId,
    pluginIds: entry.pluginIds,
    ...(entry.pluginId ? { pluginId: entry.pluginId } : {}),
    ...(entry.extensionId ? { extensionId: entry.extensionId } : {}),
    ts: entry.ts,
    ...(entry.errorCode ? { errorCode: entry.errorCode } : {}),
    ...(entry.providerId ? { providerId: entry.providerId } : {}),
    ...(entry.modelId ? { modelId: entry.modelId } : {}),
    ...(entry.status !== undefined ? { status: entry.status } : {}),
    ...(entry.method ? { method: entry.method } : {}),
    ...(entry.path ? { path: entry.path } : {}),
    ...(entry.durationMs !== undefined ? { durationMs: entry.durationMs } : {}),
    ...(entry.files !== undefined ? { files: entry.files } : {}),
    ...(entry.requestBytes !== undefined
      ? { requestBytes: entry.requestBytes }
      : {}),
    ...(entry.responseBytes !== undefined
      ? { responseBytes: entry.responseBytes }
      : {}),
  };
}
