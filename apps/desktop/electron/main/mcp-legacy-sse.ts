import type { JsonRpcMessage, McpTransport, McpTransportHandlers } from "./plugin-mcp.ts";

/**
 * Client side of the MCP 2024-11-05 HTTP+SSE transport.
 *
 * Servers built on that revision expose `GET <url>` as a long-lived event
 * stream whose first `endpoint` event names the URL that accepts client
 * messages; replies arrive on the stream, not in the POST response. The
 * streamable-HTTP client only falls back here when the server rejects its
 * initialize POST the way the spec's backwards-compatibility section
 * describes (issue #2528).
 */

/** Guard against a server streaming one unbounded event at us. */
const MAX_SSE_EVENT_BYTES = 4 * 1024 * 1024;

/** Streamable-HTTP initialize statuses that mean "try the legacy transport". */
const LEGACY_FALLBACK_STATUSES = new Set([400, 404, 405]);

type McpError = Error & { code?: string; status?: number };

function mcpError(code: string, message: string): McpError {
  const error = new Error(message) as McpError;
  error.code = code;
  return error;
}

export function isLegacySseFallbackError(error: unknown): boolean {
  const { code, status } = (error ?? {}) as McpError;
  return code === "HTTP_ERROR" && typeof status === "number" && LEGACY_FALLBACK_STATUSES.has(status);
}

export type LegacySseTransport = McpTransport & {
  /** Open the event stream and wait for the server's message endpoint. */
  connect: (timeoutMs: number, signal?: AbortSignal) => Promise<void>;
  /** Whether the server answered GET with an event stream. */
  streamOpened: () => boolean;
};

type SseEvent = { event: string; data: string };

function parseSseEvent(block: string): SseEvent | null {
  let event = "message";
  const data: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  if (data.length === 0) return null;
  return { event, data: data.join("\n") };
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The body carries nothing the transport needs.
  }
}

export function createLegacySseTransport(
  options: {
    url: string;
    headers: Record<string, string>;
    timeoutMs: number;
    fetchImpl: typeof fetch;
    assertUrlAllowed?: (url: string) => void;
  },
  handlers: McpTransportHandlers,
): LegacySseTransport {
  const streamController = new AbortController();
  const postControllers = new Set<AbortController>();
  let closed = false;
  let opened = false;
  let endpoint: Promise<string> | null = null;

  const shutdown = (reason: string | null) => {
    if (closed) return;
    closed = true;
    streamController.abort();
    for (const controller of postControllers) controller.abort();
    postControllers.clear();
    if (reason !== null) handlers.onClose(reason);
  };

  const readStream = async (
    response: Response,
    onEndpoint: (url: string) => void,
    onFailure: (error: Error) => void,
  ) => {
    if (!response.body) {
      onFailure(mcpError("INVALID_RESPONSE", "mcp sse stream has no body"));
      return;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let endpointSeen = false;
    const dispatch = (block: string) => {
      const event = parseSseEvent(block);
      if (!event) return;
      if (event.event === "endpoint") {
        if (endpointSeen) return;
        endpointSeen = true;
        let next: URL;
        try {
          next = new URL(event.data.trim(), options.url);
        } catch {
          throw mcpError("INVALID_RESPONSE", "mcp sse server sent an invalid endpoint");
        }
        // The message endpoint receives the configured credentials, so it
        // must stay on the origin the user configured.
        if (next.origin !== new URL(options.url).origin) {
          throw mcpError("INVALID_RESPONSE", "mcp sse endpoint is on a different origin");
        }
        options.assertUrlAllowed?.(next.toString());
        onEndpoint(next.toString());
        return;
      }
      if (event.event !== "message") return;
      try {
        handlers.onMessage(JSON.parse(event.data) as JsonRpcMessage);
      } catch {
        // A malformed event is not actionable; its request times out instead.
      }
    };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        buffer += decoder.decode(value, { stream: true });
        for (;;) {
          const boundary = /\r?\n\r?\n/.exec(buffer);
          if (!boundary) break;
          const block = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index + boundary[0].length);
          dispatch(block);
        }
        if (buffer.length > MAX_SSE_EVENT_BYTES) {
          throw mcpError("LIMIT_EXCEEDED", "mcp sse event is too large");
        }
      }
      onFailure(mcpError("UNAVAILABLE", "mcp sse stream closed"));
    } catch (error) {
      onFailure(closed ? mcpError("UNAVAILABLE", "mcp session closed") : (error as Error));
    } finally {
      try {
        await reader.cancel();
      } catch {
        // The stream is already finished or aborted.
      }
    }
  };

  const openStream = (): Promise<string> =>
    new Promise<string>((resolveEndpoint, rejectEndpoint) => {
      let settled = false;
      const onEndpoint = (url: string) => {
        if (settled) return;
        settled = true;
        resolveEndpoint(url);
      };
      const onFailure = (error: Error) => {
        if (!settled) {
          settled = true;
          rejectEndpoint(error);
          return;
        }
        // The session was live; losing its stream ends it.
        shutdown(error.message);
      };
      void (async () => {
        options.assertUrlAllowed?.(options.url);
        const response = await options.fetchImpl(options.url, {
          method: "GET",
          headers: { ...options.headers, accept: "text/event-stream" },
          redirect: "manual",
          signal: streamController.signal,
        });
        if (response.status >= 300 && response.status <= 399) {
          await cancelBody(response);
          throw mcpError("HTTP_REDIRECT", "mcp sse stream redirects are not supported");
        }
        if (!response.ok) {
          await cancelBody(response);
          const error = mcpError("HTTP_ERROR", `mcp server returned ${response.status}`);
          error.status = response.status;
          throw error;
        }
        if (!(response.headers.get("content-type") ?? "").includes("text/event-stream")) {
          await cancelBody(response);
          throw mcpError("INVALID_RESPONSE", "mcp server did not open an sse stream");
        }
        opened = true;
        await readStream(response, onEndpoint, onFailure);
      })().catch(onFailure);
    });

  const waitForEndpoint = (timeoutMs: number, signal?: AbortSignal): Promise<string> => {
    if (closed) return Promise.reject(mcpError("UNAVAILABLE", "mcp session is closed"));
    endpoint ??= openStream();
    const pending = endpoint;
    return new Promise<string>((resolveWait, rejectWait) => {
      const finish = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      };
      const abort = () => {
        finish();
        rejectWait(mcpError("TOOL_ABORTED", "mcp request aborted"));
      };
      const timer = setTimeout(() => {
        finish();
        rejectWait(mcpError("TIMEOUT", `mcp sse endpoint not announced after ${timeoutMs}ms`));
      }, timeoutMs);
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
      pending.then(
        (url) => {
          finish();
          resolveWait(url);
        },
        (error: Error) => {
          finish();
          rejectWait(error);
        },
      );
    });
  };

  return {
    connect: async (timeoutMs, signal) => {
      await waitForEndpoint(timeoutMs, signal);
    },
    streamOpened: () => opened,
    send: async (message, timeoutMs = options.timeoutMs, signal) => {
      const url = await waitForEndpoint(timeoutMs, signal);
      if (closed) throw mcpError("UNAVAILABLE", "mcp session is closed");
      const controller = new AbortController();
      const abort = () => controller.abort();
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
      postControllers.add(controller);
      const timer = setTimeout(abort, timeoutMs);
      try {
        const response = await options.fetchImpl(url, {
          method: "POST",
          headers: { ...options.headers, "content-type": "application/json" },
          body: JSON.stringify(message),
          redirect: "manual",
          signal: controller.signal,
        });
        // Replies travel on the event stream; the POST is only an acknowledgement.
        await cancelBody(response);
        if (!response.ok) {
          const error = mcpError("HTTP_ERROR", `mcp server returned ${response.status}`);
          error.status = response.status;
          throw error;
        }
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        postControllers.delete(controller);
      }
    },
    close: () => shutdown("mcp session closed"),
  };
}

/**
 * Streamable HTTP first, legacy HTTP+SSE second: the transport is decided by
 * the initialize exchange and fixed for the rest of the session.
 */
export function createHttpTransportWithLegacyFallback(
  options: {
    url: string;
    headers: Record<string, string>;
    timeoutMs: number;
    fetchImpl: typeof fetch;
    assertUrlAllowed?: (url: string) => void;
  },
  handlers: McpTransportHandlers,
  streamable: McpTransport,
): McpTransport {
  let active: McpTransport | null = null;
  return {
    send: async (message, timeoutMs = options.timeoutMs, signal) => {
      if (active) return active.send(message, timeoutMs, signal);
      try {
        await streamable.send(message, timeoutMs, signal);
        active ??= streamable;
        return;
      } catch (error) {
        if (active || message.method !== "initialize" || !isLegacySseFallbackError(error)) throw error;
        let silenced = true;
        const legacy = createLegacySseTransport(options, {
          onMessage: handlers.onMessage,
          onClose: (reason) => {
            if (!silenced) handlers.onClose(reason);
          },
        });
        try {
          await legacy.connect(timeoutMs, signal);
        } catch (legacyError) {
          legacy.close();
          // A server that opened no event stream speaks neither transport;
          // its streamable status is the more useful report. Once the stream
          // is open, the legacy failure is the real one.
          throw legacy.streamOpened() ? legacyError : error;
        }
        silenced = false;
        active = legacy;
        await legacy.send(message, timeoutMs, signal);
      }
    },
    close: () => (active ?? streamable).close(),
  };
}
