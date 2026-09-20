/**
 * Apply the user proxy to Node's global fetch (undici).
 *
 * Electron main uses Chromium `net.fetch` instead. The sidecar has no
 * Chromium session, so LLM provider calls go through this dispatcher.
 * HTTP(S) proxies use undici `ProxyAgent`; SOCKS5 uses a CONNECT tunnel
 * plus the same undici `fetch` so the dispatcher and fetch implementation
 * stay on one package (OpenAI's undici mismatch warning).
 */
import { connect as tlsConnect } from "node:tls";
import { socks5Connect } from "./socks5.js";
import {
  applyProxyEnvAssignments,
  effectiveProxyBypass,
  parseProxyUrl,
  proxyEnvAssignments,
  type NetworkProxySettings,
  type ParsedProxyUrl,
} from "@pi-desktop/shared";
import {
  Agent,
  EnvHttpProxyAgent,
  ProxyAgent,
  fetch as undiciFetch,
  getGlobalDispatcher,
  setGlobalDispatcher,
  type Dispatcher,
  type buildConnector,
} from "undici";

/**
 * Whether Node built its own fetch transport on the environment proxy. Node
 * reads `NODE_USE_ENV_PROXY` once, at startup, and installs an
 * `EnvHttpProxyAgent`; replacing the global dispatcher (which this module does
 * for a custom proxy) therefore has to remember that choice, or a later
 * transport rebuild would silently drop proxy routing.
 */
const envProxyAtStartup = process.env.NODE_USE_ENV_PROXY === "1";

/**
 * A transport rebuild swaps a dispatcher every session's provider traffic
 * shares. Closing idle sockets is cheap, but churning the pool while a network
 * is down for minutes would make every other session pay a fresh TCP/TLS
 * handshake on its next request, so rebuilds are rate limited.
 */
export const PROVIDER_TRANSPORT_REBUILD_MIN_INTERVAL_MS = 30_000;

let originalFetch: typeof fetch | null = null;
let originalDispatcher: Dispatcher | null = null;
let installed = false;
let activeDispatcher: Dispatcher | null = null;
/** Plain agent the bypass list routes to; closed together with the proxy. */
let activeDirectDispatcher: Dispatcher | null = null;

/** Route the sidecar's provider traffic takes, for failure diagnostics. */
export type NodeTransportRoute =
  | "direct"
  | "environment-proxy"
  | "http-proxy"
  | "socks5-proxy";

/** Settings behind the installed pair, so a rebuild reproduces exactly them. */
let activeCustomSettings: NetworkProxySettings | null = null;
/** Negative infinity: a process that has never rebuilt is never throttled. */
let lastTransportRebuildAt = Number.NEGATIVE_INFINITY;

function defaultRoute(): NodeTransportRoute {
  return envProxyAtStartup ? "environment-proxy" : "direct";
}

function routeForSettings(settings: NetworkProxySettings): NodeTransportRoute {
  if (settings.mode !== "custom") return defaultRoute();
  return /^socks/i.test(settings.url ?? "") ? "socks5-proxy" : "http-proxy";
}

/**
 * Route the next provider request takes. Reported as `networkRoute` on a
 * transport failure, because "the provider is down" and "the tunnel died" look
 * identical in an errno (issue #234).
 */
export function activeNodeTransportRoute(): NodeTransportRoute {
  return activeCustomSettings
    ? routeForSettings(activeCustomSettings)
    : defaultRoute();
}

function ensurePatched(): void {
  if (installed) return;
  installed = true;
  originalFetch = globalThis.fetch;
  originalDispatcher = getGlobalDispatcher();
}

/**
 * The dispatcher Node would install by itself. A rebuild must reproduce it, not
 * fall back to a direct connection while the process runs on an env proxy.
 */
function defaultDispatcher(): Dispatcher {
  return envProxyAtStartup ? new EnvHttpProxyAgent() : new Agent();
}

function closeActiveDispatchers(): void {
  const dispatchers = [activeDispatcher, activeDirectDispatcher];
  activeDispatcher = null;
  activeDirectDispatcher = null;
  for (const dispatcher of dispatchers) closeDispatcher(dispatcher);
}

function restoreDefault(): void {
  closeActiveDispatchers();
  activeCustomSettings = null;
  if (originalDispatcher) setGlobalDispatcher(originalDispatcher);
  else setGlobalDispatcher(defaultDispatcher());
  if (originalFetch) globalThis.fetch = originalFetch;
}

export function applyNodeNetworkProxy(
  settings: NetworkProxySettings,
  env: Record<string, string | undefined> = process.env,
): void {
  ensurePatched();
  applyProxyEnvAssignments(proxyEnvAssignments(settings), env);
  if (settings.mode !== "custom") {
    restoreDefault();
    return;
  }
  const built = createCustomProxyDispatchers(settings);
  if (!built) {
    restoreDefault();
    return;
  }
  installCustomProxyDispatchers(built);
  activeCustomSettings = settings;
}

type CustomProxyDispatchers = {
  dispatcher: Dispatcher;
  direct: Dispatcher;
  route: NodeTransportRoute;
};

/** Build the proxied dispatcher pair for one custom-proxy configuration. */
function createCustomProxyDispatchers(
  settings: NetworkProxySettings,
): CustomProxyDispatchers | null {
  const parsed = parseProxyUrl(settings.url ?? "");
  if (!parsed.ok) return null;
  const proxied: Dispatcher = parsed.value.isSocks
    ? new Agent({ connect: socksConnector(parsed.value) })
    : new ProxyAgent(parsed.value.href);
  const direct = new Agent();
  const bypass = proxyBypassMatcher(effectiveProxyBypass(settings));
  // Origins on the bypass list go to the plain agent, everything else through
  // the proxy. Same list Electron main hands Chromium as `proxyBypassRules`.
  const dispatcher = proxied.compose(
    (next) => (options, handler) =>
      originIsBypassed(options.origin, bypass)
        ? direct.dispatch(options, handler)
        : next(options, handler),
  );
  return {
    dispatcher,
    direct,
    route: parsed.value.isSocks ? "socks5-proxy" : "http-proxy",
  };
}

/**
 * Install a freshly built pair and retire the previous one.
 *
 * Order matters: the new dispatcher becomes global before the old one is
 * closed, so no request can be dispatched into a dispatcher that is already
 * closing. `close()` is graceful — undici lets the requests already in flight
 * finish on their own sockets and only then tears the pool down — so a rebuild
 * triggered by one failing session can never abort another session's request.
 * The old pair is released by its owner here, which is why this module keeps the
 * reference: nothing else is left holding those sockets.
 */
function installCustomProxyDispatchers(built: CustomProxyDispatchers): void {
  const previous = [activeDispatcher, activeDirectDispatcher];
  activeDispatcher = built.dispatcher;
  activeDirectDispatcher = built.direct;
  setGlobalDispatcher(built.dispatcher);
  globalThis.fetch = undiciFetch as unknown as typeof fetch;
  for (const dispatcher of previous) closeDispatcher(dispatcher);
}

/**
 * Close one replaced dispatcher. A rejection means a socket failed to close: it
 * must stay visible without rejecting an unawaited promise.
 */
function closeDispatcher(dispatcher: Dispatcher | null): void {
  if (!dispatcher || typeof dispatcher.close !== "function") return;
  void dispatcher.close().catch((error: unknown) => {
    process.stderr.write(
      `[agent-runtime] provider transport close failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
  });
}

export type TransportRebuildResult = {
  /** False when the process-wide throttle skipped this rebuild. */
  rebuilt: boolean;
  route: NodeTransportRoute;
};

/**
 * Rebuild the shared transport after the same origin failed repeatedly without
 * ever answering (issue #234).
 *
 * undici keeps its sockets in one pool per dispatcher, and a socket that died
 * without the pool noticing is not retired by the failure itself, so a replay
 * can fail the same way ten times. Closing the pool is the public way to
 * invalidate it; `createProviderTransportHealth` in
 * `provider-transport-recovery.ts` owns the question of when that is justified.
 * Returns whether a rebuild happened, so the caller can record it.
 */
export function rebuildNodeNetworkTransport(
  now = Date.now(),
): TransportRebuildResult {
  ensurePatched();
  const route = activeNodeTransportRoute();
  if (now - lastTransportRebuildAt < PROVIDER_TRANSPORT_REBUILD_MIN_INTERVAL_MS) {
    return { rebuilt: false, route };
  }
  lastTransportRebuildAt = now;
  const customSettings = activeCustomSettings;
  const rebuilt = customSettings
    ? createCustomProxyDispatchers(customSettings)
    : null;
  if (rebuilt) {
    installCustomProxyDispatchers(rebuilt);
    return { rebuilt: true, route: rebuilt.route };
  }

  const previous = getGlobalDispatcher();
  const fresh = defaultDispatcher();
  setGlobalDispatcher(fresh);
  // `restoreDefault` reinstalls the captured dispatcher, so never leave that
  // reference pointing at the pool this rebuild just closed.
  if (previous === originalDispatcher) originalDispatcher = fresh;
  closeDispatcher(previous);
  return { rebuilt: true, route };
}

export type ProxyBypassMatcher = (hostname: string, port: number) => boolean;

function originIsBypassed(
  origin: string | URL | undefined,
  bypass: ProxyBypassMatcher,
): boolean {
  if (!origin) return false;
  let url: URL;
  try {
    url = typeof origin === "string" ? new URL(origin) : origin;
  } catch {
    return false;
  }
  const port = url.port
    ? Number(url.port)
    : url.protocol === "https:" || url.protocol === "wss:"
      ? 443
      : 80;
  return bypass(url.hostname, port);
}

function normalizeHost(value: string): string {
  return value.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

function ipv4ToInt(host: string): number | null {
  const match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return null;
  let value = 0;
  for (let i = 1; i <= 4; i += 1) {
    const octet = Number(match[i]);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

function isLoopbackHost(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
  const ipv4 = ipv4ToInt(host);
  return ipv4 !== null && ipv4 >>> 24 === 127;
}

type BypassRule = (hostname: string, port: number) => boolean;

/**
 * One rule from a Chromium-style bypass list: `host`, `.suffix`, `*.suffix`,
 * `*suffix`, `host:port`, an IP literal, an IPv4 CIDR block, or `<local>`.
 * A bare hostname also covers its subdomains, matching the `NO_PROXY`
 * convention the same list is exported under for child processes.
 */
function parseBypassRule(raw: string): BypassRule | null {
  const entry = raw.trim().toLowerCase();
  if (!entry) return null;
  if (entry === "<local>") {
    // Simple hostnames (no dot) plus loopback; IPv6 literals have no dot
    // either but are addresses, not local names.
    return (hostname) =>
      (!hostname.includes(".") && !hostname.includes(":")) ||
      isLoopbackHost(hostname);
  }
  let hostPart = entry;
  let port: number | undefined;
  const bracketed = entry.match(/^(\[[^\]]+\])(?::(\d+))?$/);
  if (bracketed) {
    hostPart = bracketed[1];
    if (bracketed[2]) port = Number(bracketed[2]);
  } else if ((entry.match(/:/g) ?? []).length === 1) {
    const [host, portText] = entry.split(":");
    if (portText && /^\d+$/.test(portText)) {
      hostPart = host;
      port = Number(portText);
    }
  }
  const portMatches = (candidate: number) => port === undefined || port === candidate;
  const cidr = hostPart.match(/^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/);
  if (cidr) {
    const network = ipv4ToInt(cidr[1]);
    const bits = Number(cidr[2]);
    if (network === null || bits > 32) return null;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (hostname, candidatePort) => {
      const address = ipv4ToInt(hostname);
      return (
        address !== null &&
        ((address & mask) >>> 0) === ((network & mask) >>> 0) &&
        portMatches(candidatePort)
      );
    };
  }
  let host = normalizeHost(hostPart);
  let wildcard = false;
  while (host.startsWith("*")) {
    wildcard = true;
    host = host.slice(1);
  }
  const suffixOnly = host.startsWith(".");
  host = host.replace(/^\.+/, "");
  if (!host) return null;
  if (wildcard && !suffixOnly) {
    // `*foo.com`: any host ending in the text, including `foo.com` itself.
    return (hostname, candidatePort) =>
      hostname.endsWith(host) && portMatches(candidatePort);
  }
  return (hostname, candidatePort) =>
    (hostname === host || hostname.endsWith(`.${host}`)) &&
    portMatches(candidatePort);
}

/** Compile a comma-separated bypass list into a host/port predicate. */
export function proxyBypassMatcher(bypass: string): ProxyBypassMatcher {
  const rules = bypass
    .split(",")
    .map((entry) => parseBypassRule(entry))
    .filter((rule): rule is BypassRule => rule !== null);
  return (hostname, port) => {
    const host = normalizeHost(hostname);
    if (!host) return false;
    return rules.some((rule) => rule(host, port));
  };
}

function socksConnector(proxy: ParsedProxyUrl): buildConnector.connector {
  return (options, callback) => {
    const hostname = options.hostname || options.host || "";
    const port = Number(options.port) || (options.protocol === "http:" ? 80 : 443);
    void socks5Connect(proxy, hostname, port)
      .then((socket) => {
        if (options.protocol === "https:") {
          const tlsSocket = tlsConnect({
            socket,
            host: hostname,
            servername: options.servername || hostname,
            ALPNProtocols: ["http/1.1"],
          });
          tlsSocket.once("secureConnect", () => callback(null, tlsSocket));
          tlsSocket.once("error", (error) => callback(error, null));
          return;
        }
        callback(null, socket);
      })
      .catch((error: Error) => callback(error, null));
  };
}

