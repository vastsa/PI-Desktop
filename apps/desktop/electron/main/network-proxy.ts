/**
 * Apply the persisted network proxy to Chromium sessions, Node env, and
 * Electron `net.fetch` (D340 / ADR 0177).
 *
 * Chromium `proxyRules` cannot carry userinfo and cannot speak SOCKS5
 * username/password, so credentialed custom proxies are applied through a
 * loopback SOCKS5 relay (issue #490). Sidecar and curl keep the canonical
 * URL with credentials.
 */
import { app, net, session, type Session } from "electron";
import {
  applyProxyEnvAssignments,
  chromiumProxyConfig,
  normalizeNetworkProxy,
  parseProxyUrl,
  proxyEnvAssignments,
  proxyHasCredentials,
  restoreProxyEnv,
  snapshotProxyEnv,
  validateNetworkProxy,
  type ChromiumProxyConfig,
  type NetworkProxySettings,
  type NetworkDnsSettings,
} from "@pi-desktop/shared";
import {
  startAuthenticatedProxyRelay,
  type AuthenticatedProxyRelay,
} from "@pi-desktop/agent-runtime";
import { applyUserEndpointPolicyFromAppSettings } from "./endpoint-policy";
import {
  startSystemProxyRelay,
  type SystemProxyRelay,
} from "@pi-desktop/agent-runtime/system-proxy-relay";
import { createNetworkDnsController } from "./network-dns";

const originalEnv = snapshotProxyEnv(process.env);
let applied: NetworkProxySettings = { mode: "system" };
let fetchPatched = false;
let sessionHookInstalled = false;
let activeRelay: AuthenticatedProxyRelay | null = null;
let relayUpstreamHref: string | null = null;
let systemProxyRelay: SystemProxyRelay | null = null;
let systemProxyRelayStart: Promise<SystemProxyRelay> | null = null;
let networkSettingsQueue = Promise.resolve();
const knownSessions = new Set<Session>();
const nativeDns = createNetworkDnsController({
  platform: process.platform,
  configureHostResolver: (config) => app.configureHostResolver(config),
  clearHostResolverCache: async () => {
    knownSessions.add(session.defaultSession);
    await Promise.all([...knownSessions].map((ses) => ses.clearHostResolverCache()));
  },
  resolveHost: (host, options) => session.defaultSession.resolveHost(host, options),
});

export const lookupDesktopHost = nativeDns.lookupAll;

export function currentNetworkDns(): NetworkDnsSettings {
  return nativeDns.current();
}

export async function ensureSystemProxyRelay(): Promise<string> {
  if (!systemProxyRelay) {
    const starting =
      systemProxyRelayStart ??
      (systemProxyRelayStart = startSystemProxyRelay(
        (url) => session.defaultSession.resolveProxy(url),
        { lookup: nativeDns.lookup },
      ));
    try {
      systemProxyRelay = await starting;
    } finally {
      if (systemProxyRelayStart === starting) systemProxyRelayStart = null;
    }
  }
  return systemProxyRelay.url;
}

export function currentSystemProxyRelayUrl(): string | null {
  return systemProxyRelay?.url ?? null;
}

export async function disposeSystemProxyRelay(): Promise<void> {
  nativeDns.dispose();
  knownSessions.clear();
  if (sessionHookInstalled) app.off("session-created", onSessionCreated);
  sessionHookInstalled = false;
  const pending = systemProxyRelayStart;
  const relay = systemProxyRelay ?? (pending ? await pending : null);
  systemProxyRelay = null;
  if (systemProxyRelayStart === pending) systemProxyRelayStart = null;
  await relay?.close();
}

export function currentNetworkProxy(): NetworkProxySettings {
  return applied;
}

export async function applyNetworkProxy(
  settings: unknown,
): Promise<NetworkProxySettings> {
  const next = normalizeNetworkProxy(
    settings && typeof settings === "object"
      ? (settings as { networkProxy?: unknown }).networkProxy ?? settings
      : settings,
  );
  applied = next;
  if (next.mode === "system") restoreProxyEnv(originalEnv, process.env);
  else applyProxyEnvAssignments(proxyEnvAssignments(next), process.env);
  if (next.mode === "custom") {
    process.env.PI_DESKTOP_PROXY_JSON = JSON.stringify(next);
  } else {
    delete process.env.PI_DESKTOP_PROXY_JSON;
  }

  installSessionHook();
  const previous = activeRelay;
  const previousHref = relayUpstreamHref;
  let started: AuthenticatedProxyRelay | null = null;
  try {
    const resolved = await chromiumConfigFor(next, true);
    started = resolved.relay;
    activeRelay = started;
    relayUpstreamHref = credentialedHref(next);
    await applyResolvedConfig(resolved.config);
  } catch (error) {
    activeRelay = previous;
    relayUpstreamHref = previousHref;
    if (started && started !== previous) await started.close();
    throw error;
  }
  if (previous && previous !== started) await previous.close();
  installMainFetch();
  return next;
}

export function applyNetworkProxyFromAppSettings(
  settings: unknown,
): Promise<NetworkProxySettings> {
  const record = settings && typeof settings === "object"
    ? settings as { networkProxy?: unknown; networkDns?: unknown }
    : {};
  const operation = networkSettingsQueue.then(async () => {
    applyUserEndpointPolicyFromAppSettings(settings);
    installSessionHook();
    await nativeDns.apply(record.networkDns);
    return applyNetworkProxy(record.networkProxy ?? { mode: "system" });
  });
  // Preserve write order, but let a subsequent valid write recover from failure.
  networkSettingsQueue = operation.then(() => {}, () => {});
  return operation;
}

function installSessionHook(): void {
  if (sessionHookInstalled) return;
  sessionHookInstalled = true;
  knownSessions.add(session.defaultSession);
  app.on("session-created", onSessionCreated);
}

function onSessionCreated(ses: Session): void {
  knownSessions.add(ses);
  void applyToSession(ses, chromiumConfigFromApplied()).catch((error: unknown) => {
    console.error("Failed to apply the Desktop proxy to a new session", error);
  });
}

function chromiumConfigFromApplied(): ChromiumProxyConfig {
  const config = chromiumProxyConfig(applied);
  if (activeRelay && "proxyRules" in config) {
    return {
      proxyRules: activeRelay.url,
      proxyBypassRules: config.proxyBypassRules,
    };
  }
  return config;
}

function installMainFetch(): void {
  if (fetchPatched) return;
  fetchPatched = true;
  globalThis.fetch = net.fetch.bind(net) as typeof fetch;
}

async function applyResolvedConfig(config: ChromiumProxyConfig): Promise<void> {
  await applyToSession(session.defaultSession, config);
  try {
    await applyToSession(session.fromPartition("persist:work-browser"), config);
  } catch {
    // Partition may not exist yet; session-created will catch it.
  }
}

async function applyToSession(
  ses: Session,
  config: ChromiumProxyConfig,
): Promise<void> {
  await ses.setProxy(config);
}

type ResolvedChromiumProxy = {
  config: ChromiumProxyConfig;
  relay: AuthenticatedProxyRelay | null;
};

function credentialedHref(settings: NetworkProxySettings): string | null {
  if (settings.mode !== "custom") return null;
  const parsed = parseProxyUrl(settings.url ?? "");
  if (!parsed.ok || !proxyHasCredentials(parsed.value)) return null;
  return parsed.value.href;
}

async function chromiumConfigFor(
  settings: NetworkProxySettings,
  reuseExisting: boolean,
): Promise<ResolvedChromiumProxy> {
  const config = chromiumProxyConfig(settings);
  if (settings.mode !== "custom" || !("proxyRules" in config)) {
    return { config, relay: null };
  }
  const parsed = parseProxyUrl(settings.url ?? "");
  if (!parsed.ok || !proxyHasCredentials(parsed.value)) {
    return { config, relay: null };
  }
  if (
    reuseExisting &&
    activeRelay &&
    relayUpstreamHref === parsed.value.href
  ) {
    return {
      config: {
        proxyRules: activeRelay.url,
        proxyBypassRules: config.proxyBypassRules,
      },
      relay: activeRelay,
    };
  }
  const relay = await startAuthenticatedProxyRelay(parsed.value, { lookup: nativeDns.lookup });
  return {
    config: {
      proxyRules: relay.url,
      proxyBypassRules: config.proxyBypassRules,
    },
    relay,
  };
}

const PROXY_TEST_URL = "https://github.com/robots.txt";
const PROXY_TEST_TIMEOUT_MS = 8_000;

export async function testNetworkProxy(
  settings: unknown,
): Promise<{ ok: boolean; error?: string }> {
  const validated = validateNetworkProxy(
    settings && typeof settings === "object" && "mode" in (settings as object)
      ? settings
      : normalizeNetworkProxy(settings),
  );
  if (!validated.ok) return { ok: false, error: validated.error };
  const partition = `proxy-test-${Date.now().toString(36)}`;
  const ses = session.fromPartition(partition);
  let relay: AuthenticatedProxyRelay | null = null;
  try {
    const resolved = await chromiumConfigFor(validated.value, false);
    relay = resolved.relay;
    await applyToSession(ses, resolved.config);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROXY_TEST_TIMEOUT_MS);
    try {
      const res = await ses.fetch(PROXY_TEST_URL, {
        method: "GET",
        signal: controller.signal,
      });
      if (res.status >= 500) {
        return { ok: false, error: `HTTP ${res.status}` };
      }
      return { ok: true };
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message };
  } finally {
    await relay?.close();
  }
}

export function assertCustomProxyUrl(url: string): string {
  const parsed = parseProxyUrl(url);
  if (!parsed.ok) {
    const err = new Error(parsed.error) as Error & { errorCode?: string };
    err.errorCode = "INVALID_PARAMS";
    throw err;
  }
  return parsed.value.href;
}
