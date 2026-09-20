import { RacpError } from "@pi-desktop/agent-host";
import type { RacpRemoteError } from "@pi-desktop/shared";

/**
 * JSON-RPC 2.0 framing for `RACP-WS` (spec §4.1): one UTF-8 message per text
 * frame, no batches, and every failure carries a `RemoteError` under
 * `error.data` so the code means the same thing on both sides.
 */
export type JsonRpcId = string | number;

export type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
};

export type JsonRpcNotification = {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
};

export type JsonRpcErrorObject = {
  code: number;
  message: string;
  data?: RacpRemoteError;
};

export type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: JsonRpcErrorObject;
};

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

/** Numeric JSON-RPC codes; the semantic code is the `RemoteError.code`. */
export const JSON_RPC_CODES = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  application: -32000,
} as const;

export function isRequest(message: JsonRpcMessage): message is JsonRpcRequest {
  return "method" in message && "id" in message && message.id !== undefined && message.id !== null;
}

export function isNotification(message: JsonRpcMessage): message is JsonRpcNotification {
  return "method" in message && !("id" in message && message.id !== undefined && message.id !== null);
}

export function isResponse(message: JsonRpcMessage): message is JsonRpcResponse {
  return !("method" in message) && "id" in message;
}

/** Parse one frame; anything that is not a single JSON-RPC 2.0 object is rejected. */
export function parseFrame(text: string): JsonRpcMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.jsonrpc !== "2.0") return null;
  const hasMethod = typeof record.method === "string";
  const hasId = typeof record.id === "string" || typeof record.id === "number";
  if (hasMethod) return record as unknown as JsonRpcRequest | JsonRpcNotification;
  if (hasId && ("result" in record || "error" in record)) return record as unknown as JsonRpcResponse;
  return null;
}

export function encodeFrame(message: JsonRpcMessage): string {
  return JSON.stringify(message);
}

function numericCodeFor(code: string): number {
  if (code === "METHOD_NOT_FOUND") return JSON_RPC_CODES.methodNotFound;
  if (code === "INVALID_ARGUMENT") return JSON_RPC_CODES.invalidParams;
  return JSON_RPC_CODES.application;
}

/** Turn any thrown value into the wire error; unknown failures become `INTERNAL`. */
export function errorObjectFrom(error: unknown, traceId: string): JsonRpcErrorObject {
  if (error instanceof RacpError) {
    return { code: numericCodeFor(error.code), message: error.message, data: error.toRemoteError(traceId) };
  }
  const candidate = error as { errorCode?: unknown; code?: unknown; message?: unknown; retriable?: unknown } | null;
  const code =
    typeof candidate?.errorCode === "string"
      ? candidate.errorCode
      : typeof candidate?.code === "string"
        ? candidate.code
        : "INTERNAL";
  const message = error instanceof Error ? error.message : String(error);
  return {
    code: numericCodeFor(code),
    message,
    data: { code, message, retriable: candidate?.retriable === true, traceId },
  };
}

/** The client-side view of a wire error: a `RacpError` with the remote code. */
export function errorFromObject(error: JsonRpcErrorObject): RacpError {
  const remote = error.data;
  if (remote && typeof remote.code === "string") {
    return new RacpError(remote.code, remote.message || error.message, {
      retriable: remote.retriable,
      details: { ...(remote.details === undefined ? {} : { details: remote.details }), traceId: remote.traceId },
    });
  }
  const code = error.code === JSON_RPC_CODES.methodNotFound ? "METHOD_NOT_FOUND" : "INTERNAL";
  return new RacpError(code, error.message);
}
