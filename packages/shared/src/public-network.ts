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
 * Cloud instance-metadata services answer with the host's own credentials, so
 * no user-supplied endpoint may name one: a settings field carrying such an
 * address is an injected SSRF payload far more often than it is a service the
 * user runs themselves.
 */
const CLOUD_METADATA_HOSTNAMES = new Set([
  "metadata.google.internal",
  "metadata",
  "instance-data",
]);

const CLOUD_METADATA_ADDRESSES = new Set([
  "169.254.169.254",
  "100.100.100.200",
  "fd00:ec2::254",
]);

/** A hostname with its brackets, trailing dot and case normalized away. */
function bareHostname(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .replace(/\.+$/, "");
}

/** Whether a hostname names a cloud instance-metadata service. */
export function isCloudMetadataHost(hostname: string): boolean {
  if (typeof hostname !== "string") return false;
  const host = bareHostname(hostname);
  return CLOUD_METADATA_HOSTNAMES.has(host) || isCloudMetadataAddress(host);
}

/** The dotted-quad spelling of a 32-bit IPv4 address. */
function dottedIpv4(value: number): string {
  return [value >>> 24, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff].join(".");
}

/**
 * Whether an IP literal names a cloud instance-metadata service.
 *
 * The comparison runs on the address a literal *means*, never on its spelling:
 * `::ffff:169.254.169.254`, `::ffff:a9fe:a9fe` and `::169.254.169.254` all name
 * the IPv4 metadata service, and `fd00:ec2:0:0:0:0:0:254` is the same address as
 * `fd00:ec2::254`. A spelling this guard failed to recognize would be a way to
 * reach the host's own credentials, so every equivalent form is folded here.
 */
export function isCloudMetadataAddress(address: string): boolean {
  if (typeof address !== "string") return false;
  const host = bareHostname(address);
  if (!host) return false;
  if (CLOUD_METADATA_ADDRESSES.has(host)) return true;

  const ipv4 = parseIpv4(host);
  if (ipv4 !== null) return CLOUD_METADATA_ADDRESSES.has(dottedIpv4(ipv4));

  const ipv6 = parseIpv6(host);
  if (!ipv6) return false;
  const { groups } = ipv6;
  // AWS's IPv6 metadata address, in any spelling.
  if (
    groups[0] === 0xfd00 &&
    groups[1] === 0x0ec2 &&
    groups[7] === 0x0254 &&
    groups.slice(2, 7).every((group) => group === 0)
  ) {
    return true;
  }
  // IPv4-mapped and IPv4-compatible literals carry the IPv4 address itself.
  if (
    groups.slice(0, 5).every((group) => group === 0) &&
    (groups[5] === 0 || groups[5] === 0xffff)
  ) {
    return CLOUD_METADATA_ADDRESSES.has(dottedIpv4(groups[6] * 0x10000 + groups[7]));
  }
  return false;
}

/**
 * Address classes a *user-supplied* endpoint may reach.
 *
 * The public-network guard exists to stop third-party content — a market
 * catalog, a registry record, a redirect — from turning this app into a probe
 * of the machine's own network. A host the user typed in themselves is a
 * different trust input: a model endpoint, an MCP server, a market source URL
 * and a git remote are all chosen by the person sitting in front of the app,
 * who already knows that machine. Refusing those addresses pushes the same work
 * outside the app without removing the request, so loopback, RFC1918, CGNAT,
 * link-local, ULA and site-local are reachable here.
 *
 * The classes that name no destination at all (`unspecified`, `multicast`,
 * `reserved`, `documentation`, `invalid`) and cloud metadata stay refused on
 * every input, because none of them is a service the user could mean.
 */
export function isAcceptableUserEndpointAddress(
  address: string,
  kind: PublicNetworkAddressKind,
  route: PublicNetworkRoute,
): boolean {
  if (isCloudMetadataAddress(address)) return false;
  switch (kind) {
    case "public":
    case "loopback":
    case "private":
    case "cgnat":
    case "link-local":
    case "ula":
    case "site-local":
      return true;
    case "benchmark":
      // A TUN fake-IP answer on a proxied route is the proxy's own placeholder
      // rather than an address this app dials (ADR 0272); on a direct route it
      // still names no reachable service.
      return route === "proxied";
    default:
      return false;
  }
}

/**
 * Check a user-supplied endpoint hostname without performing DNS. Literal
 * addresses are classified directly; a DNS name is syntactically acceptable and
 * the address it resolves to is judged by
 * {@link isAcceptableUserEndpointAddress}.
 */
export function isUserSuppliedHostname(hostname: string): boolean {
  if (typeof hostname !== "string") return false;
  const host = bareHostname(hostname);
  if (!host) return false;
  if (isCloudMetadataHost(host)) return false;

  if (host.includes(":")) {
    return isAcceptableUserEndpointAddress(host, classifyIpLiteral(host), "direct");
  }
  const literal = parseIpv4(host);
  if (literal !== null) {
    return isAcceptableUserEndpointAddress(host, classifyIpv4(literal), "direct");
  }
  // WHATWG URL normalizes legacy numeric IPv4 forms (decimal, hexadecimal and
  // shortened dotted forms) before exposing `hostname`. Keep a hostname handed
  // in directly consistent with one that came out of `new URL(...).hostname`.
  if (/^[0-9a-fx.]+$/i.test(host)) {
    try {
      const normalized = bareHostname(new URL(`https://${host}`).hostname);
      if (normalized !== host) {
        const normalizedLiteral = parseIpv4(normalized);
        if (normalizedLiteral !== null) {
          return isAcceptableUserEndpointAddress(
            normalized,
            classifyIpv4(normalizedLiteral),
            "direct",
          );
        }
      }
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Check a credentials-free URL whose host the user entered themselves.
 *
 * `http` is accepted only under an explicit opt-in, because on a LAN it is an
 * unencrypted hop that carries whatever credentials the endpoint takes — the
 * same shape ADR 0300 uses for a WebDAV endpoint. `https` to a private host
 * needs no opt-in: the transport is still protected, and the address is the
 * user's own choice.
 */
export function isSafeUserEndpointUrl(
  value: string,
  options: { allowInsecureHttp?: boolean } = {},
): boolean {
  if (typeof value !== "string") return false;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
  if (parsed.protocol === "http:" && options.allowInsecureHttp !== true) return false;
  if (parsed.username || parsed.password) return false;
  return isUserSuppliedHostname(parsed.hostname);
}

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
  /**
   * The address that failed the policy, validated as an IP literal before it is
   * carried. It is the local resolver's answer for `host`, not the user's input
   * and not a URL component, and it is the single most diagnostic field a
   * refusal has: `198.18.0.1` reads as a proxy's fake-IP at a glance.
   */
  address?: string;
  /** That address's class, which is what separates a proxy artifact from a target. */
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
 * The address classes a local proxy hands back for a name it means to resolve
 * itself, instead of the target's own address. `benchmark` is RFC 2544's
 * `198.18.0.0/15`, which Clash, Mihomo, sing-box and Surge all ship as their
 * default fake-IP pool — and `2001:2::/48` in IPv6.
 *
 * A caller uses this to explain a block correctly, never to lift one: an address
 * in this class still fails `isPublicIpLiteral`, and the guard still refuses it
 * unless the route says this app dials a proxy instead of that address
 * (ADR 0272, issue #419).
 */
export function isProxyFakeIpAddress(kind: PublicNetworkAddressKind | undefined): boolean {
  return kind === "benchmark";
}

/**
 * What a refusal says about itself: why, which host, which address it resolved
 * to, which class that address fell into, and which route the guard judged that
 * hop on. Callers that must explain a block — the skill market's classifier and
 * its diagnostics — read this instead of parsing the message.
 *
 * The address and its class travel together: the address is what the user
 * recognises (`198.18.0.1` is unmistakably a proxy's fake-IP) and the class is
 * what a machine decides on; `route` is what decides whether that fake-IP class
 * was tolerated or refused (ADR 0272). Neither the address nor the class is a
 * secret — both are the local resolver's answer for a hostname the user supplied
 * — and neither is a URL, a path, a query or a credential.
 */
export function publicNetworkRefusalDetail(error: unknown): PublicNetworkRefusalDetail | undefined {
  const reason = publicNetworkRefusalReason(error);
  if (!reason) return undefined;
  const source = error as {
    host?: unknown;
    address?: unknown;
    addressKind?: unknown;
    route?: unknown;
  };
  const host = typeof source.host === "string" && source.host ? source.host : undefined;
  const addressKind = PUBLIC_NETWORK_ADDRESS_KINDS.includes(
    source.addressKind as PublicNetworkAddressKind,
  )
    ? (source.addressKind as PublicNetworkAddressKind)
    : undefined;
  // Only a well-formed IP literal travels: a refusal must never be a channel for
  // putting arbitrary resolver text into a log line or a settings page.
  const address =
    typeof source.address === "string" && classifyIpLiteral(source.address) !== "invalid"
      ? source.address
      : undefined;
  const route = PUBLIC_NETWORK_ROUTES.includes(source.route as PublicNetworkRoute)
    ? (source.route as PublicNetworkRoute)
    : undefined;
  return {
    reason,
    ...(host ? { host } : {}),
    ...(address ? { address } : {}),
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
