/**
 * Pure public-network policy shared by renderer validation and main-process
 * request guards. This is deliberately syntactic; callers that make network
 * requests must also pin DNS resolution to the address they validate, and ask
 * the transport which route a request will take before judging that address
 * (ADR 0272).
 */

export type PublicNetworkAddressKind =
  | "public"
  | "invalid"
  | "unspecified"
  | "loopback"
  | "private"
  | "cgnat"
  | "link-local"
  | "multicast"
  | "reserved"
  | "documentation"
  | "benchmark"
  | "ula"
  | "site-local";

/** Classify an IP literal, including IPv4 embedded in an IPv6 literal. */
export function classifyIpLiteral(ip: string): PublicNetworkAddressKind {
  if (typeof ip !== "string" || !ip) return "invalid";

  const ipv4 = parseIpv4(ip);
  if (ipv4 !== null) return classifyIpv4(ipv4);

  const ipv6 = parseIpv6(ip);
  if (!ipv6) return "invalid";

  const { groups, embeddedIpv4 } = ipv6;
  if (groups.every((group) => group === 0)) return "unspecified";
  if (groups.every((group, index) => group === (index === 7 ? 1 : 0))) return "loopback";

  // IPv4-mapped and IPv4-compatible addresses have the same network policy as
  // their embedded IPv4 address. Apply the same policy to any dotted IPv4
  // suffix so an alternate IPv6 spelling cannot bypass the check.
  if (groups.slice(0, 5).every((group) => group === 0) && (groups[5] === 0 || groups[5] === 0xffff)) {
    return classifyIpv4(groups[6] * 0x10000 + groups[7]);
  }
  const embeddedKind = embeddedIpv4 === undefined ? undefined : classifyIpv4(embeddedIpv4);

  const first = groups[0];
  const second = groups[1];

  if (first >= 0xfc00 && first <= 0xfdff) return "ula"; // fc00::/7
  if (first >= 0xfe80 && first <= 0xfebf) return "link-local"; // fe80::/10
  if (first >= 0xfec0 && first <= 0xfeff) return "site-local"; // fec0::/10
  if ((first & 0xff00) === 0xff00) return "multicast"; // ff00::/8

  // IPv6 special-purpose ranges. The complete ranges are rejected rather than
  // relying on whether a particular allocation currently routes publicly.
  if (first === 0x0064 && second === 0xff9b && groups.slice(2, 6).every((group) => group === 0)) return "reserved"; // 64:ff9b::/96
  if (first === 0x0064 && second === 0xff9b && groups[2] === 1 && groups.slice(3, 6).every((group) => group === 0)) return "reserved"; // 64:ff9b:1::/48
  if (first === 0x0100 && groups.slice(1, 4).every((group) => group === 0)) return "reserved"; // 100::/64
  if (first === 0x2001 && second === 0x0000) return "reserved"; // 2001::/32
  if (first === 0x2001 && second === 0x0002 && groups[2] === 0) return "benchmark"; // 2001:2::/48
  if (first === 0x2001 && ((second & 0xfff0) === 0x0010 || (second & 0xfff0) === 0x0020)) return "reserved"; // ORCHID/ORCHIDv2 /28 ranges
  if (first === 0x2001 && second === 0x0db8) return "documentation"; // 2001:db8::/32
  if (first === 0x2002) return "reserved"; // 6to4
  if (first === 0x3fff && (second & 0xf000) === 0) return "documentation"; // 3fff::/20
  if (embeddedKind !== undefined && embeddedKind !== "public") return embeddedKind;

  return "public";

}

/** Alias with the more general name used by callers that classify addresses. */
export function classifyIpAddress(ip: string): PublicNetworkAddressKind {
  return classifyIpLiteral(ip);
}

/** True only for an IP literal outside the special-use and non-public ranges. */
export function isPublicIpLiteral(ip: string): boolean {
  return classifyIpLiteral(ip) === "public";
}

/**
 * Check a hostname without performing DNS. Literal addresses are classified
 * directly; DNS names remain syntactically public and must be resolved and
 * checked by the main process immediately before connecting.
 */
export function isPublicHostname(hostname: string): boolean {
  if (typeof hostname !== "string") return false;
  const host = hostname.trim().toLowerCase().replace(/\.+$/, "");
  if (!host) return false;

  if (host.startsWith("[")) {
    if (!host.endsWith("]")) return false;
    return isPublicIpLiteral(host.slice(1, -1));
  }
  if (host.includes(":")) return isPublicIpLiteral(host);
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    return false;
  }

  const literal = parseIpv4(host);
  if (literal !== null) return classifyIpv4(literal) === "public";

  // WHATWG URL parses legacy numeric IPv4 forms (decimal, hexadecimal and
  // shortened dotted forms) before exposing `hostname`. Keep this direct
  // hostname helper consistent for callers that pass a hostname themselves.
  if (/^[0-9a-fx.]+$/i.test(host)) {
    try {
      const normalized = new URL(`https://${host}`).hostname.replace(/\.+$/, "");
      if (normalized !== host && parseIpv4(normalized) !== null) {
        return isPublicIpLiteral(normalized);
      }
    } catch {
      return false;
    }
  }
  return true;
}

/** Check credentials-free HTTPS URLs whose host is syntactically public. */
export function isPublicHttpsUrl(value: string): boolean {
  if (typeof value !== "string") return false;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (parsed.username || parsed.password) return false;
  return isPublicHostname(parsed.hostname);
}

/** Backward-compatible descriptive alias for the generic public URL guard. */
export const isSafePublicHttpsUrl = isPublicHttpsUrl;

/**
 * The route the transport will actually take for a URL, as the Chromium session
 * that carries the request reports it (`Session.resolveProxy`).
 *
 * `proxied` means this app dials a proxy rather than the destination, so the
 * addresses the *local* resolver returns for that host describe no connection
 * this app makes. `unknown` is never permission: a route the app cannot read
 * keeps the strict local-DNS verdict (ADR 0272).
 */
export type PublicNetworkRoute = "direct" | "proxied" | "unknown";

/** Entry types `resolveProxy` publishes, in its `TYPE host:port` list format. */
const PROXY_LIST_TYPES = ["PROXY", "HTTP", "HTTPS", "SOCKS", "SOCKS4", "SOCKS5"];
const PROXY_CHAIN_ENTRY = new RegExp(
  `^(?:${PROXY_LIST_TYPES.join("|")})\\s+\\S+(?:\\s*,\\s*(?:${PROXY_LIST_TYPES.join("|")})\\s+\\S+)*$`,
);

/**
 * Classify Chromium's proxy-list answer for one URL (`Session.resolveProxy`).
 *
 * Only a list that names at least one proxy chain and offers no `DIRECT` entry
 * proves the app's socket can be a proxy rather than the destination. A list
 * that also offers `DIRECT` stays `unknown`, because Chromium may fall back to
 * it, and an empty or unparsable answer stays `unknown` too. Nothing here
 * guesses in the permissive direction (ADR 0272).
 */
export function classifyProxyRoute(proxyList: unknown): PublicNetworkRoute {
  if (typeof proxyList !== "string") return "unknown";
  const entries = proxyList
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (!entries.length) return "unknown";
  let direct = false;
  let proxied = false;
  for (const entry of entries) {
    if (/^DIRECT$/i.test(entry)) {
      direct = true;
      continue;
    }
    if (!PROXY_CHAIN_ENTRY.test(entry)) return "unknown";
    proxied = true;
  }
  if (proxied) return direct ? "unknown" : "proxied";
  return direct ? "direct" : "unknown";
}

/**
 * Whether a resolved address class may be connected to on this route.
 *
 * A direct (or unreadable) route keeps the rule the guard always had: the app
 * dials the resolved address itself, so only a public address passes. On a
 * proxied route the app dials the proxy, and the one class the local answer can
 * then still carry is `benchmark` — the RFC 2544 range a TUN fake-IP resolver
 * synthesizes, which no internal service is addressed by. Every class that
 * names a real internal target (private, loopback, link-local, multicast, ULA,
 * site-local) refuses on both routes (ADR 0272).
 */
export function isAcceptableResolvedAddress(
  kind: PublicNetworkAddressKind,
  route: PublicNetworkRoute,
): boolean {
  if (kind === "public") return true;
  return route === "proxied" && kind === "benchmark";
}

/**
 * Name the public-network client stamps on its refusals. A caller that must
 * stay free of that client's `node:dns` dependency — the skill market
 * aggregator, which is exercised as a pure module — classifies with this
 * instead of importing the client.
 */
export const PUBLIC_NETWORK_POLICY_ERROR = "PublicNetworkPolicyError";

/** Structural check for a public-network refusal, without importing the client. */
export function isPublicNetworkPolicyFailure(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === PUBLIC_NETWORK_POLICY_ERROR
  );
}

/**
 * Why the guard refused, at the granularity a user can act on. Only
 * `non-public-address` and `url-syntax` are verdicts on the URL itself;
 * `resolve-failed` means the local resolver produced no answer at all, which is
 * an environment condition — a proxied or offline resolver — rather than a
 * policy decision about a resolved address (issue #419, ADR 0243).
 */
export type PublicNetworkRefusalReason =
  | "url-syntax"
  | "resolve-failed"
  | "non-public-address"
  | "redirect-limit";

/**
 * The structured reason a public-network refusal carries, or `undefined` for an
 * unrecognized refusal. Callers that must keep the guard's fail-closed behavior
 * but want to explain it — the skill market's classifier and its diagnostics —
 * read this instead of re-parsing the message. `undefined` is never permission:
 * a refusal that cannot name its reason is still a refusal.
 */
export function publicNetworkRefusalReason(error: unknown): PublicNetworkRefusalReason | undefined {
  if (!isPublicNetworkPolicyFailure(error)) return undefined;
  const reason = (error as { reason?: unknown }).reason;
  return reason === "url-syntax" ||
    reason === "resolve-failed" ||
    reason === "non-public-address" ||
    reason === "redirect-limit"
    ? reason
    : undefined;
}
/** A refusal's own account of itself, extractable without importing the client. */
/** A refusal's own account of itself, extractable without importing the client. */
export type PublicNetworkRefusalDetail = {
  reason: PublicNetworkRefusalReason;
  /** The hostname the guard was classifying, when it got that far. */
  host?: string;
  /** The class of the address that failed the policy, never the address. */
  addressKind?: PublicNetworkAddressKind;
  /**
   * The route that hop was judged on, when the guard could read one. `direct`
   * is why a fake-IP answer is still a refusal: the app would dial it itself
   * (ADR 0272).
   */
  route?: PublicNetworkRoute;
};

const PUBLIC_NETWORK_ADDRESS_KINDS: ReadonlyArray<PublicNetworkAddressKind> = [
  "public",
  "invalid",
  "unspecified",
  "loopback",
  "private",
  "cgnat",
  "link-local",
  "multicast",
  "reserved",
  "documentation",
  "benchmark",
  "ula",
  "site-local",
];

const PUBLIC_NETWORK_ROUTES: ReadonlyArray<PublicNetworkRoute> = ["direct", "proxied", "unknown"];

/**
 * What a refusal says about itself: why, which host, which class of address
 * failed, and which route the guard judged that hop on. Callers that must
 * explain a block — the skill market's classifier and its diagnostics — read
 * this instead of parsing the message. `addressKind` travels without the
 * address: the class is what separates a resolver artifact (`benchmark`, a TUN
 * fake-IP) from a real private target (`private`, RFC1918), and it is not a
 * secret.
 */
export function publicNetworkRefusalDetail(error: unknown): PublicNetworkRefusalDetail | undefined {
  const reason = publicNetworkRefusalReason(error);
  if (!reason) return undefined;
  const source = error as { host?: unknown; addressKind?: unknown; route?: unknown };
  const host = typeof source.host === "string" && source.host ? source.host : undefined;
  const addressKind = PUBLIC_NETWORK_ADDRESS_KINDS.includes(
    source.addressKind as PublicNetworkAddressKind,
  )
    ? (source.addressKind as PublicNetworkAddressKind)
    : undefined;
  const route = PUBLIC_NETWORK_ROUTES.includes(source.route as PublicNetworkRoute)
    ? (source.route as PublicNetworkRoute)
    : undefined;
  return {
    reason,
    ...(host ? { host } : {}),
    ...(addressKind ? { addressKind } : {}),
    ...(route ? { route } : {}),
  };
}


function parseIpv4(value: string): number | null {
  const parts = value.split(".");
  if (
    parts.length !== 4 ||
    parts.some((part) => !/^\d{1,3}$/.test(part) || (part.length > 1 && part.startsWith("0")))
  ) {
    return null;
  }
  const octets = parts.map(Number);
  if (octets.some((octet) => octet > 255)) return null;
  return (((octets[0] * 256 + octets[1]) * 256 + octets[2]) * 256 + octets[3]);
}

function classifyIpv4(value: number): PublicNetworkAddressKind {
  const first = Math.floor(value / 0x1000000);
  const second = Math.floor(value / 0x10000) % 0x100;

  if (first === 0) return "unspecified"; // 0.0.0.0/8
  if (first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168)) {
    return "private"; // RFC1918
  }
  if (first === 100 && second >= 64 && second <= 127) return "cgnat"; // 100.64.0.0/10
  if (first === 127) return "loopback"; // 127.0.0.0/8
  if (first === 169 && second === 254) return "link-local"; // 169.254.0.0/16
  if (first >= 224 && first <= 239) return "multicast"; // 224.0.0.0/4
  if (first >= 240) return "reserved"; // 240.0.0.0/4

  if (isIpv4Range(value, 192, 0, 0, 255)) return "reserved"; // 192.0.0.0/24
  if (isIpv4Range(value, 192, 31, 196, 255)) return "reserved"; // AS112
  if (isIpv4Range(value, 192, 52, 193, 255)) return "reserved"; // AMT
  if (isIpv4Range(value, 192, 88, 99, 255)) return "reserved"; // 6to4 relay anycast
  if (isIpv4Range(value, 192, 175, 48, 255)) return "reserved"; // AS112
  if (isIpv4Range(value, 192, 0, 2, 255)) return "documentation"; // TEST-NET-1
  if (isIpv4Range(value, 198, 18, 0, 65535) || isIpv4Range(value, 198, 19, 0, 65535)) return "benchmark"; // 198.18.0.0/15
  if (isIpv4Range(value, 198, 51, 100, 255)) return "documentation"; // TEST-NET-2
  if (isIpv4Range(value, 203, 0, 113, 255)) return "documentation"; // TEST-NET-3

  return "public";
}

function isIpv4Range(value: number, first: number, second: number, third: number, last: number): boolean {
  const start = (((first * 256 + second) * 256 + third) * 256);
  const end = start + last;
  return value >= start && value <= end;
}

type ParsedIpv6 = { groups: number[]; embeddedIpv4?: number };

function parseIpv6(value: string): ParsedIpv6 | null {
  if (value.includes("%")) return null;
  const halves = value.toLowerCase().split("::");
  if (halves.length > 2) return null;
  const hasCompression = halves.length === 2;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = hasCompression && halves[1] ? halves[1].split(":") : [];
  const tokens = [...head, ...tail];
  if (tokens.some((token) => !token)) return null;

  let embeddedIpv4: number | undefined;
  const expanded: string[] = [];
  for (const [index, token] of tokens.entries()) {
    if (token.includes(".")) {
      if (index !== tokens.length - 1 || embeddedIpv4 !== undefined) return null;
      const parsed = parseIpv4(token);
      if (parsed === null) return null;
      embeddedIpv4 = parsed;
      expanded.push(((parsed >>> 16) & 0xffff).toString(16), (parsed & 0xffff).toString(16));
    } else {
      expanded.push(token);
    }
  }

  if (hasCompression) {
    const fill = 8 - expanded.length;
    if (fill < 1) return null;
    expanded.splice(head.length, 0, ...Array.from({ length: fill }, () => "0"));
  } else if (expanded.length !== 8) {
    return null;
  }

  if (expanded.length !== 8) return null;
  const groups = expanded.map((group) => (/^[0-9a-f]{1,4}$/.test(group) ? parseInt(group, 16) : -1));
  if (groups.some((group) => group < 0)) return null;
  return { groups, ...(embeddedIpv4 === undefined ? {} : { embeddedIpv4 }) };
}
