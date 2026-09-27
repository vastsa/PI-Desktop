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

export const DEFAULT_NETWORK_PROXY_BYPASS =
  "localhost,127.0.0.1,::1,<local>";

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

export type NetworkProxySettings = {
  mode: NetworkProxyMode;
  /** Required when `mode` is `custom`. Canonical proxy URL. */
  url?: string;
  /**
   * Comma-separated bypass list. Absent uses
   * {@link DEFAULT_NETWORK_PROXY_BYPASS} for custom mode.
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
    return { ok: true, value: { mode: settings.mode } };
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
    proxyRules: parsed.value.href,
    proxyBypassRules: effectiveProxyBypass(settings),
  };
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
