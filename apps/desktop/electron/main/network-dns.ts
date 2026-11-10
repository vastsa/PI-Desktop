import { lookup as systemDnsLookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { isIP, type LookupFunction } from "node:net";
import {
  chromiumDnsConfig,
  normalizeNetworkDns,
  type ChromiumDnsConfig,
  type NetworkDnsSettings,
} from "@pi-desktop/shared";

const DNS_OPERATION_TIMEOUT_MS = 10_000;
type AddressFamily = 0 | 4 | 6;
type LookupOptions = { family?: AddressFamily; signal?: AbortSignal };
type NativeResolveOptions = { queryType?: "A" | "AAAA"; secureDnsPolicy: "allow" };

export type NativeDnsDependencies = {
  platform: string;
  configureHostResolver: (config: ChromiumDnsConfig) => void;
  clearHostResolverCache: () => Promise<void>;
  resolveHost: (host: string, options: NativeResolveOptions) => Promise<{
    endpoints: Array<{ address: string; family: string }>;
  }>;
  systemLookup?: (host: string, family: AddressFamily) => Promise<LookupAddress[]>;
};

function dnsError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

/** Bound native operations without claiming to cancel Chromium's shared query. */
function bounded<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = () => { finish(); reject(signal.reason); };
    const timer = setTimeout(() => {
      finish();
      reject(dnsError("ETIMEOUT", "Desktop DNS operation timed out"));
    }, DNS_OPERATION_TIMEOUT_MS);
    signal.addEventListener("abort", onAbort, { once: true });
    // Always observe the native promise, including completion after timeout.
    task.then((result) => { finish(); resolve(result); }, (error) => { finish(); reject(error); });
    if (signal.aborted) onAbort();
  });
}

/**
 * One owner for Desktop's native resolver configuration and lookup generation.
 * No global dns.lookup patch, custom DNS cache, or independently selected route.
 */
export function createNetworkDnsController(deps: NativeDnsDependencies) {
  let applied: NetworkDnsSettings = { mode: "system" };
  let effectiveKey = "system";
  let generation = new AbortController();
  let applyQueue = Promise.resolve();
  let applyError: unknown;
  let disposed = false;
  const systemLookup = deps.systemLookup ?? ((host, family) =>
    systemDnsLookup(host, { all: true, verbatim: true, family }));

  function assertAvailable(): void {
    if (disposed) throw dnsError("ECANCELED", "Desktop DNS resolver disposed");
    if (applyError) throw applyError;
  }

  function apply(value: unknown): Promise<NetworkDnsSettings> {
    const next = normalizeNetworkDns(value);
    const operation = applyQueue.then(async () => {
      if (disposed) throw dnsError("ECANCELED", "Desktop DNS resolver disposed");
      const config = chromiumDnsConfig(next, deps.platform);
      const nextKey = next.mode === "system" ? "system" : JSON.stringify(config);
      if (nextKey === effectiveKey && !applyError) {
        applied = next;
        return { ...applied };
      }
      generation.abort(dnsError("EAI_AGAIN", "Desktop DNS configuration changed"));
      generation = new AbortController();
      try {
        deps.configureHostResolver(config);
        await bounded(deps.clearHostResolverCache(), generation.signal);
        if (disposed) throw dnsError("ECANCELED", "Desktop DNS resolver disposed");
        applied = next;
        effectiveKey = nextKey;
        applyError = undefined;
        return { ...applied };
      } catch (error) {
        // Persisted secure DNS must not silently degrade after an apply failure.
        applyError = error;
        throw error;
      }
    });
    // Keep later writes recoverable while returning this failure to its caller.
    applyQueue = operation.then(() => {}, () => {});
    return operation;
  }

  async function resolveAddresses(host: string, options: LookupOptions = {}) {
    // A later write can be queued while we wait for an earlier cache clear.
    let barrier: Promise<void>;
    do {
      barrier = applyQueue;
      await barrier;
    } while (barrier !== applyQueue);
    assertAvailable();
    const epoch = generation.signal;
    const signal = options.signal ? AbortSignal.any([epoch, options.signal]) : epoch;
    signal.throwIfAborted();
    const family = options.family ?? 0;
    const literalFamily = isIP(host);
    let task: Promise<LookupAddress[]>;
    if (literalFamily) {
      task = Promise.resolve([{ address: host, family: literalFamily }]);
    } else if (applied.mode === "system") {
      task = systemLookup(host, family);
    } else {
      const nativeOptions: NativeResolveOptions = { secureDnsPolicy: "allow" };
      if (family) nativeOptions.queryType = family === 4 ? "A" : "AAAA";
      task = deps.resolveHost(host, nativeOptions).then(({ endpoints }) => endpoints.map((entry) => ({
        address: entry.address,
        family: entry.family === "ipv4" ? 4 : entry.family === "ipv6" ? 6 : isIP(entry.address),
      })));
    }
    const results = await bounded(task, signal);
    signal.throwIfAborted();
    const seen = new Set<string>();
    const addresses = results.filter((entry) => {
      const valid = (entry.family === 4 || entry.family === 6)
        && isIP(entry.address) === entry.family && (!family || family === entry.family);
      if (!valid || seen.has(entry.address)) return false;
      seen.add(entry.address);
      return true;
    });
    if (!addresses.length) throw dnsError("ENOTFOUND", "Desktop DNS returned no usable address");
    return { addresses, signal };
  }

  async function lookupAll(host: string, options: LookupOptions = {}): Promise<LookupAddress[]> {
    const result = await resolveAddresses(host, options);
    result.signal.throwIfAborted();
    return result.addresses;
  }

  const lookup: LookupFunction = (host, options, callback) => {
    const family = options.family === 4 || options.family === 6 ? options.family : 0;
    void resolveAddresses(host, { family }).then((result) => {
      result.signal.throwIfAborted();
      if (options.all) callback(null, result.addresses);
      else callback(null, result.addresses[0].address, result.addresses[0].family);
    }).catch((error: unknown) => {
      callback(error instanceof Error ? error : new Error("Desktop DNS lookup failed"), "", 4);
    });
  };

  return {
    apply,
    lookup,
    lookupAll,
    current: (): NetworkDnsSettings => ({ ...applied }),
    dispose: () => {
      disposed = true;
      generation.abort(dnsError("ECANCELED", "Desktop DNS resolver disposed"));
    },
  };
}
