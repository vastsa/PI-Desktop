import { once } from "node:events";
import { Agent, request } from "node:https";
import { isIP, type Socket } from "node:net";
import { buffer } from "node:stream/consumers";
import { connect as tlsConnect, getCACertificates } from "node:tls";
import { createBrotliDecompress, createUnzip } from "node:zlib";
import type { ProviderMetadataRequest } from "./provider-metadata-fetch";

type Connect = (host: string, port: number) => Promise<Socket>;

/** Own a late tunnel even when cancellation wins the race to connect. */
async function connectWithSignal(connect: () => Promise<Socket>, signal: AbortSignal): Promise<Socket> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    void connect().then((socket) => {
      signal.removeEventListener("abort", abort);
      if (signal.aborted) {
        socket.destroy();
        reject(signal.reason);
      } else resolve(socket);
    }, (error: unknown) => {
      signal.removeEventListener("abort", abort);
      reject(error);
    });
  });
}

/** One HTTPS metadata request, with no redirects, cookies or client identity.
 * The caller supplies the route; TLS still verifies the original hostname.
 * Buffering the small metadata response gives each attempt a bounded socket
 * lifetime, including cancellation during body consumption. */
export async function fetchHttpsMetadata(
  url: string,
  init: ProviderMetadataRequest,
  connect: Connect,
): Promise<Response> {
  const target = new URL(url);
  if (target.protocol !== "https:" || target.username || target.password) {
    throw new Error("provider metadata retry requires an HTTPS URL without userinfo");
  }
  const host = target.hostname.replace(/^\[|\]$/g, "");
  const raw = await connectWithSignal(() => connect(host, Number(target.port) || 443), init.signal);
  // Keep the bundled/extra roots and OS roots, as the sidecar does (#1187).
  // This is per-request: never change the process-wide TLS defaults.
  let socket;
  try {
    socket = tlsConnect({
      socket: raw,
      host,
      ...(isIP(host) ? {} : { servername: host }),
      ca: [...new Set([...getCACertificates("default"), ...getCACertificates("system")])],
      rejectUnauthorized: true,
      ALPNProtocols: ["http/1.1"],
    });
  } catch (error) {
    raw.destroy();
    throw error;
  }
  const agent = new Agent({ keepAlive: false, maxCachedSessions: 0 });
  agent.createConnection = () => socket;
  const abort = () => socket.destroy(new DOMException("The operation was aborted", "AbortError"));
  init.signal.addEventListener("abort", abort, { once: true });
  try {
    const connected = once(socket, "secureConnect", { signal: init.signal });
    await connected;
    init.signal.throwIfAborted();
    return await new Promise<Response>((resolve, reject) => {
      const req = request(target, {
        agent,
        method: init.method ?? "GET",
        headers: { ...init.headers, "accept-encoding": "identity" },
        signal: init.signal,
      }, (incoming) => {
        void (async () => {
          const headers = new Headers();
          for (const [name, value] of Object.entries(incoming.headers)) {
            if (Array.isArray(value)) for (const item of value) headers.append(name, item);
            else if (value !== undefined) headers.set(name, value);
          }
          const encoding = incoming.headers["content-encoding"];
          const decoder = encoding === "br" ? createBrotliDecompress()
            : encoding === "gzip" || encoding === "deflate" ? createUnzip() : null;
          // Even a server ignoring Accept-Encoding must produce fetch's decoded body.
          if (decoder) incoming.on("error", (error) => decoder.destroy(error));
          try {
            const body = await buffer(decoder ? incoming.pipe(decoder) : incoming);
            const status = incoming.statusCode ?? 0;
            resolve(new Response([204, 205, 304].includes(status) ? null : body, { status, headers }));
          } finally {
            decoder?.destroy();
            incoming.destroy();
          }
        })().catch(reject);
      });
      req.once("error", reject);
      req.end();
    });
  } catch (error) {
    init.signal.throwIfAborted();
    throw error;
  } finally {
    init.signal.removeEventListener("abort", abort);
    socket.destroy();
    agent.destroy();
  }
}
