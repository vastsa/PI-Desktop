/**
 * Upstream HTTP/HTTPS proxy resolution and request transport for `pi-host`.
 *
 * Supports standard `HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY`, and `NO_PROXY`
 * environment variables (lowercase takes precedence over uppercase).
 *
 * Security invariants:
 * - For `https:` upstreams behind a proxy, traffic is tunneled through HTTP
 *   `CONNECT` and upgraded to TLS before any request method, path, header, or
 *   GitHub `Authorization` credential is sent.
 * - The `CONNECT` request carries only `Host` and (if configured on the proxy
 *   URL) `Proxy-Authorization`.
 * - TLS certificate validation and hostname verification stay enabled for
 *   tunneled connections, with SNI set for DNS hostnames.
 * - Errors never echo proxy usernames, passwords, or upstream credentials.
 */
import { request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type Socket } from "node:net";
import { checkServerIdentity, connect as tlsConnect } from "node:tls";

const URL_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//u;
const PORT_DIGITS = /^\d+$/u;

export type UpstreamProxyErrorCode =
  | "ERR_INVALID_PROXY_URL"
  | "ERR_UNSUPPORTED_PROXY_PROTOCOL"
  | "ERR_PROXY_CONNECT";

export class UpstreamProxyError extends Error {
  readonly code: UpstreamProxyErrorCode;

  constructor(code: UpstreamProxyErrorCode, message: string) {
    super(message);
    this.name = "UpstreamProxyError";
    this.code = code;
  }
}

export type UpstreamTlsOptions = {
  /** Additional trusted CA certificate(s), primarily for tests with a local CA. */
  ca?: string | Buffer;
};

export type UpstreamRequestOptions = {
  upstream: URL;
  method: string | undefined;
  /** Target path and optional query string (including any upstream base path). */
  path: string;
  headers: Record<string, string | string[]>;
  env?: NodeJS.ProcessEnv;
  upstreamTls?: UpstreamTlsOptions;
};

export type UpstreamRequestCallbacks = {
  onReady: (outbound: ClientRequest) => void;
  onResponse: (inbound: IncomingMessage) => void;
  onError: (error: Error) => void;
};

export type UpstreamRequestHandle = {
  /** Destroy any in-flight `CONNECT` tunnel or active upstream request. */
  destroy(): void;
};

function lookupEnv(env: NodeJS.ProcessEnv, lowerName: string): { key: string; value: string } | null {
  const lower = env[lowerName]?.trim();
  if (lower) return { key: lowerName, value: lower };
  const upperName = lowerName.toUpperCase();
  const upper = env[upperName]?.trim();
  if (upper) return { key: upperName, value: upper };
  for (const [key, raw] of Object.entries(env)) {
    if (key.toLowerCase() !== lowerName) continue;
    const trimmed = raw?.trim();
    if (trimmed) return { key, value: trimmed };
  }
  return null;
}

function stripBrackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function canonicalizeIpv6(raw: string): string | null {
  try {
    const parsed = new URL(`http://[${raw}]/`);
    return stripBrackets(parsed.hostname).toLowerCase();
  } catch {
    return null;
  }
}

function normalizeTargetHost(hostname: string): string {
  const unbracketed = stripBrackets(hostname).toLowerCase();
  return unbracketed.endsWith(".") ? unbracketed.slice(0, -1) : unbracketed;
}

function effectivePort(url: URL): string {
  if (url.port) return url.port;
  if (url.protocol === "https:") return "443";
  if (url.protocol === "http:") return "80";
  return "";
}

type ParsedNoProxyEntry = {
  wildcard?: true;
  host: string;
  port?: string;
  isIp: boolean;
};

function parseNoProxyEntry(rawEntry: string): ParsedNoProxyEntry | null {
  const entry = rawEntry.trim();
  if (!entry) return null;
  if (entry === "*") return { wildcard: true, host: "*", isIp: false };

  let hostPart: string;
  let portPart: string | undefined;

  if (entry.startsWith("[")) {
    const close = entry.indexOf("]");
    if (close <= 1) return null;
    const inner = entry.slice(1, close);
    const rest = entry.slice(close + 1);
    if (rest.length > 0) {
      if (!rest.startsWith(":")) return null;
      portPart = rest.slice(1);
      if (!portPart || !PORT_DIGITS.test(portPart)) return null;
    }
    const canonical = canonicalizeIpv6(inner);
    if (!canonical) return null;
    return { host: canonical, port: portPart, isIp: true };
  }

  const firstColon = entry.indexOf(":");
  const lastColon = entry.lastIndexOf(":");
  if (firstColon !== -1 && firstColon !== lastColon) {
    // Unbracketed IPv6 literal (no port component).
    const canonical = canonicalizeIpv6(entry);
    if (!canonical) return null;
    return { host: canonical, isIp: true };
  }

  if (lastColon !== -1) {
    hostPart = entry.slice(0, lastColon);
    portPart = entry.slice(lastColon + 1);
    if (!portPart || !PORT_DIGITS.test(portPart)) return null;
  } else {
    hostPart = entry;
  }

  let normalized = hostPart.toLowerCase();
  if (normalized.endsWith(".")) normalized = normalized.slice(0, -1);
  if (normalized.startsWith(".")) normalized = normalized.slice(1);
  if (!normalized || normalized.includes("*")) return null;

  return { host: normalized, port: portPart, isIp: isIP(normalized) !== 0 };
}

function matchesNoProxy(target: URL, noProxyValue: string): boolean {
  const targetHost = normalizeTargetHost(target.hostname);
  const targetPort = effectivePort(target);

  for (const part of noProxyValue.split(",")) {
    const parsed = parseNoProxyEntry(part);
    if (!parsed) continue;
    if (parsed.wildcard) return true;
    if (parsed.port !== undefined && parsed.port !== targetPort) continue;
    if (parsed.isIp) {
      if (targetHost === parsed.host) return true;
      continue;
    }
    if (targetHost === parsed.host || targetHost.endsWith(`.${parsed.host}`)) return true;
  }
  return false;
}

/**
 * Resolve the upstream proxy URL for `target` from `env`, respecting `NO_PROXY`.
 *
 * Returns `null` when no proxy applies or `target` matches `NO_PROXY`.
 * Throws `UpstreamProxyError` (without echoing credentials) when a configured
 * proxy URL is malformed or uses an unsupported protocol.
 */
export function resolveUpstreamProxy(target: URL, env: NodeJS.ProcessEnv = process.env): URL | null {
  if (target.protocol !== "https:" && target.protocol !== "http:") return null;

  const noProxy = lookupEnv(env, "no_proxy");
  if (noProxy && matchesNoProxy(target, noProxy.value)) return null;

  const candidates = target.protocol === "https:"
    ? ["https_proxy", "all_proxy"]
    : ["http_proxy", "all_proxy"];

  let found: { key: string; value: string } | null = null;
  for (const name of candidates) {
    found = lookupEnv(env, name);
    if (found) break;
  }
  if (!found) return null;

  // Require an explicit `<scheme>://` before parsing so scheme-less values like
  // `user:secret@proxy:8080` are never misparsed with `user:` as the protocol.
  if (!URL_SCHEME.test(found.value)) {
    throw new UpstreamProxyError(
      "ERR_INVALID_PROXY_URL",
      `Invalid upstream proxy URL in ${found.key}: missing http:// or https:// scheme`,
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(found.value);
  } catch {
    throw new UpstreamProxyError("ERR_INVALID_PROXY_URL", `Invalid upstream proxy URL in ${found.key}`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new UpstreamProxyError(
      "ERR_UNSUPPORTED_PROXY_PROTOCOL",
      `Unsupported upstream proxy protocol "${parsed.protocol}" in ${found.key}; only http: and https: are supported`,
    );
  }

  if (!parsed.hostname) {
    throw new UpstreamProxyError("ERR_INVALID_PROXY_URL", `Invalid upstream proxy URL in ${found.key}: missing hostname`);
  }

  if (parsed.username || parsed.password) {
    try {
      decodeURIComponent(parsed.username);
      decodeURIComponent(parsed.password);
    } catch {
      throw new UpstreamProxyError("ERR_INVALID_PROXY_URL", `Invalid upstream proxy credentials in ${found.key}`);
    }
  }

  return parsed;
}

function buildProxyAuthorization(proxy: URL): string | undefined {
  if (!proxy.username && !proxy.password) return undefined;
  const user = decodeURIComponent(proxy.username);
  const pass = decodeURIComponent(proxy.password);
  return `Basic ${Buffer.from(`${user}:${pass}`, "utf8").toString("base64")}`;
}

function sniServername(host: string): string | undefined {
  // RFC 6066 prohibits IP address literals in TLS SNI.
  return isIP(host) === 0 ? host : undefined;
}

/**
 * Send an HTTP or HTTPS request to `upstream`, routing through a resolved
 * `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` when configured.
 */
export function sendUpstreamRequest(
  options: UpstreamRequestOptions,
  callbacks: UpstreamRequestCallbacks,
): UpstreamRequestHandle {
  const { upstream, method, path, headers, env = process.env, upstreamTls } = options;

  let proxy: URL | null;
  try {
    proxy = resolveUpstreamProxy(upstream, env);
  } catch (error) {
    callbacks.onError(error instanceof Error ? error : new UpstreamProxyError("ERR_INVALID_PROXY_URL", "Invalid upstream proxy configuration"));
    return { destroy() {} };
  }

  let destroyed = false;
  let errored = false;
  let activeConnect: ClientRequest | null = null;
  let activeTunnelSocket: Socket | null = null;
  let activeOutbound: ClientRequest | null = null;

  const emitError = (error: Error) => {
    if (destroyed || errored) return;
    errored = true;
    callbacks.onError(error);
  };

  const handle: UpstreamRequestHandle = {
    destroy() {
      if (destroyed) return;
      destroyed = true;
      activeConnect?.destroy();
      activeTunnelSocket?.destroy();
      activeOutbound?.destroy();
    },
  };

  const targetHost = stripBrackets(upstream.hostname);

  // Direct connection (no proxy configured or bypassed by NO_PROXY).
  if (!proxy) {
    const outbound = upstream.protocol === "https:"
      ? httpsRequest({
          protocol: "https:",
          hostname: targetHost,
          port: upstream.port || undefined,
          method,
          path,
          headers,
          ...(upstreamTls?.ca ? { ca: upstreamTls.ca, rejectUnauthorized: true, agent: false } : {}),
        }, callbacks.onResponse)
      : httpRequest({
          protocol: "http:",
          hostname: targetHost,
          port: upstream.port || undefined,
          method,
          path,
          headers,
        }, callbacks.onResponse);
    activeOutbound = outbound;
    outbound.on("error", emitError);
    callbacks.onReady(outbound);
    return handle;
  }

  const proxyHost = stripBrackets(proxy.hostname);
  const proxyAuth = buildProxyAuthorization(proxy);

  // Plain HTTP upstream through HTTP or HTTPS proxy: send absolute-form URI.
  if (upstream.protocol === "http:") {
    const proxyHeaders: Record<string, string | string[]> = {
      ...headers,
      host: upstream.host,
      ...(proxyAuth ? { "proxy-authorization": proxyAuth } : {}),
    };
    const absolutePath = `${upstream.origin}${path}`;
    const outbound = proxy.protocol === "https:"
      ? httpsRequest({
          protocol: "https:",
          hostname: proxyHost,
          port: proxy.port || undefined,
          method,
          path: absolutePath,
          headers: proxyHeaders,
          servername: sniServername(proxyHost),
          checkServerIdentity: (_host, cert) => checkServerIdentity(proxyHost, cert),
          rejectUnauthorized: true,
          ...(upstreamTls?.ca ? { ca: upstreamTls.ca, agent: false } : {}),
        }, callbacks.onResponse)
      : httpRequest({
          protocol: "http:",
          hostname: proxyHost,
          port: proxy.port || undefined,
          method,
          path: absolutePath,
          headers: proxyHeaders,
        }, callbacks.onResponse);
    activeOutbound = outbound;
    outbound.on("error", emitError);
    callbacks.onReady(outbound);
    return handle;
  }

  // HTTPS upstream through HTTP or HTTPS proxy: establish CONNECT tunnel first,
  // then upgrade to TLS before sending any request headers or GitHub credentials.
  const authority = `${upstream.hostname}:${effectivePort(upstream)}`;
  const connectHeaders: Record<string, string> = { host: authority };
  if (proxyAuth) connectHeaders["proxy-authorization"] = proxyAuth;

  const connectReq = proxy.protocol === "https:"
    ? httpsRequest({
        protocol: "https:",
        hostname: proxyHost,
        port: proxy.port || undefined,
        method: "CONNECT",
        path: authority,
        headers: connectHeaders,
        agent: false,
        servername: sniServername(proxyHost),
        checkServerIdentity: (_host, cert) => checkServerIdentity(proxyHost, cert),
        rejectUnauthorized: true,
        ...(upstreamTls?.ca ? { ca: upstreamTls.ca } : {}),
      })
    : httpRequest({
        protocol: "http:",
        hostname: proxyHost,
        port: proxy.port || undefined,
        method: "CONNECT",
        path: authority,
        headers: connectHeaders,
        agent: false,
      });

  activeConnect = connectReq;
  let connectSettled = false;

  connectReq.on("connect", (connectRes, socket, head) => {
    connectSettled = true;
    activeConnect = null;
    if (destroyed) {
      socket.destroy();
      return;
    }
    if (connectRes.statusCode !== 200) {
      socket.destroy();
      emitError(
        new UpstreamProxyError(
          "ERR_PROXY_CONNECT",
          `Upstream proxy CONNECT failed with status ${connectRes.statusCode ?? "unknown"}`,
        ),
      );
      return;
    }
    if (head.length > 0) socket.unshift(head);
    activeTunnelSocket = socket;

    const outbound = httpsRequest({
      protocol: "https:",
      hostname: targetHost,
      port: upstream.port || undefined,
      method,
      path,
      headers,
      createConnection: () => tlsConnect({
        socket,
        servername: sniServername(targetHost),
        checkServerIdentity: (_host, cert) => checkServerIdentity(targetHost, cert),
        rejectUnauthorized: true,
        ...(upstreamTls?.ca ? { ca: upstreamTls.ca } : {}),
      }),
    }, callbacks.onResponse);

    activeOutbound = outbound;
    outbound.on("error", emitError);
    callbacks.onReady(outbound);
  });

  connectReq.on("error", (error) => {
    connectSettled = true;
    activeConnect = null;
    emitError(error);
  });

  connectReq.on("close", () => {
    if (!connectSettled && !destroyed) {
      connectSettled = true;
      activeConnect = null;
      emitError(new UpstreamProxyError("ERR_PROXY_CONNECT", "Upstream proxy closed connection before CONNECT completed"));
    }
  });

  connectReq.end();
  return handle;
}
