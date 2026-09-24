/**
 * Aggregator for user-configured MCP market sources.
 *
 * Lives in the main process because the renderer's CSP only allows localhost
 * connections — the same reason models.dev fetching sits here. Two source
 * kinds are supported: registry endpoints speaking the official MCP registry
 * protocol (`/v0/servers`) and static catalog JSON files in the market's
 * built-in schema.
 *
 * Registry sources stream in incrementally: the first browse loads two pages
 * so the market paints fast, and each "load more" extends the window by
 * another batch from the remembered cursor. The registry holds thousands of
 * servers — more than any user will scroll — so there is deliberately no
 * "load everything". Searches always hit the registry server-side and see the
 * whole catalog regardless of what is cached. One failing source only costs
 * itself, and a total outage degrades to the built-in catalog.
 */
import { net, session } from "electron";
import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import { isIP } from "node:net";
import {
  classifyIpLiteral,
  classifyProxyRoute,
  isAcceptableResolvedAddress,
  isAcceptableUserEndpointAddress,
  isSafeMarketSourceUrl,
  isSafePublicHttpsUrl,
  mapRegistryServer,
  sanitizeMarketSources,
  validateMcpCatalogFile,
  type EndpointOrigin,
  type MarketSource,
  type PublicNetworkRoute,
  type RegistryRecord,
  type SourcedCatalogEntry,
} from "@pi-desktop/shared";
import {
  allowInsecureUserEndpointsEnabled,
  noteInsecureUserEndpoint,
  relaxedNetworkPolicyEnabled,
} from "./endpoint-policy";

const PAGE_SIZE = 100;
/** First browse paints two pages; every "load more" appends this many. */
const INITIAL_PAGES = 2;
const MORE_PAGES = 10;
const CACHE_TTL_MS = 5 * 60_000;
const TIMEOUT_MS = 8_000;
const MAX_HOPS = 5;
const MAX_SOURCE_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_QUERY_LENGTH = 200;
const MAX_CACHE_ENTRIES = 128;
const MAX_MARKET_SOURCES = 16;
const MAX_CACHED_ENTRIES = 2_000;

type ResolvedAddress = { address: string; family: 4 | 6; route: PublicNetworkRoute };
type PolicyResponse = {
  status: number;
  headers: { get: (name: string) => string | null };
  body: string;
};

export type McpRegistrySearchResult = {
  entries: SourcedCatalogEntry[];
  /** Sources that could not be fetched (unsafe URL, offline, bad payload). */
  failedSources: string[];
  /** False while a registry source still has cursor pages left to stream in. */
  exhausted: boolean;
};

function registryUrl(endpoint: string, params: URLSearchParams): string {
  const parsed = new URL(endpoint);
  for (const [key, value] of params) parsed.searchParams.set(key, value);
  return parsed.toString();
}

function headerValue(headers: IncomingHttpHeaders, name: string): string | null {
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0] ?? null;
  return typeof value === "string" ? value : null;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error("source DNS lookup timed out")), timeoutMs);
      promise.finally(() => clearTimeout(timer)).catch(() => undefined);
    }),
  ]);
}

async function resolveProxyRoute(url: string, timeoutMs: number): Promise<PublicNetworkRoute> {
  try {
    return classifyProxyRoute(
      await withTimeout(session.defaultSession.resolveProxy(url), timeoutMs),
    );
  } catch {
    return "unknown";
  }
}

/**
 * Resolve a public hostname once and return the address that must be used for
 * the connection. The caller must not resolve the hostname again: doing so
 * would reopen a DNS-rebinding race between the policy check and the socket.
 */
async function resolvePublicUrl(
  url: string,
  timeoutMs: number,
  origin: EndpointOrigin,
): Promise<ResolvedAddress> {
  const userSupplied = origin === "user";
  // A source URL the user typed may be a LAN or loopback catalog; plain http
  // needs the stored opt-in. Every redirect target is judged by the public-only
  // policy instead, so a source cannot hand the app an internal address to dial.
  const accepted = userSupplied
    ? isSafeMarketSourceUrl(url, { allowInsecureHttp: allowInsecureUserEndpointsEnabled() })
    : isSafePublicHttpsUrl(url);
  if (!accepted) {
    throw new Error("url rejected by the public-network policy");
  }
  const deadline = Date.now() + timeoutMs;
  const parsed = new URL(url);
  const host = parsed.hostname.toLowerCase().replace(/\.+$/, "");
  if (userSupplied && parsed.protocol === "http:") {
    noteInsecureUserEndpoint(host);
  }
  const literal = host.startsWith("[") ? host.slice(1, -1) : host;
  const route = await resolveProxyRoute(url, timeoutMs);
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("market source request timed out");
  const literalFamily = isIP(literal);
  if (literalFamily === 4 || literalFamily === 6) {
    return { address: literal, family: literalFamily, route };
  }
  const addresses = await withTimeout(
    lookup(host, { all: true, verbatim: true }),
    remaining,
  );
  if (!addresses.length) throw new Error(`hostname does not resolve: ${host}`);
  // Fake-IP answers are a property of the network policy, not of the proxy
  // switch: the relaxed mode tolerates a transparent router's placeholders.
  const allowFakeIp = relaxedNetworkPolicyEnabled();
  for (const address of addresses) {
    const addressKind = classifyIpLiteral(address.address);
    const acceptable = userSupplied
      ? isAcceptableUserEndpointAddress(address.address, addressKind, route)
      : isAcceptableResolvedAddress(addressKind, route);
    if (!acceptable && !(allowFakeIp && addressKind === "benchmark")) {
      throw new Error(
        `hostname resolves to a non-public address: ${host} -> ${address.address} (${addressKind}, ${route} route)`,
      );
    }
  }
  const first = addresses[0];
  if (first.family !== 4 && first.family !== 6) {
    throw new Error(`hostname resolved with an unsupported address family: ${host}`);
  }
  return { address: first.address, family: first.family, route };
}

/**
 * Make a bounded HTTPS GET to the already-approved address. The original host
 * remains the TLS SNI and HTTP Host value, while the socket hostname is the
 * resolved IP, so the address checked above is the address actually dialed.
 */
function requestPinnedHttps(
  url: string,
  resolved: ResolvedAddress,
  timeoutMs: number,
): Promise<PolicyResponse> {
  // The name keeps its history: for a source URL that is `https` this is the
  // SSL-pinning path, and for one the user typed as `http` it is the same path
  // with the plaintext module and the same pinned address.
  const parsed = new URL(url);
  const host = parsed.hostname.startsWith("[")
    ? parsed.hostname.slice(1, -1)
    : parsed.hostname;
  return new Promise((resolve, reject) => {
    let settled = false;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const clearDeadline = () => {
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      deadlineTimer = undefined;
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearDeadline();
      reject(error);
    };
    const secure = parsed.protocol === "https:";
    // A plaintext LAN source is a user endpoint under the stored opt-in, so the
    // pinned path speaks http for it too. The address pinned to the socket is
    // still the one the guard checked, and the Host header is still the original
    // host (there is no SNI on a plaintext connection).
    const send = (secure ? httpsRequest : httpRequest) as typeof httpsRequest;
    const req = send(
      {
        protocol: parsed.protocol,
        hostname: resolved.address,
        family: resolved.family,
        ...(parsed.port ? { port: parsed.port } : {}),
        path: `${parsed.pathname}${parsed.search}`,
        method: "GET",
        ...(secure ? { servername: isIP(host) ? undefined : host } : {}),
        headers: {
          Host: parsed.host,
          Accept: "application/json, text/plain;q=0.9",
        },
        // Keep the resolver pinned even if the HTTP implementation attempts a
        // second lookup internally.
        lookup: (_hostname, _options, callback) =>
          callback(null, resolved.address, resolved.family),
      },
      (response) => {
        const contentLength = Number(headerValue(response.headers, "content-length"));
        if (Number.isFinite(contentLength) && contentLength > MAX_SOURCE_RESPONSE_BYTES) {
          const error = new Error("market source response is too large");
          fail(error);
          response.resume();
          req.destroy(error);
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += buffer.byteLength;
          if (bytes > MAX_SOURCE_RESPONSE_BYTES) {
            const error = new Error("market source response is too large");
            fail(error);
            response.resume();
            req.destroy(error);
            return;
          }
          chunks.push(buffer);
        });
        response.on("aborted", () => fail(new Error("market source response was aborted")));
        response.on("error", (error) => fail(error));
        response.on("end", () => {
          if (settled) return;
          settled = true;
          clearDeadline();
          const headers = response.headers;
          resolve({
            status: response.statusCode ?? 0,
            headers: { get: (name) => headerValue(headers, name) },
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    deadlineTimer = setTimeout(
      () => req.destroy(new Error("market source request timed out")),
      Math.max(1, timeoutMs),
    );
    req.setTimeout(Math.max(1, timeoutMs), () => req.destroy(new Error("market source request timed out")));
    req.on("error", (error) => fail(error));
    req.end();
  });
}
async function readProxiedResponseBody(response: Response): Promise<string> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_SOURCE_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("market source response is too large");
  }
  if (!response.body) {
    const body = await response.text();
    if (Buffer.byteLength(body, "utf8") > MAX_SOURCE_RESPONSE_BYTES) {
      throw new Error("market source response is too large");
    }
    return body;
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      bytes += chunk.byteLength;
      if (bytes > MAX_SOURCE_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error("market source response is too large");
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    reader.releaseLock();
  }
}
// Fetch through the session's proxy stack; the session owns DNS resolution.
async function requestProxiedHttps(url: string, timeoutMs: number): Promise<PolicyResponse> {
  const response = await net.fetch(url, {
    redirect: "manual",
    signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
  });
  return {
    status: response.status,
    headers: { get: (name) => response.headers.get(name) },
    body: await readProxiedResponseBody(response),
  };
}

/**
 * pinned addresses ensure direct requests go only to an approved public IP;
 * proxied requests stay inside the session's configured proxy stack.
 */
async function fetchPolicy<T>(url: string, kind: "json" | "text"): Promise<T> {
  let current = url;
  const deadline = Date.now() + TIMEOUT_MS;
  for (let hop = 0; hop <= MAX_HOPS; hop += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("market source request timed out");
    const resolved = await resolvePublicUrl(
      current,
      remaining,
      hop === 0 ? "user" : "third-party",
    );
    const response =
      resolved.route === "proxied"
        ? await requestProxiedHttps(current, deadline - Date.now())
        : await requestPinnedHttps(current, resolved, deadline - Date.now());
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error("redirect without a location header");
      current = new URL(location, current).toString();
      continue;
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`source responded ${response.status}`);
    }
    if (kind === "text") return response.body as T;
    try {
      return JSON.parse(response.body) as T;
    } catch {
      throw new Error("source returned invalid JSON");
    }
  }
  throw new Error("too many redirects");
}

/** Per-registry-source streaming state, so "load more" continues a cursor. */
type RegistryBrowse = {
  entries: SourcedCatalogEntry[];
  cursor?: string;
  exhausted: boolean;
  at: number;
};

type CachedSearch = { at: number; state: RegistryBrowse };

function putBounded<K, V>(cache: Map<K, V>, key: K, value: V): void {
  if (cache.has(key)) cache.delete(key);
  while (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  cache.set(key, value);
}

function sourceKey(source: MarketSource): string {
  return `${source.id}|${source.url}`;
}

function ingest(
  records: RegistryRecord[],
  source: MarketSource,
  seen: Set<string>,
  into: SourcedCatalogEntry[],
  limit = MAX_CACHED_ENTRIES,
): void {
  for (const record of records) {
    if (into.length >= limit) break;
    const entry = mapRegistryServer(record);
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    into.push({ ...entry, sourceId: source.id });
  }
}
export function createMcpMarketAggregator() {
  const registryBrowse = new Map<string, RegistryBrowse>();
  const registryInflight = new Map<string, Promise<RegistryBrowse>>();
  const catalogCache = new Map<string, { at: number; entries: SourcedCatalogEntry[] }>();
  const searchCache = new Map<string, CachedSearch>();

  async function extendRegistry(source: MarketSource, pages: number): Promise<RegistryBrowse> {
    const key = sourceKey(source);
    const inflight = registryInflight.get(key);
    if (inflight) return inflight;
    const task = (async () => {
      let state = registryBrowse.get(key);
      if (!state) {
        state = { entries: [], exhausted: false, at: Date.now() };
        putBounded(registryBrowse, key, state);
      }
      for (let page = 0; page < pages && !state.exhausted; page += 1) {
        const params = new URLSearchParams({ version: "latest", limit: String(PAGE_SIZE) });
        if (state.cursor) params.set("cursor", state.cursor);
        const body = await fetchPolicy<{
          servers?: RegistryRecord[];
          metadata?: { nextCursor?: string };
        }>(registryUrl(source.url, params), "json");
        const seen = new Set(state.entries.map((entry) => entry.id));
        const previousCursor = state.cursor;
        ingest(body.servers ?? [], source, seen, state.entries);
        state.at = Date.now();
        if (state.entries.length >= MAX_CACHED_ENTRIES) {
          state.exhausted = true;
        } else if (body.metadata?.nextCursor && body.metadata.nextCursor !== previousCursor) {
          state.cursor = body.metadata.nextCursor;
        } else {
          state.exhausted = true;
        }
      }
      return state;
    })();
    registryInflight.set(key, task);
    try {
      return await task;
    } catch (error) {
      registryBrowse.delete(key);
      throw error;
    } finally {
      registryInflight.delete(key);
    }
  }

  async function browseRegistry(source: MarketSource, more: boolean): Promise<RegistryBrowse> {
    const key = sourceKey(source);
    let state = registryBrowse.get(key);
    if (state && Date.now() - state.at >= CACHE_TTL_MS) {
      registryBrowse.delete(key);
      state = undefined;
    }
    if (!state || (more && !state.exhausted)) {
      return extendRegistry(source, more ? MORE_PAGES : INITIAL_PAGES);
    }
    return state;
  }

  async function loadCatalog(source: MarketSource): Promise<SourcedCatalogEntry[]> {
    const key = sourceKey(source);
    const hit = catalogCache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.entries;
    const body = await fetchPolicy<unknown>(source.url, "json");
    const { catalog, warnings } = validateMcpCatalogFile(body);
    if (catalog.servers.length === 0 && warnings.length > 0) {
      throw new Error("catalog contains no valid entries");
    }
    const entries = catalog.servers.map((entry) => ({ ...entry, sourceId: source.id }));
    putBounded(catalogCache, key, { at: Date.now(), entries });
    return entries;
  }

  async function searchRegistry(
    source: MarketSource,
    query: string,
    more: boolean,
  ): Promise<RegistryBrowse> {
    const key = `${sourceKey(source)}|${query}`;
    const hit = searchCache.get(key);
    const fresh = hit !== undefined && Date.now() - hit.at < CACHE_TTL_MS;
    if (fresh && !more) return hit!.state;
    const state = fresh ? hit!.state : { entries: [], exhausted: false, at: Date.now() };
    if (state.exhausted) return state;
    const params = new URLSearchParams({ version: "latest", search: query, limit: String(PAGE_SIZE) });
    if (state.cursor) params.set("cursor", state.cursor);
    const body = await fetchPolicy<{
      servers?: RegistryRecord[];
      metadata?: { nextCursor?: string };
    }>(registryUrl(source.url, params), "json");
    const seen = new Set(state.entries.map((entry) => entry.id));
    ingest(body.servers ?? [], source, seen, state.entries);
    state.at = Date.now();
    if (state.entries.length >= MAX_CACHED_ENTRIES) {
      state.exhausted = true;
    } else {
      const previousCursor = state.cursor;
      if (body.metadata?.nextCursor && body.metadata.nextCursor !== previousCursor) {
        state.cursor = body.metadata.nextCursor;
      } else {
        state.exhausted = true;
      }
    }
    putBounded(searchCache, key, { at: state.at, state });
    return state;
  }

  async function search(
    query: string,
    sources: MarketSource[],
    options: { more?: boolean } = {},
  ): Promise<McpRegistrySearchResult> {
    const trimmed = String(query ?? "").trim().toLowerCase().slice(0, MAX_QUERY_LENGTH);
    const insecure = allowInsecureUserEndpointsEnabled();
    const configured = sanitizeMarketSources(sources, {
      allowInsecureHttp: insecure,
    }).slice(0, MAX_MARKET_SOURCES);
    const safe = configured.filter((source) =>
      isSafeMarketSourceUrl(source.url, { allowInsecureHttp: insecure }),
    );
    const failedSources = configured
      .filter((source) => !isSafeMarketSourceUrl(source.url, { allowInsecureHttp: insecure }))
      .map((source) => source.name);

    if (trimmed) {
      const settled = await Promise.allSettled(
        safe.map((source) =>
          source.kind === "registry"
            ? searchRegistry(source, trimmed, options.more === true)
            : loadCatalog(source).then((entries) => ({
                entries: entries.filter((entry) =>
                  [entry.name, entry.description, entry.author]
                    .filter(Boolean)
                    .some((text) => text!.toLocaleLowerCase().includes(trimmed)),
                ),
                exhausted: true,
              })),
        ),
      );
      const entries: SourcedCatalogEntry[] = [];
      const seen = new Set<string>();
      let exhausted = true;
      settled.forEach((result, index) => {
        if (result.status === "rejected") {
          failedSources.push(safe[index].name);
          return;
        }
        for (const entry of result.value.entries) {
          if (seen.has(entry.id)) continue;
          seen.add(entry.id);
          entries.push(entry);
        }
        if (!result.value.exhausted) exhausted = false;
      });
      return { entries, failedSources, exhausted };
    }

    const settled = await Promise.allSettled(
      safe.map((source) =>
        source.kind === "registry"
          ? browseRegistry(source, options.more === true).then((state) => ({
              entries: state.entries,
              exhausted: state.exhausted,
            }))
          : loadCatalog(source).then((entries) => ({ entries, exhausted: true })),
      ),
    );
    const entries: SourcedCatalogEntry[] = [];
    const seen = new Set<string>();
    let exhausted = true;
    settled.forEach((result, index) => {
      if (result.status === "rejected") {
        failedSources.push(safe[index].name);
        return;
      }
      for (const entry of result.value.entries) {
        if (seen.has(entry.id)) continue;
        seen.add(entry.id);
        entries.push(entry);
      }
      if (!result.value.exhausted) exhausted = false;
    });
    return { entries, failedSources, exhausted };
  }

  return { search };
}

/** Shared main-process instance so caches survive across IPC calls. */
const aggregator = createMcpMarketAggregator();

export function searchMcpMarket(
  query: string,
  sources: MarketSource[],
  options: { more?: boolean } = {},
): Promise<McpRegistrySearchResult> {
  return aggregator.search(query, sources, options);
}
