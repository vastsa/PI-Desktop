import { lookup as dnsLookup } from "node:dns/promises";
import {
  ErrorCodes,
  PUBLIC_NETWORK_POLICY_ERROR,
  classifyIpLiteral,
  classifyProxyRoute,
  isAcceptableResolvedAddress,
  isPublicNetworkPolicyFailure,
  isSafePublicHttpsUrl,
  publicNetworkRefusalReason,
  type PublicNetworkAddressKind,
  type PublicNetworkRefusalReason,
  type PublicNetworkRoute,
} from "@pi-desktop/shared";

const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_HOPS = 5;
const MAX_ATTEMPTS = 3;

export type PublicHttpsFetch = (
  url: string,
  init: { redirect: "manual"; signal: AbortSignal },
) => Promise<Response>;

export type PublicHttpsLookup = (host: string) => Promise<Array<{ address: string }>>;

/**
 * The route the transport will actually take for one URL, as the session that
 * carries `fetchImpl` reports it (`Session.resolveProxy`). Injectable so this
 * module stays free of Electron: a caller wires the same session whose `fetch`
 * it passes in, and a caller that wires nothing keeps the strict verdict
 * (ADR 0272).
 */
export type PublicHttpsRouteLookup = (url: string) => Promise<string>;

/** The resolver's own error code, for the log line. Never its message. */
function resolverCode(error: unknown): string {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" && /^[A-Z0-9_]{1,32}$/.test(code) ? ` (${code})` : "";
}

/** The structured description of a refusal; see `PublicNetworkRefusalReason`. */
export type PublicNetworkRefusal = {
  reason: PublicNetworkRefusalReason;
  /** The hostname the guard was classifying, when it got that far. */
  host?: string;
  /** The address that failed the policy (`non-public-address` only). */
  address?: string;
  /** That address's class — `benchmark` for a TUN fake-IP, `private` for RFC1918. */
  addressKind?: PublicNetworkAddressKind;
  /** The route the hop was judged on, when the transport could name one. */
  route?: PublicNetworkRoute;
};

export class PublicNetworkPolicyError extends Error {
  readonly code = "PUBLIC_NETWORK_POLICY";
  /**
   * Stable code the IPC wrapper forwards to the renderer, so a policy refusal
   * can be told apart from an ordinary network failure (spec 08 §3.1). A
   * refusal that judged no address reports `NETWORK_RESOLVE_FAILED`: "the local
   * resolver had no answer" and "the resolved address is not public" need
   * different fixes, so they must not share one explanation (issue #419).
   */
  readonly errorCode: string;
  /** Which refusal this is, so a caller can explain it without parsing text. */
  readonly reason: PublicNetworkRefusalReason;
  /** The hostname the refusal is about, when the guard knows it. */
  readonly host?: string;
  /** The address that made this a refusal (`non-public-address` only). */
  readonly address?: string;
  /** The class of `address`, not just the address: it names the cause. */
  readonly addressKind?: PublicNetworkAddressKind;
  /** The route the refusal was judged on, when the guard could read one. */
  readonly route?: PublicNetworkRoute;
  constructor(message: string, refusal: PublicNetworkRefusal = { reason: "non-public-address" }) {
    super(message);
    this.name = PUBLIC_NETWORK_POLICY_ERROR;
    this.reason = refusal.reason;
    this.host = refusal.host;
    this.address = refusal.address;
    this.addressKind = refusal.addressKind;
    this.route = refusal.route;
    this.errorCode =
      refusal.reason === "resolve-failed"
        ? ErrorCodes.NETWORK_RESOLVE_FAILED
        : ErrorCodes.NETWORK_POLICY_BLOCKED;
  }
}

export function isPublicNetworkPolicyError(error: unknown): boolean {
  return error instanceof PublicNetworkPolicyError || isPublicNetworkPolicyFailure(error);
}

export type PublicHttpsClient = {
  assertPublicUrl: (url: string) => Promise<void>;
  request: (url: string, kind: "json" | "text") => Promise<unknown>;
};

/**
 * Main-process HTTPS client: syntactic guard, per-hop route and address
 * classification, and per-hop re-validation of redirects. Fetch, lookup, and
 * route are injectable so tests can exercise the policy without Electron or the
 * network.
 *
 * Every branch still fails closed. The structured `reason` and the
 * `NETWORK_RESOLVE_FAILED` code change what the app can *say* about a block —
 * which host, which class of address, and which route it was judged on — never
 * whether it blocks (issue #419).
 *
 * The address verdict follows the route the request will actually take. On a
 * proxied route this app dials the proxy rather than the destination, so only
 * the resolver-artifact class is tolerated there, and every class that names a
 * real internal target still refuses. A route the transport cannot name keeps
 * the strict verdict (ADR 0272).
 */
export function createPublicHttpsClient(options: {
  fetchImpl: PublicHttpsFetch;
  lookupImpl?: PublicHttpsLookup;
  /** Must be the session that carries `fetchImpl`; absent stays strict. */
  routeImpl?: PublicHttpsRouteLookup;
  timeoutMs?: number;
} ): PublicHttpsClient {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const lookupImpl =
    options.lookupImpl ??
    (async (host: string) => dnsLookup(host, { all: true }));

  /**
   * The route for one hop, asked immediately before that hop is dialed. A
   * transport that cannot answer, or answers something this policy cannot read,
   * is `unknown`, which is never permission (ADR 0272).
   */
  async function hopRoute(url: string): Promise<PublicNetworkRoute> {
    if (!options.routeImpl) return "unknown";
    try {
      return classifyProxyRoute(await options.routeImpl(url));
    } catch {
      return "unknown";
    }
  }

  async function assertPublicUrl(url: string): Promise<void> {
    if (!isSafePublicHttpsUrl(url)) {
      throw new PublicNetworkPolicyError(`url rejected by the public-network policy: ${url}`, {
        reason: "url-syntax",
      });
    }
    const host = new URL(url).hostname.toLowerCase().replace(/\.+$/, "");
    if (host.startsWith("[") || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return;
    const route = await hopRoute(url);
    let addresses: Array<{ address: string }>;
    try {
      addresses = await lookupImpl(host);
    } catch (error) {
      // Node's resolver throws (ENOTFOUND, EAI_AGAIN, a stub that refuses)
      // instead of returning an empty answer, so a proxied, split-horizon or
      // offline resolver lands here. Nothing was classified: still refused, but
      // this is the absence of a verdict, not a verdict on an address (#419).
      throw new PublicNetworkPolicyError(`hostname does not resolve: ${host}${resolverCode(error)}`, {
        reason: "resolve-failed",
        host,
        route,
      });
    }
    if (!addresses.length) {
      throw new PublicNetworkPolicyError(`hostname does not resolve: ${host}`, {
        reason: "resolve-failed",
        host,
        route,
      });
    }
    for (const address of addresses) {
      const addressKind = classifyIpLiteral(address.address);
      if (!isAcceptableResolvedAddress(addressKind, route)) {
        // The class travels with the refusal: `benchmark` is a TUN fake-IP
        // (198.18.0.0/15) and `private` is a real RFC1918 target, and only the
        // class tells those apart in the log and in the panel. The route travels
        // with it too: a fake-IP answer is tolerated on a proxied route because
        // this app never dials it, and refused on a direct or unreadable route
        // because this app would (ADR 0272).
        throw new PublicNetworkPolicyError(
          `hostname resolves to a non-public address: ${host} -> ${address.address} (${addressKind}, ${route} route)`,
          { reason: "non-public-address", host, address: address.address, addressKind, route },
        );
      }
    }
  }

  async function requestOnce(url: string, kind: "json" | "text"): Promise<unknown> {
    let current = url;
    for (let hop = 0; hop <= MAX_HOPS; hop += 1) {
      await assertPublicUrl(current);
      const response = await options.fetchImpl(current, {
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw new Error("redirect without a location header");
        current = new URL(location, current).toString();
        continue;
      }
      if (!response.ok) throw new Error(`responded ${response.status}`);
      return kind === "json" ? ((await response.json()) as unknown) : await response.text();
    }
    throw new PublicNetworkPolicyError("too many redirects", { reason: "redirect-limit" });
  }

  async function request(url: string, kind: "json" | "text"): Promise<unknown> {
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      try {
        return await requestOnce(url, kind);
      } catch (error) {
        lastError = error;
        // A refusal the guard decided is final: a syntax rejection, a
        // non-public address, a redirect loop. A resolver that answered nothing
        // is not final — every attempt re-classifies from scratch, so a
        // transient DNS failure can still succeed inside this loop.
        const settled =
          isPublicNetworkPolicyError(error) &&
          publicNetworkRefusalReason(error) !== "resolve-failed";
        if (settled || attempt === MAX_ATTEMPTS - 1) throw error;
      }
    }
    throw lastError;
  }

  return { assertPublicUrl, request };
}
