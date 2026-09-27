/**
 * Apply the persisted network proxy to Chromium sessions, Node env, and
 * Electron `net.fetch` (D340 / ADR 0177).
 */
import { app, net, session, type Session } from "electron";
import {
  applyProxyEnvAssignments,
  chromiumProxyConfig,
  normalizeNetworkProxy,
  parseProxyUrl,
  proxyEnvAssignments,
  restoreProxyEnv,
  snapshotProxyEnv,
  validateNetworkProxy,
  type ChromiumProxyConfig,
  type NetworkProxySettings,
} from "@pi-desktop/shared";

const originalEnv = snapshotProxyEnv(process.env);
let applied: NetworkProxySettings = { mode: "system" };
let fetchPatched = false;
let sessionHookInstalled = false;

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

  const config = chromiumProxyConfig(next);
  installSessionHook();
  await applyToSession(session.defaultSession, config);
  try {
    await applyToSession(session.fromPartition("persist:work-browser"), config);
  } catch {
    // Partition may not exist yet; session-created will catch it.
  }
  installMainFetch();
  return next;
}

export async function applyNetworkProxyFromAppSettings(
  settings: unknown,
): Promise<NetworkProxySettings> {
  const record =
    settings && typeof settings === "object"
      ? (settings as { networkProxy?: unknown })
      : {};
  return applyNetworkProxy(record.networkProxy ?? { mode: "system" });
}

function installSessionHook(): void {
  if (sessionHookInstalled) return;
  sessionHookInstalled = true;
  app.on("session-created", (ses) => {
    void applyToSession(ses, chromiumProxyConfig(applied));
  });
}

function installMainFetch(): void {
  if (fetchPatched) return;
  fetchPatched = true;
  globalThis.fetch = net.fetch.bind(net) as typeof fetch;
}

async function applyToSession(
  ses: Session,
  config: ChromiumProxyConfig,
): Promise<void> {
  await ses.setProxy(config);
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
  try {
    await applyToSession(ses, chromiumProxyConfig(validated.value));
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
