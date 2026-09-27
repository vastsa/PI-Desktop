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
