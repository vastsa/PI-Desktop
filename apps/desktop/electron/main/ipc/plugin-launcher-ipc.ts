/**
 * IPC surface for the plugin launcher (`Alt+Space`).
 *
 * Two rules shape this module:
 *
 * 1. Only the launcher window may call it. Launching a local application is a
 *    capability the main window does not need, and no plugin can reach it: the
 *    channels are not exposed through `pluginBridge`, and the sender check
 *    rejects anything that is not the launcher's own `webContents`.
 * 2. The renderer never sees a path. It gets display metadata and an opaque
 *    `app:<slug>` id; `launch` resolves that id against the host's own scan, so
 *    a compromised renderer cannot ask for an arbitrary executable.
 *
 * Docs: docs/spec/07-plugins/18-plugin-launcher.md
 */
import type { BrowserWindow } from "electron";
import {
  IPC,
  LAUNCHER_PAYLOAD_MAX_LENGTH,
  type LauncherAppEntry,
  type LauncherCatalog,
  type LauncherOpenAppRequest,
  type LauncherPluginEntry,
  type LauncherTriggerMeta,
  type PluginSummary,
} from "@pi-desktop/shared";
import type { HostProcess } from "../host-process";
import type { LocalAppCatalog } from "../local-apps";
import type { PluginRuntime } from "../plugin-runtime";
import type { IpcRegistrar } from "./types";

/** A plugin may declare at most this many launcher triggers (mirrors Rust). */
const MAX_TRIGGERS_PER_PLUGIN = 8;
const MAX_PATTERN_LENGTH = 200;
const ALLOWED_TRIGGER_FLAGS = /^[imsu]{0,4}$/;

export type PluginLauncherIpcDependencies = {
  registrar: IpcRegistrar;
  getHost: () => HostProcess | null;
  getPluginLauncherWindow: () => BrowserWindow | null;
  plugins: PluginRuntime;
  localApps: LocalAppCatalog;
  /** Active app locale, used to resolve a localized trigger title. */
  getLocale: () => string;
};

/**
 * Accept or refuse the launcher payload attached to an open request.
 *
 * A payload is only forwarded when it names a trigger and carries text within
 * the documented budget; anything else opens the panel with no payload at all,
 * which is what tells the plugin "the user did not summon you with input".
 */
export function normalizeLauncherLaunch(request: {
  triggerId?: unknown;
  payload?: unknown;
}): { triggerId: string; payload: string } | undefined {
  const triggerId =
    typeof request.triggerId === "string" ? request.triggerId.trim() : "";
  const payload = typeof request.payload === "string" ? request.payload : "";
  if (!triggerId || !payload) return undefined;
  if (payload.length > LAUNCHER_PAYLOAD_MAX_LENGTH) return undefined;
  return { triggerId, payload };
}

function permissionDenied(): Error {
  return Object.assign(new Error("this surface cannot launch applications"), {
    errorCode: "PERMISSION_DENIED",
  });
}

/**
 * Only the persisted launcher may ask what exists and open an application.
 * The window is created lazily, so a missing window means "not the launcher".
 */
function assertLauncherSender(
  getPluginLauncherWindow: () => BrowserWindow | null,
  senderId: number | undefined,
): void {
  const launcher = getPluginLauncherWindow();
  if (!launcher || launcher.isDestroyed() || launcher.webContents.id !== senderId) {
    throw permissionDenied();
  }
}

function resolveTriggerTitle(
  title: unknown,
  locale: string,
): string | undefined {
  if (typeof title === "string") return title || undefined;
  if (title && typeof title === "object") {
    const localized = title as Record<string, unknown>;
    const preferred = locale.toLowerCase().startsWith("zh")
      ? localized["zh-CN"]
      : localized.en;
    if (typeof preferred === "string") return preferred || undefined;
  }
  return undefined;
}

/**
 * Re-shape what the plugin declared into what the renderer may match against.
 *
 * The Rust manifest validator has already rejected unusable declarations; this
 * second pass keeps one malformed plugin from breaking the whole catalog, and
 * drops anything the renderer could not compile.
 */
export function sanitizeLauncherTriggers(
  contributes: unknown,
  locale: string,
): LauncherTriggerMeta[] {
  if (!contributes || typeof contributes !== "object") return [];
  const declared = (contributes as Record<string, unknown>).launcherTriggers;
  if (!Array.isArray(declared)) return [];
  const triggers: LauncherTriggerMeta[] = [];
  const seen = new Set<string>();
  for (const entry of declared.slice(0, MAX_TRIGGERS_PER_PLUGIN)) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    const pattern = typeof record.pattern === "string" ? record.pattern.trim() : "";
    if (!id || seen.has(id)) continue;
    if (!pattern || pattern.length > MAX_PATTERN_LENGTH) continue;
    const flags = typeof record.flags === "string" ? record.flags : undefined;
    if (flags !== undefined && !ALLOWED_TRIGGER_FLAGS.test(flags)) continue;
    seen.add(id);
    triggers.push({
      id,
      pattern,
      ...(flags ? { flags } : {}),
      ...(resolveTriggerTitle(record.title, locale)
        ? { title: resolveTriggerTitle(record.title, locale) }
        : {}),
    });
  }
  return triggers;
}

/** `ui.panel` is what makes a plugin's Enter key able to open something. */
export function launcherPluginEntry(
  summary: PluginSummary,
  triggers: LauncherTriggerMeta[],
): LauncherPluginEntry | null {
  const launchable =
    summary.enabled &&
    summary.status === "ready" &&
    Boolean(summary.ui?.panel) &&
    summary.permissions.includes("ui.panel");
  if (!launchable) return null;
  return {
    kind: "plugin",
    id: `plugin:${summary.id}`,
    pluginId: summary.id,
    name: summary.name,
    ...(summary.description ? { description: summary.description } : {}),
    triggers,
  };
}

export function launcherAppEntry(
  app: { id: string; name: string; executableName?: string; source: string; iconDataUrl?: string },
): LauncherAppEntry {
  return {
    kind: "app",
    id: app.id,
    name: app.name,
    ...(app.executableName ? { executableName: app.executableName } : {}),
    source: app.source as LauncherAppEntry["source"],
    ...(app.iconDataUrl ? { iconDataUrl: app.iconDataUrl } : {}),
  };
}

export function registerPluginLauncherIpc({
  registrar,
  getHost,
  getPluginLauncherWindow,
  plugins,
  localApps,
  getLocale,
}: PluginLauncherIpcDependencies): void {
  const { handleWithEvent } = registrar;

  handleWithEvent(
    IPC.invoke.pluginLauncherCatalog,
    async (event): Promise<LauncherCatalog> => {
      assertLauncherSender(getPluginLauncherWindow, event.sender.id);
      const host = getHost();
      if (!host) throw new Error("host unavailable");
      const locale = getLocale();
      const listed = await host.call<{ plugins: PluginSummary[] }>("plugins.list");
      const pluginEntries: LauncherPluginEntry[] = [];
      for (const summary of listed.plugins ?? []) {
        const loaded = plugins.getLoaded(summary.id);
        const triggers = sanitizeLauncherTriggers(
          loaded?.manifest.contributes,
          locale,
        );
        const entry = launcherPluginEntry(summary, triggers);
        if (entry) pluginEntries.push(entry);
      }
      const apps = await localApps.list();
      return {
        plugins: pluginEntries,
        apps: apps.map((app) => launcherAppEntry(app)),
        appsScanning: localApps.isScanning(),
      };
    },
  );

  handleWithEvent(
    IPC.invoke.pluginLauncherOpenApp,
    async (event, request: LauncherOpenAppRequest): Promise<{ ok: true }> => {
      assertLauncherSender(getPluginLauncherWindow, event.sender.id);
      const appId = typeof request?.appId === "string" ? request.appId.trim() : "";
      if (!appId) throw new Error("application id is required");
      // `launch` resolves the id against the host's own scan result; a path is
      // never accepted from the renderer.
      await localApps.launch(appId);
      return { ok: true };
    },
  );
}
