/**
 * User-configurable outbound proxy (D340 / ADR 0177).
 *
 * Pure parse/validate helpers shared by the renderer, Electron main, and the
 * agent sidecar. Applying a proxy to Chromium sessions, process env, or
 * undici lives in the process that owns those surfaces.
 */

export const NETWORK_PROXY_MODES = ["system", "direct", "custom"] as const;
export type NetworkProxyMode = (typeof NETWORK_PROXY_MODES)[number];

export const NETWORK_PROXY_SCHEMES = [
  "http",
  "https",
  "socks",
  "socks5",
  "socks5h",
] as const;
export type NetworkProxyScheme = (typeof NETWORK_PROXY_SCHEMES)[number];

/**
 * Default bypass list for custom mode.
 *
 * Loopback plus the private ranges a user's own LAN devices live in. A proxy is
 * for reaching the public internet; sending `192.168.0.0/16` through it is how
 * a local model server, NAS or MCP endpoint stops answering. `<local>` keeps
 * Chromium's own single-label rule.
 */
export const DEFAULT_NETWORK_PROXY_BYPASS =
  "localhost,127.0.0.1,::1,<local>,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,169.254.0.0/16";

export const PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "NODE_USE_ENV_PROXY",
] as const;

/** Built-in fallback when entering Custom with nothing saved and no valid draft. */
export const DEFAULT_CUSTOM_PROXY_URL = "socks5://127.0.0.1:1080";

export type NetworkProxySettings = {
  mode: NetworkProxyMode;
  /**
   * Canonical proxy URL. Required when `mode` is `custom`.
   *
   * System and Direct keep it too: `mode` decides what is in effect, and the
   * URL the user configured is remembered so the Custom control restores their
   * proxy instead of the built-in default (issue #1541). Nothing applies it
   * while another mode is selected.
   */
  url?: string;
  /**
   * Comma-separated bypass list. Absent uses
   * {@link DEFAULT_NETWORK_PROXY_BYPASS} for custom mode, and kept across
   * modes like `url`.
   */
  bypass?: string;
};

export type ParsedProxyUrl = {
  href: string;
  scheme: NetworkProxyScheme;
  host: string;
  port: number | null;
  username: string;
  password: string;
  isSocks: boolean;
};

const PROXY_URL_MAX_LENGTH = 2048;

const SCHEME_SET = new Set<string>(NETWORK_PROXY_SCHEMES);

export function isNetworkProxyMode(value: unknown): value is NetworkProxyMode {
  return (
    typeof value === "string" &&
    (NETWORK_PROXY_MODES as readonly string[]).includes(value)
  );
}

export function normalizeNetworkProxy(value: unknown): NetworkProxySettings {
  const record =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  const mode = isNetworkProxyMode(record?.mode) ? record.mode : "system";
  const parsed =
    typeof record?.url === "string" ? parseProxyUrl(record.url) : null;
  const bypass =
    typeof record?.bypass === "string" ? record.bypass.trim() : "";
  const settings: NetworkProxySettings = { mode };
  if (parsed?.ok) settings.url = parsed.value.href;
  else if (typeof record?.url === "string" && record.url.trim()) {
    settings.url = record.url.trim();
  }
  if (bypass) settings.bypass = bypass;
  // A build before the network policy owned it stored `allowFakeIp` here. The
  // key is ignored, not rejected: the proxy decides where traffic goes, and
  // `networkPolicy.mode` decides what the app tolerates from the route.
  return settings;
}

export function effectiveProxyBypass(settings: NetworkProxySettings): string {
  const bypass = settings.bypass?.trim();
  return bypass || DEFAULT_NETWORK_PROXY_BYPASS;
}

export type ParseProxyUrlResult =
  | { ok: true; value: ParsedProxyUrl }
  | { ok: false; error: string };

export function parseProxyUrl(raw: string): ParseProxyUrlResult {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: false, error: "proxy URL is required" };
  }
  if (trimmed.length > PROXY_URL_MAX_LENGTH) {
    return { ok: false, error: "proxy URL is too long" };
  }
  if (/\s/.test(trimmed)) {
    return { ok: false, error: "proxy URL must not contain whitespace" };
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, error: "proxy URL is invalid" };
  }
  const scheme = url.protocol.replace(/:$/, "").toLowerCase();
  if (!SCHEME_SET.has(scheme)) {
    return {
      ok: false,
      error: "proxy scheme must be http, https, socks, socks5, or socks5h",
    };
  }
  const host = url.hostname.trim();
  if (!host) {
    return { ok: false, error: "proxy URL must include a host" };
  }
  let port: number | null = null;
  if (url.port) {
    const parsedPort = Number(url.port);
    if (
      !Number.isInteger(parsedPort) ||
      parsedPort < 1 ||
      parsedPort > 65535
    ) {
      return { ok: false, error: "proxy port must be between 1 and 65535" };
    }
    port = parsedPort;
  }
  let username: string;
  let password: string;
  try {
    username = decodeURIComponent(url.username);
    password = decodeURIComponent(url.password);
  } catch {
    return { ok: false, error: "proxy credentials are invalid" };
  }
  const isSocks = scheme.startsWith("socks");
  const href = formatProxyHref({
    scheme: scheme as NetworkProxyScheme,
    host,
    port,
    username,
    password,
  });
  return {
    ok: true,
    value: {
      href,
      scheme: scheme as NetworkProxyScheme,
      host,
      port,
      username,
      password,
      isSocks,
    },
  };
}

function formatProxyHref(parts: {
  scheme: NetworkProxyScheme;
  host: string;
  port: number | null;
  username: string;
  password: string;
}): string {
  const host =
    parts.host.includes(":") && !parts.host.startsWith("[")
      ? `[${parts.host}]`
      : parts.host;
  const port = parts.port ? `:${parts.port}` : "";
  let auth = "";
  if (parts.username || parts.password) {
    auth = `${encodeURIComponent(parts.username)}`;
    if (parts.password) auth += `:${encodeURIComponent(parts.password)}`;
    auth += "@";
  }
  return `${parts.scheme}://${auth}${host}${port}`;
}

export function validateNetworkProxy(
  value: unknown,
): { ok: true; value: NetworkProxySettings } | { ok: false; error: string } {
  const settings = normalizeNetworkProxy(value);
  if (settings.mode !== "custom") {
    // System and Direct keep the URL and bypass the user configured. `mode`
    // decides what applies, and remembering those values is what lets the
    // Custom control come back with their own proxy (issue #1541). A URL that
    // cannot describe a proxy is dropped rather than refused: it is not what
    // this write is about, and rejecting it would block the mode switch.
    const next: NetworkProxySettings = { mode: settings.mode };
    const parsed = settings.url ? parseProxyUrl(settings.url) : null;
    if (parsed?.ok) next.url = parsed.value.href;
    if (settings.bypass?.trim()) next.bypass = settings.bypass.trim();
    return { ok: true, value: next };
  }
  const parsed = parseProxyUrl(settings.url ?? "");
  if (!parsed.ok) return parsed;
  const next: NetworkProxySettings = {
    mode: "custom",
    url: parsed.value.href,
  };
  if (settings.bypass?.trim()) next.bypass = settings.bypass.trim();
  return { ok: true, value: next };
}

/**
 * Build settings when leaving Custom. The input blur handler may still be
 * saving when the mode control is clicked, so use the current drafts and keep
 * the last valid URL if the draft is invalid.
 */
export function settingsForInactiveProxyMode(
  mode: Exclude<NetworkProxyMode, "custom">,
  saved: NetworkProxySettings,
  urlDraft: string,
  bypassDraft: string,
): NetworkProxySettings {
  const parsedUrl = parseProxyUrl(urlDraft);
  const url = parsedUrl.ok ? parsedUrl.value.href : saved.url;
  const effectiveBypass = bypassDraft.trim() || DEFAULT_NETWORK_PROXY_BYPASS;
  const savedEffectiveBypass = saved.bypass ?? DEFAULT_NETWORK_PROXY_BYPASS;
  const bypass =
    effectiveBypass === savedEffectiveBypass ? saved.bypass : effectiveBypass;

  return {
    mode,
    ...(url ? { url } : {}),
    ...(bypass ? { bypass } : {}),
  };
}

/**
 * Resolve the Custom-mode URL when entering Custom. The URL draft may hold a
 * stale value the user never fixed, or be empty: a valid draft wins, but an
 * invalid one loses to the remembered `savedUrl` and only then falls back to
 * the built-in default — otherwise switching modes erases the proxy the user
 * configured (issue #1541's promise, broken in #1610). `fromDraft` is false
 * exactly when the draft was discarded, so the caller can sync the input.
 */
export function resolveCustomProxyUrl(
  urlDraft: string,
  savedUrl: string | undefined,
): { url: string; fromDraft: boolean } {
  const parsed = parseProxyUrl(urlDraft);
  if (parsed.ok) return { url: parsed.value.href, fromDraft: true };
  return { url: savedUrl ?? DEFAULT_CUSTOM_PROXY_URL, fromDraft: false };
}

export type ChromiumProxyConfig =
  | { mode: "system" }
  | { mode: "direct" }
  | { proxyRules: string; proxyBypassRules: string };

export function chromiumProxyConfig(
  settings: NetworkProxySettings,
): ChromiumProxyConfig {
  if (settings.mode === "direct") return { mode: "direct" };
  if (settings.mode !== "custom") return { mode: "system" };
  const parsed = parseProxyUrl(settings.url ?? "");
  if (!parsed.ok) return { mode: "direct" };
  return {
    proxyRules: chromiumProxyRules(parsed.value),
    proxyBypassRules: effectiveProxyBypass(settings),
  };
}

/**
 * Chromium proxy rule for one parsed proxy URL.
 *
 * Chromium understands `http`, `https`, `socks` (SOCKS5), `socks4` and
 * `socks5` proxy rules, but not curl's `socks5h` spelling: `session.setProxy`
 * accepts the unsupported rule set without an error, then resolves to no
 * proxy at all and every request fails with `net::ERR_NO_SUPPORTED_PROXIES`.
 * Chromium's SOCKS5 already hands the hostname to the proxy, so `socks5h`
 * maps onto `socks5` without changing where names are resolved.
 *
 * Userinfo is also stripped. Chromium's proxy-rule parser rejects
 * `scheme://user:pass@host:port` with the same `ERR_NO_SUPPORTED_PROXIES`
 * failure (issue #490). Electron main points Chromium at a loopback SOCKS5
 * relay that injects those credentials; Node and curl keep the canonical
 * href from {@link parseProxyUrl}.
 */
export function chromiumProxyRules(proxy: ParsedProxyUrl): string {
  return formatProxyHref({
    scheme: proxy.scheme === "socks5h" ? "socks5" : proxy.scheme,
    host: proxy.host,
    port: proxy.port,
    username: "",
    password: "",
  });
}

/** True when Chromium cannot carry the credentials in `proxyRules`. */
export function proxyHasCredentials(proxy: ParsedProxyUrl): boolean {
  return Boolean(proxy.username || proxy.password);
}

/** Bypass list suitable for `NO_PROXY` / curl `--noproxy` (no Chromium `<local>`). */
export function envProxyBypass(settings: NetworkProxySettings): string {
  return effectiveProxyBypass(settings)
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part && part !== "<local>")
    .join(",");
}

/**
 * Env assignments for a child process. `null` means the key should be
 * removed so a direct/custom switch cannot leak a previous value.
 */
export function proxyEnvAssignments(
  settings: NetworkProxySettings,
): Record<string, string | null> {
  const assignments: Record<string, string | null> = {};
  for (const key of PROXY_ENV_KEYS) assignments[key] = null;
  if (settings.mode !== "custom") return assignments;
  const parsed = parseProxyUrl(settings.url ?? "");
  if (!parsed.ok) return assignments;
  const href = parsed.value.href;
  const bypass = envProxyBypass(settings);
  assignments.ALL_PROXY = href;
  assignments.all_proxy = href;
  assignments.NO_PROXY = bypass;
  assignments.no_proxy = bypass;
  assignments.NODE_USE_ENV_PROXY = "1";
  if (!parsed.value.isSocks) {
    assignments.HTTP_PROXY = href;
    assignments.HTTPS_PROXY = href;
    assignments.http_proxy = href;
    assignments.https_proxy = href;
  }
  return assignments;
}

export type ProxyEnvMap = Record<string, string | undefined>;

export function snapshotProxyEnv(
  env: ProxyEnvMap,
): Record<string, string | undefined> {
  const snapshot: Record<string, string | undefined> = {};
  for (const key of PROXY_ENV_KEYS) snapshot[key] = env[key];
  return snapshot;
}

export function applyProxyEnvAssignments(
  assignments: Record<string, string | null>,
  env: ProxyEnvMap,
): void {
  for (const [key, value] of Object.entries(assignments)) {
    if (value === null) delete env[key];
    else env[key] = value;
  }
}

export function restoreProxyEnv(
  snapshot: Record<string, string | undefined>,
  env: ProxyEnvMap,
): void {
  for (const key of PROXY_ENV_KEYS) {
    const value = snapshot[key];
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
}

export function stripProxyEnv(env: ProxyEnvMap): ProxyEnvMap {
  const next: ProxyEnvMap = { ...env };
  for (const key of PROXY_ENV_KEYS) delete next[key];
  return next;
}

export function redactProxyUrl(raw: string): string {
  const parsed = parseProxyUrl(raw);
  if (!parsed.ok) return raw;
  if (!parsed.value.username && !parsed.value.password) return parsed.value.href;
  return formatProxyHref({
    scheme: parsed.value.scheme,
    host: parsed.value.host,
    port: parsed.value.port,
    username: parsed.value.username ? parsed.value.username : "",
    password: parsed.value.password ? "***" : "",
  });
}
