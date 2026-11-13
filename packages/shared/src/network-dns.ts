/** Desktop-local DNS policy. Effects belong to Electron's native resolver. */
export type NetworkDnsSettings = {
  mode: "system" | "doh";
  /** RFC 8484 HTTPS POST endpoint, retained when mode is system. */
  serverUrl?: string;
  /** Explicit permission to fall back to unencrypted system DNS. */
  allowSystemFallback?: boolean;
};

/** An IP-literal endpoint avoids a system DNS bootstrap for the default. */
export const DEFAULT_DOH_SERVER_URL = "https://1.1.1.1/dns-query";
export const DOH_SERVER_URL_MAX_LENGTH = 2048;

type DnsValidation =
  | { ok: true; value: NetworkDnsSettings }
  | { ok: false; error: string };

export function validateNetworkDns(value: unknown): DnsValidation {
  if (value == null) return { ok: true, value: { mode: "system" } };
  if (typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "networkDns must be an object" };
  }
  const record = value as Record<string, unknown>;
  const mode = record.mode ?? "system";
  if (mode !== "system" && mode !== "doh") {
    return { ok: false, error: "networkDns.mode must be system or doh" };
  }
  const next: NetworkDnsSettings = { mode };
  if (record.serverUrl !== undefined) {
    if (typeof record.serverUrl !== "string") {
      return { ok: false, error: "networkDns.serverUrl must be a string" };
    }
    const raw = record.serverUrl.trim();
    if (!raw || raw.length > DOH_SERVER_URL_MAX_LENGTH || /[\s\x00-\x1f\x7f{}\\]/.test(raw)) {
      return { ok: false, error: "networkDns.serverUrl must be a bounded HTTPS POST endpoint" };
    }
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return { ok: false, error: "networkDns.serverUrl is invalid" };
    }
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.hash || raw.includes("#")) {
      return { ok: false, error: "networkDns.serverUrl must use HTTPS without credentials or fragments" };
    }
    next.serverUrl = url.href;
  } else if (mode === "doh") {
    next.serverUrl = DEFAULT_DOH_SERVER_URL;
  }
  if (record.allowSystemFallback !== undefined) {
    if (typeof record.allowSystemFallback !== "boolean") {
      return { ok: false, error: "networkDns.allowSystemFallback must be a boolean" };
    }
    next.allowSystemFallback = record.allowSystemFallback;
  } else if (mode === "doh") {
    next.allowSystemFallback = false;
  }
  return { ok: true, value: next };
}

/** Tolerant reads do not turn malformed persisted settings into an opt-in. */
export function normalizeNetworkDns(value: unknown): NetworkDnsSettings {
  const result = validateNetworkDns(value);
  return result.ok ? result.value : { mode: "system" };
}

export type ChromiumDnsConfig = {
  enableBuiltInResolver: boolean;
  secureDnsMode: "automatic" | "secure";
  secureDnsServers: string[];
};

export function chromiumDnsConfig(settings: NetworkDnsSettings, platform: string): ChromiumDnsConfig {
  if (settings.mode === "system") {
    return {
      enableBuiltInResolver: platform === "darwin",
      secureDnsMode: "automatic",
      secureDnsServers: [],
    };
  }
  return {
    enableBuiltInResolver: true,
    secureDnsMode: settings.allowSystemFallback ? "automatic" : "secure",
    secureDnsServers: [settings.serverUrl ?? DEFAULT_DOH_SERVER_URL],
  };
}
