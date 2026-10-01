import { connectViaProxy } from "@pi-desktop/agent-runtime/proxy-tunnel";
import { parseProxyUrl, type ParsedProxyUrl } from "@pi-desktop/shared";
import { Agent as HttpsAgent } from "node:https";
import { Duplex } from "node:stream";
import { connect as tlsConnect } from "node:tls";
import { net, session } from "electron";
import { WebSocket } from "ws";
import { allowInsecureUserEndpointsEnabled, noteInsecureUserEndpoint, relaxedNetworkPolicyEnabled } from "../endpoint-policy";
import { createPublicHttpsClient } from "../public-https-fetch";
import { responseCodeError } from "./websocket-errors";

const HANDSHAKE_TIMEOUT_MS = 15_000;
const SOCKET_MAX_PAYLOAD = 2 * 1024 * 1024;

const endpointGuard = createPublicHttpsClient({
  fetchImpl: (url, init) => net.fetch(url, init),
  routeImpl: (url) => session.defaultSession.resolveProxy(url),
  allowFakeIp: () => relaxedNetworkPolicyEnabled(),
  allowInsecureUserEndpoints: () => allowInsecureUserEndpointsEnabled(),
  onInsecureUserEndpoint: (host) => noteInsecureUserEndpoint(host),
});

class ProxyTunnelAgent extends HttpsAgent {
  constructor(private readonly proxy: ParsedProxyUrl) {
    super({ keepAlive: false });
  }

  override createConnection(
    options: Parameters<HttpsAgent["createConnection"]>[0],
    callback?: (error: Error | null, socket: Duplex) => void,
  ): Duplex | null | undefined {
    const host = options.hostname ?? options.host ?? "";
    const port = Number(options.port) || 443;
    const servername = options.servername ?? host;
    if (!callback) throw new Error("proxy tunnel requires a socket callback");
    void connectViaProxy(this.proxy, host, port)
      .then((socket) => {
        const secure = tlsConnect({ socket, host, servername, ALPNProtocols: ["http/1.1"] });
        secure.once("secureConnect", () => callback(null, secure));
        secure.once("error", (error) => callback(error, secure));
      })
      .catch((error: unknown) => {
        const failure = error instanceof Error ? error : new Error("proxy tunnel failed");
        const unavailable = new Duplex({ read() {}, write(_chunk, _encoding, done) { done(failure); } });
        callback(failure, unavailable);
      });
    return null;
  }
}

function parseResolvedProxy(route: string): ParsedProxyUrl | null {
  const steps = route.split(";").map((item) => item.trim()).filter(Boolean);
  if (steps.length !== 1) {
    throw Object.assign(new Error("network proxy route cannot be honored by the Live transport"), {
      errorCode: "LIVE_NETWORK_POLICY_UNSUPPORTED",
    });
  }
  const directive = steps[0];
  if (directive.toUpperCase() === "DIRECT") return null;
  const match = directive.match(/^(PROXY|HTTP|HTTPS|SOCKS5)\s+(.+)$/i);
  if (!match) {
    throw Object.assign(new Error("network proxy route cannot be honored by the Live transport"), {
      errorCode: "LIVE_NETWORK_POLICY_UNSUPPORTED",
    });
  }
  const scheme = match[1].toUpperCase() === "HTTPS" ? "https" : match[1].toUpperCase() === "SOCKS5" ? "socks5" : "http";
  const parsed = parseProxyUrl(`${scheme}://${match[2]}`);
  if (!parsed.ok) {
    throw Object.assign(new Error("network proxy route is invalid"), {
      errorCode: "LIVE_NETWORK_POLICY_UNSUPPORTED",
    });
  }
  return parsed.value;
}

export async function openLiveWebSocket(input: {
  url: string;
  headers?: Record<string, string>;
  signal: AbortSignal;
  endpointOrigin: "user" | "third-party";
}): Promise<WebSocket> {
  const parsedUrl = new URL(input.url);
  if (parsedUrl.protocol !== "wss:") {
    throw Object.assign(new Error("Live WebSocket endpoints must use TLS"), {
      errorCode: "LIVE_NETWORK_POLICY_UNSUPPORTED",
    });
  }
  await endpointGuard.assertPublicUrl(input.url.replace(/^wss:/, "https:"), input.endpointOrigin);
  if (input.signal.aborted) throw input.signal.reason;
  const route = await session.defaultSession.resolveProxy(input.url);
  if (input.signal.aborted) {
    throw Object.assign(new Error("Live provider connection was cancelled"), { errorCode: "LIVE_STALE_CALL" });
  }
  const proxy = parseResolvedProxy(route);
  const agent = proxy ? new ProxyTunnelAgent(proxy) : undefined;

  try {
    let cleanupAbort = () => {};
    const connected = await new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(input.url, {
        ...(agent ? { agent } : {}),
        ...(input.headers ? { headers: input.headers } : {}),
        maxPayload: SOCKET_MAX_PAYLOAD,
        handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
        followRedirects: false,
        perMessageDeflate: false,
      });
      let settled = false;
      const onAbort = () => {
        const wasSettled = settled;
        settled = true;
        if (!wasSettled) reject(Object.assign(new Error("Live provider connection was cancelled"), { errorCode: "LIVE_STALE_CALL" }));
        cleanup();
        socket.terminate();
      };
      const cleanup = () => input.signal.removeEventListener("abort", onAbort);
      cleanupAbort = cleanup;
      input.signal.addEventListener("abort", onAbort, { once: true });
      socket.once("open", () => {
        if (settled) return;
        settled = true;
        resolve(socket);
      });
      socket.once("error", (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        socket.terminate();
        reject(Object.assign(new Error("Live provider connection failed"), { cause: error }));
      });
      socket.once("close", () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error("Live provider closed during handshake"));
      });
      socket.once("unexpected-response", (_request, response) => {
        if (settled) return;
        settled = true;
        cleanup();
        socket.terminate();
        response.destroy();
        const mapped = responseCodeError(response.statusCode ?? 0);
        reject(Object.assign(new Error("Live provider rejected the WebSocket handshake"), {
          errorCode: mapped.code,
          retriable: mapped.retriable,
        }));
      });
    });
    connected.once("close", () => {
      cleanupAbort();
      agent?.destroy();
    });
    return connected;
  } catch (error) {
    // Handshake failures normally clean up in their event handlers. This also
    // covers a constructor failure before those handlers can run.
    agent?.destroy();
    throw error;
  }
}

export async function assertLiveHttpsEndpoint(url: string, origin: "user" | "third-party"): Promise<void> {
  await endpointGuard.assertPublicUrl(url, origin);
}
