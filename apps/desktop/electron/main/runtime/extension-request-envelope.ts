/**
 * Request envelope for the trusted-extension provider request surface
 * (extension-model-registry plan, §5.3/§5.4, decisions D3–D5).
 *
 * This module is the security core of the feature and it is deliberately pure:
 * path joining, header composition and body assembly are plain functions over
 * values, so the §5.3 acceptance table is testable without a host, a provider,
 * or a socket. The one thing it does not do itself is read an uploaded file —
 * that read is injected, because containment and capping already have exactly
 * one implementation (`services/contained-file-reader.ts`).
 *
 * Nothing here interprets the protocol: the caller chose the path, so the host
 * contributes only the destination origin (D4) and the envelope it built (D3).
 */

import { randomUUID } from "node:crypto";
import {
  PROVIDER_REQUEST_DEFAULT_TIMEOUT_MS,
  PROVIDER_REQUEST_MAX_TIMEOUT_MS,
  type ExtensionProviderRequestMethod,
} from "@pi-desktop/agent-runtime";

/** §5.3: the caller's path, in bytes. */
export const REQUEST_PATH_MAX_BYTES = 2048;
/** D8: a JSON, text, or base64 payload. */
export const REQUEST_BODY_MAX_BYTES = 1024 * 1024;
/** D8: mirrors the shipped image-edit tiers, one step larger. */
export const MULTIPART_MAX_FILES = 8;
export const MULTIPART_FILE_MAX_BYTES = 32 * 1024 * 1024;
export const MULTIPART_TOTAL_MAX_BYTES = 64 * 1024 * 1024;
/** Text parts are metadata, not payloads; they stay far below the file caps. */
export const MULTIPART_MAX_FIELDS = 64;
export const MULTIPART_NAME_MAX_BYTES = 256;
export const MULTIPART_FIELD_MAX_BYTES = 256 * 1024;
export const MULTIPART_FIELDS_MAX_BYTES = 1024 * 1024;

export const REQUEST_TIMEOUT_FALLBACK_MS = PROVIDER_REQUEST_DEFAULT_TIMEOUT_MS;
export const REQUEST_TIMEOUT_MAX_MS = PROVIDER_REQUEST_MAX_TIMEOUT_MS;

const REQUEST_METHODS: ReadonlySet<string> = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);

/**
 * Caller headers the host refuses outright (D5). `normalizeProviderHeaders`
 * caps sizes and drops its own reserved keys silently, which is right for a
 * provider row the user typed but wrong for a caller: a refused header must be
 * reported, not quietly ignored. The secret-shaped keys pi's own adapters use
 * are included, because letting a caller inject `x-api-key` next to a
 * host-applied `authorization` would be credential forgery by another name.
 */
const RESERVED_CALLER_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "host",
  "content-length",
  "content-type",
  "connection",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  "keep-alive",
  "x-api-key",
  "api-key",
  "chatgpt-account-id",
]);

/** A header key per RFC 7230 `token`. */
const HEADER_KEY = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
/**
 * A multipart part name goes inside `name="…"`, so quotes are not allowed, and
 * a path separator is refused too: the name is a label, and a file part's name
 * is never a path the host resolves.
 */
const PART_NAME = /^[^\u0000-\u001f\u007f"\\/]+$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** A host-side failure: the caller gets a code, never a bare message. */
export function requestError(
  errorCode: string,
  message: string,
  data?: Record<string, unknown>,
): Error {
  return Object.assign(new Error(message), {
    errorCode,
    ...(data ? { data } : {}),
  });
}

export function invalidRequestArgument(message: string): Error {
  return requestError("INVALID_ARGUMENT", message);
}

function invalid(message: string): Error {
  return invalidRequestArgument(message);
}

/**
 * The stable code of a host failure, for an audit row. Anything that is not a
 * coded rejection is reported as the fallback: a failure this surface cannot
 * name must not be attributed one of its documented outcomes.
 */
export function requestErrorCode(error: unknown, fallback = "UNSUPPORTED"): string {
  const code = (error as { errorCode?: unknown } | null)?.errorCode;
  return typeof code === "string" ? code : fallback;
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const char = value.charCodeAt(index);
    if (char < 0x20 || char === 0x7f) return true;
  }
  return false;
}

/**
 * A multipart field value is text a caller may want to send as-is, so a
 * newline and a tab are legal. A CR or LF cannot forge a part boundary either:
 * the boundary carries a per-call UUID the caller never sees.
 */
function hasFieldControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const char = value.charCodeAt(index);
    if (char === 0x09 || char === 0x0a || char === 0x0d) continue;
    if (char < 0x20 || char === 0x7f) return true;
  }
  return false;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A rejected path: the caller typed an escape that is not an escape. */
function decodeStrict(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw invalid("path contains a malformed percent-encoding");
  }
}

/**
 * A best-effort decode, for a string that is already known to be well-formed:
 * an escape no longer decodable is left as it stands rather than refused.
 */
function decodeTolerant(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Percent-decode at most twice. The first pass is strict, because a malformed
 * escape the caller typed is a rejected path; the second only looks for a second
 * layer of encoding and keeps the first result when there is none — otherwise a
 * legitimate decoded `%` (`…/100%25`) would make the path unusable.
 */
function decodeBounded(value: string): string {
  return decodeTolerant(decodeStrict(value));
}

/** True when a decoded path carries a `..` segment. `.` is legal and stays put. */
function hasParentSegment(decoded: string): boolean {
  return decoded.split("/").some((segment) => segment === "..");
}

/**
 * Compose the destination (D4, §5.3). The order matters: `new URL` resolves
 * `..` before anything can inspect it, so the caller string is validated before
 * any URL is constructed, and the assembled result is asserted afterwards.
 *
 * Layer 1 rejects a literal or encoded escape, a scheme, an authority, a
 * fragment, a backslash, control characters, an empty path, and anything over
 * the byte cap. Layer 2 re-checks the **decoded** final pathname against the
 * decoded base prefix, which catches an encoding that survived layer 1.
 *
 * Only the path portion is decoded and inspected. The query is the caller's own
 * data and is passed through untouched: a `..` or an unescaped `%` inside it
 * cannot escape the base prefix, so it must not refuse the call either.
 *
 * There is no implicit `/v1`: the provider's `baseUrl` is used as configured and
 * the caller's path is appended to it, exactly as specified. A caller that
 * needs `/v1` passes it.
 */
export function resolveRequestUrl(baseUrl: unknown, callerPath: unknown): string {
  if (typeof callerPath !== "string" || callerPath.length === 0) {
    throw invalid("path is required and must not be empty");
  }
  if (Buffer.byteLength(callerPath, "utf8") > REQUEST_PATH_MAX_BYTES) {
    throw invalid(`path exceeds ${REQUEST_PATH_MAX_BYTES} bytes`);
  }
  if (callerPath.includes("\\")) throw invalid("path must not contain a backslash");
  if (callerPath.includes("#")) throw invalid("path must not contain a fragment");
  if (hasControlCharacter(callerPath)) {
    throw invalid("path must not contain control characters");
  }
  if (callerPath.startsWith("//")) {
    throw invalid("path must not start with a scheme-relative authority");
  }

  const queryAt = callerPath.indexOf("?");
  const pathOnly = queryAt === -1 ? callerPath : callerPath.slice(0, queryAt);
  const query = queryAt === -1 ? "" : callerPath.slice(queryAt + 1);
  const decoded = decodeBounded(pathOnly);
  if (decoded.includes("\\")) throw invalid("path must not contain a backslash");
  if (hasParentSegment(decoded)) {
    throw invalid("path must not contain a traversal segment");
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(decoded)) {
    throw invalid("path must be relative to the provider base URL");
  }

  let base: URL;
  try {
    base = new URL(String(baseUrl));
  } catch {
    throw requestError("PROVIDER_NOT_FOUND", "The provider has no usable base URL");
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    throw requestError("PROVIDER_NOT_FOUND", "The provider base URL is not http(s)");
  }
  // host-core validates the row at write time; this is a defensive re-check.
  if (base.username || base.password || base.search || base.hash) {
    throw requestError("PROVIDER_NOT_FOUND", "The provider base URL is not usable");
  }

  const basePath = base.pathname.replace(/\/+$/, "");
  const final = new URL(base.href);
  final.pathname = `${basePath}/${pathOnly.replace(/^\/+/, "")}`;
  final.search = query;

  if (final.origin !== base.origin) {
    throw invalid("path must not change the destination origin");
  }
  const finalPath = decodeTolerant(final.pathname);
  if (hasParentSegment(finalPath)) {
    throw invalid("path must not contain a traversal segment");
  }
  // Both sides of the prefix assertion are decoded, because the URL parser may
  // percent-encode either of them: a decoded pathname measured against a raw
  // base path would refuse every call to `https://host/v1%20beta`.
  const basePrefix = decodeTolerant(basePath);
  // The prefix is "" for a provider rooted at "/", and every pathname is
  // root-absolute, so the check is then the origin check alone.
  if (basePrefix && !finalPath.startsWith(basePrefix)) {
    throw invalid("path must stay inside the provider base path");
  }
  return final.href;
}

/**
 * The caller's headers, validated and refused rather than filtered (D5). The
 * provider row's own headers are merged by the caller through the shared
 * provider-header caps, so this function owns only the decision a caller must be
 * able to see; the caps stay in one place (`provider-headers.ts`).
 */
export function callerHeaders(value: unknown): Record<string, string> {
  if (value === undefined || value === null) return {};
  const record = asRecord(value);
  if (!record) throw invalid("headers must be an object of string values");
  const entries = Object.entries(record);
  if (entries.length > 32) throw invalid("headers must not exceed 32 entries");
  const headers: Record<string, string> = {};
  const seen = new Set<string>();
  for (const [rawKey, rawValue] of entries) {
    const key = rawKey.trim();
    const lower = key.toLowerCase();
    if (!HEADER_KEY.test(key) || Buffer.byteLength(key, "utf8") > 256) {
      throw invalid("header name is not a valid HTTP token");
    }
    if (RESERVED_CALLER_HEADERS.has(lower) || lower.startsWith("x-forwarded-")) {
      throw invalid(`header "${key}" is reserved by the host`);
    }
    if (seen.has(lower)) throw invalid(`header "${key}" is set more than once`);
    if (typeof rawValue !== "string") {
      throw invalid(`header "${key}" must be a string`);
    }
    if (!rawValue.trim() || hasControlCharacter(rawValue)) {
      throw invalid(
        `header "${key}" must be non-empty and free of control characters`,
      );
    }
    if (Buffer.byteLength(rawValue, "utf8") > 4096) {
      throw invalid(`header "${key}" exceeds 4096 bytes`);
    }
    seen.add(lower);
    headers[key] = rawValue;
  }
  return headers;
}

/** A caller-supplied `content-type` for a non-multipart body (D3). */
function bodyContentType(value: unknown, fallback: string): string {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "string" || hasControlCharacter(value)) {
    throw invalid("body.contentType must be a header value");
  }
  if (value.length > 256 || !/^[^\s;]+(?:\s*;\s*[^;]+)*$/.test(value)) {
    throw invalid("body.contentType must be a media type");
  }
  return value;
}

export type AssembledRequest = {
  /** Absent for a body-less request. */
  body?: string | Uint8Array<ArrayBuffer>;
  /** The host owns `content-type` (D3), so the caller never sets it. */
  contentType?: string;
  bytes: number;
  /** Multipart only, for the audit line: counts and bytes, never paths. */
  files?: number;
};

function oversize(limit: number): Error {
  return invalid(`body exceeds ${limit} bytes`);
}

function assembleJson(value: unknown): AssembledRequest {
  if (value === undefined) {
    throw invalid("body.value is required for a json body");
  }
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw invalid("body.value is not JSON-serializable");
  }
  if (serialized === undefined) {
    throw invalid("body.value is not JSON-serializable");
  }
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes > REQUEST_BODY_MAX_BYTES) throw oversize(REQUEST_BODY_MAX_BYTES);
  return { body: serialized, contentType: "application/json", bytes };
}

function assembleText(part: {
  value: unknown;
  contentType?: unknown;
}): AssembledRequest {
  if (typeof part.value !== "string") {
    throw invalid("body.value must be a string");
  }
  const bytes = Buffer.byteLength(part.value, "utf8");
  if (bytes > REQUEST_BODY_MAX_BYTES) throw oversize(REQUEST_BODY_MAX_BYTES);
  return {
    body: part.value,
    contentType: bodyContentType(part.contentType, "text/plain"),
    bytes,
  };
}

function assembleBase64(part: {
  value: unknown;
  contentType?: unknown;
}): AssembledRequest {
  if (typeof part.value !== "string" || !BASE64.test(part.value)) {
    throw invalid("body.value must be base64-encoded bytes");
  }
  const decoded = Buffer.from(part.value, "base64");
  if (decoded.length > REQUEST_BODY_MAX_BYTES) {
    throw oversize(REQUEST_BODY_MAX_BYTES);
  }
  return {
    body: decoded,
    contentType: bodyContentType(part.contentType, "application/octet-stream"),
    bytes: decoded.length,
  };
}

function partName(value: unknown, what: string): string {
  const name = typeof value === "string" ? value : "";
  if (
    !PART_NAME.test(name) ||
    Buffer.byteLength(name, "utf8") > MULTIPART_NAME_MAX_BYTES
  ) {
    throw invalid(`a multipart ${what} has an invalid name`);
  }
  return name;
}

function multipartFields(value: unknown): Array<{ name: string; value: string }> {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw invalid("body.fields must be an array");
  if (value.length > MULTIPART_MAX_FIELDS) {
    throw invalid(`body.fields must not exceed ${MULTIPART_MAX_FIELDS} entries`);
  }
  let total = 0;
  return value.map((entry) => {
    const record = asRecord(entry);
    const name = partName(record?.name, "field");
    const fieldValue = typeof record?.value === "string" ? record.value : null;
    if (fieldValue === null || hasFieldControlCharacter(fieldValue)) {
      throw invalid(
        `multipart field "${name}" must be text; only tab, CR, and LF are allowed among control characters`,
      );
    }
    const bytes = Buffer.byteLength(fieldValue, "utf8");
    if (bytes > MULTIPART_FIELD_MAX_BYTES) {
      throw invalid(
        `multipart field "${name}" exceeds ${MULTIPART_FIELD_MAX_BYTES} bytes`,
      );
    }
    total += bytes;
    if (total > MULTIPART_FIELDS_MAX_BYTES) {
      throw invalid(
        `multipart fields exceed ${MULTIPART_FIELDS_MAX_BYTES} bytes`,
      );
    }
    return { name, value: fieldValue };
  });
}

type MultipartFilePart = {
  name: string;
  path: string;
  filename: string;
  contentType: string;
};

function multipartFiles(value: unknown): MultipartFilePart[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw invalid("body.files must be an array");
  if (value.length > MULTIPART_MAX_FILES) {
    throw invalid(`body.files must not exceed ${MULTIPART_MAX_FILES} entries`);
  }
  return value.map((entry) => {
    const record = asRecord(entry);
    const name = partName(record?.name, "file");
    const path = typeof record?.path === "string" ? record.path : "";
    if (!path.trim()) throw invalid(`multipart file "${name}" needs a path`);
    const given = typeof record?.filename === "string" ? record.filename : "";
    const filename = given || path.split(/[\\/]/).pop() || name;
    // The filename is a label inside the part, never a path.
    if (
      hasControlCharacter(filename) ||
      filename.includes('"') ||
      /[\\/]/.test(filename) ||
      Buffer.byteLength(filename, "utf8") > 255
    ) {
      throw invalid(`multipart file "${name}" has an invalid filename`);
    }
    return {
      name,
      path,
      filename,
      contentType: bodyContentType(record?.contentType, "application/octet-stream"),
    };
  });
}

/** The `multipart/form-data` envelope, built by the host because it owns the boundary. */
async function assembleMultipart(
  fields: Array<{ name: string; value: string }>,
  files: MultipartFilePart[],
  readFiles: (refs: string[]) => Promise<Uint8Array[]>,
): Promise<AssembledRequest> {
  if (files.length === 0 && fields.length === 0) {
    throw invalid("a multipart body needs at least one field or file");
  }
  const contents = await readFiles(files.map((file) => file.path));
  if (contents.length !== files.length) {
    throw requestError("FILE_NOT_FOUND", "An uploaded file could not be read");
  }
  const boundary = `----pi-desktop-${randomUUID()}`;
  const chunks: Buffer[] = [];
  for (const field of fields) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${field.name}"\r\n\r\n${field.value}\r\n`,
        "utf8",
      ),
    );
  }
  files.forEach((file, index) => {
    const content = contents[index] ?? new Uint8Array();
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`,
        "utf8",
      ),
      Buffer.from(content),
      Buffer.from("\r\n", "utf8"),
    );
  });
  chunks.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));
  const body = Buffer.concat(chunks);
  if (body.length > MULTIPART_TOTAL_MAX_BYTES) {
    throw requestError(
      "UPLOAD_TOO_LARGE",
      `multipart body exceeds ${MULTIPART_TOTAL_MAX_BYTES} bytes`,
    );
  }
  return {
    body: new Uint8Array(body) as Uint8Array<ArrayBuffer>,
    contentType: `multipart/form-data; boundary=${boundary}`,
    bytes: body.length,
    files: files.length,
  };
}

/**
 * Assemble the body exactly as asked (D3). The host owns `content-type`, so
 * `multipart` never takes one from the caller, and a body on `GET` is refused:
 * every other method is the caller's business, but a GET body is always a
 * mistake.
 */
export async function assembleRequestBody(options: {
  body: unknown;
  method: ExtensionProviderRequestMethod;
  readFiles: (refs: string[]) => Promise<Uint8Array[]>;
}): Promise<AssembledRequest> {
  const { body, method } = options;
  if (body === undefined || body === null) return { bytes: 0 };
  if (method === "GET") throw invalid("a GET request must not carry a body");
  const part = asRecord(body);
  if (!part) throw invalid("body must be one of the documented shapes");
  switch (part.kind) {
    case "json":
      return assembleJson(part.value);
    case "text":
      return assembleText({ value: part.value, contentType: part.contentType });
    case "base64":
      return assembleBase64({ value: part.value, contentType: part.contentType });
    case "multipart":
      return await assembleMultipart(
        multipartFields(part.fields),
        multipartFiles(part.files),
        options.readFiles,
      );
    default:
      throw invalid("body.kind must be json, text, base64, or multipart");
  }
}

/** The method, or the documented default `GET`. */
export function requestMethod(value: unknown): ExtensionProviderRequestMethod {
  if (value === undefined || value === null) return "GET";
  if (typeof value !== "string" || !REQUEST_METHODS.has(value)) {
    throw invalid("method must be GET, POST, PUT, PATCH, or DELETE");
  }
  return value as ExtensionProviderRequestMethod;
}

/** The per-call budget, in milliseconds (D8). */
export function requestTimeoutMs(value: unknown): number {
  if (value === undefined || value === null) return REQUEST_TIMEOUT_FALLBACK_MS;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value <= 0 ||
    value > REQUEST_TIMEOUT_MAX_MS
  ) {
    throw invalid(
      `timeoutMs must be an integer between 1 and ${REQUEST_TIMEOUT_MAX_MS}`,
    );
  }
  return value;
}
