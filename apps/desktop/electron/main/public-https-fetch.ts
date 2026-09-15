import { lookup as dnsLookup } from "node:dns/promises";
import {
  ErrorCodes,
  PUBLIC_NETWORK_POLICY_ERROR,
  isPublicIpLiteral,
  isPublicNetworkPolicyFailure,
  isSafePublicHttpsUrl,
} from "@pi-desktop/shared";

const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_HOPS = 5;
const MAX_ATTEMPTS = 3;

export type PublicHttpsFetch = (
  url: string,
  init: { redirect: "manual"; signal: AbortSignal },
) => Promise<Response>;

export type PublicHttpsLookup = (host: string) => Promise<Array<{ address: string }>>;

export class PublicNetworkPolicyError extends Error {
  readonly code = "PUBLIC_NETWORK_POLICY";
  /**
   * Stable code the IPC wrapper forwards to the renderer, so a policy refusal
   * can be told apart from an ordinary network failure (spec 08 §3.1).
   */
  readonly errorCode = ErrorCodes.NETWORK_POLICY_BLOCKED;
  constructor(message: string) {
    super(message);
    this.name = PUBLIC_NETWORK_POLICY_ERROR;
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
 * Main-process HTTPS client: syntactic guard, DNS classification, and
 * per-hop re-validation of redirects. Fetch and lookup are injectable so
 * tests can exercise the policy without Electron or the network.
 */
export function createPublicHttpsClient(options: {
  fetchImpl: PublicHttpsFetch;
  lookupImpl?: PublicHttpsLookup;
  timeoutMs?: number;
} ): PublicHttpsClient {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const lookupImpl =
    options.lookupImpl ??
    (async (host: string) => dnsLookup(host, { all: true }));

  async function assertPublicUrl(url: string): Promise<void> {
    if (!isSafePublicHttpsUrl(url)) {
      throw new PublicNetworkPolicyError(`url rejected by the public-network policy: ${url}`);
    }
    const host = new URL(url).hostname.toLowerCase().replace(/\.+$/, "");
    if (host.startsWith("[") || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return;
    const addresses = await lookupImpl(host);
    if (!addresses.length) throw new PublicNetworkPolicyError(`hostname does not resolve: ${host}`);
    for (const address of addresses) {
      if (!isPublicIpLiteral(address.address)) {
        throw new PublicNetworkPolicyError(`hostname resolves to a private address: ${host} -> ${address.address}`);
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
    throw new PublicNetworkPolicyError("too many redirects");
  }

  async function request(url: string, kind: "json" | "text"): Promise<unknown> {
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      try {
        return await requestOnce(url, kind);
      } catch (error) {
        lastError = error;
        if (isPublicNetworkPolicyError(error) || attempt === MAX_ATTEMPTS - 1) throw error;
      }
    }
    throw lastError;
  }

  return { assertPublicUrl, request };
}
