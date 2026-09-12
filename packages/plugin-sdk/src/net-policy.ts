/**
 * Plugin egress policy.
 *
 * Reading a secret is only half of an exfiltration; the other half is an
 * outbound request. Permissions cannot express "read broadly but leak nothing",
 * so the host keeps a single per-plugin domain allowlist and enforces it at
 * every egress chokepoint it owns: the panel session, `pi.net.fetch`, and
 * remote MCP endpoints. Absent `manifest.net.domains`, a plugin gets no egress
 * at all — which is what makes a generous `fs.read` grant affordable.
 */

/** Hostname, or `*.suffix` for "this domain and its subdomains". */
export type PluginNetDomain = string;

const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

/** Hostnames cloud providers answer with instance credentials. */
const CLOUD_METADATA_HOSTS = new Set([
  "169.254.169.254",
  "metadata.google.internal",
  "metadata",
  "instance-data",
  "100.100.100.200",
  "fd00:ec2::254",
]);

/**
 * Whether an allowlist entry admits a loopback, link-local, or cloud metadata
 * host. Such an entry gives the plugin a path to local services and instance
 * credentials that the egress allowlist exists to keep it from, so tooling
 * warns about it; the entry itself stays valid because a plugin that talks to
 * a local daemon is a legitimate, if unusual, design.
 */
export function isLocalNetDomain(entry: string): boolean {
  const value = entry.trim().toLowerCase().replace(/\.$/, "");
  const bare = value.startsWith("*.") ? value.slice(2) : value;
  if (!bare) return false;
  if (bare === "localhost" || bare.endsWith(".localhost")) return true;
  if (bare === "0.0.0.0" || bare === "::1" || bare === "::") return true;
  if (CLOUD_METADATA_HOSTS.has(bare)) return true;
  const ipv4 = bare.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const first = Number(ipv4[1]);
    const second = Number(ipv4[2]);
    if (first === 127) return true;
    if (first === 169 && second === 254) return true;
    return false;
  }
  // IPv6 link-local (fe80::/10) and IPv4-mapped loopback.
  if (/^fe[89ab][0-9a-f]:/.test(bare)) return true;
  if (bare === "::ffff:127.0.0.1") return true;
  return false;
}

/**
 * Validate `manifest.net.domains`. Patterns are hostnames only: no scheme, no
 * port, no path, and no bare `*`. A plugin that genuinely needs arbitrary hosts
 * has to ask the user at call time instead of declaring its way there.
 */
export function parseNetDomains(raw: unknown): {
  ok: boolean;
  domains?: string[];
  error?: string;
} {
  if (raw === undefined) return { ok: true, domains: [] };
  if (!Array.isArray(raw)) return { ok: false, error: "net.domains must be an array" };
  const domains: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string" || !entry.trim()) {
      return { ok: false, error: "net.domains entries must be non-empty strings" };
    }
    const value = entry.trim().toLowerCase();
    if (value === "*") {
      return { ok: false, error: 'net.domains must not contain "*"; list the hosts you call' };
    }
    if (/[:/?#]/.test(value)) {
      return {
        ok: false,
        error: `net.domains entry must be a bare hostname: ${entry}`,
      };
    }
    const bare = value.startsWith("*.") ? value.slice(2) : value;
    if (!bare || !HOSTNAME.test(bare)) {
      return { ok: false, error: `net.domains entry is not a valid hostname: ${entry}` };
    }
    if (!domains.includes(value)) domains.push(value);
  }
  return { ok: true, domains };
}

/** Match a hostname against one parsed allowlist entry. */
function matchesDomain(host: string, pattern: string): boolean {
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(2);
    return host === suffix || host.endsWith(`.${suffix}`);
  }
  return host === pattern;
}

/** True when `host` is covered by the allowlist. An empty list allows nothing. */
export function isNetHostAllowed(host: string, domains: readonly string[]): boolean {
  const value = host.trim().toLowerCase().replace(/\.$/, "");
  if (!value) return false;
  return domains.some((pattern) => matchesDomain(value, pattern));
}

/**
 * True when a URL may be requested. Only http(s) is considered: other schemes
 * are decided by the caller, because what is safe differs per chokepoint (a
 * panel may load its own `file://` assets; `pi.net.fetch` may not).
 */
export function isNetUrlAllowed(url: string, domains: readonly string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
  return isNetHostAllowed(parsed.hostname, domains);
}
