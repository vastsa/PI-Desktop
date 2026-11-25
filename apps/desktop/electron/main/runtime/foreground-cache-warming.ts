import type { BrowserWindow } from "electron";
import type { AgentSidecar } from "../agent-sidecar";

const PLUGIN_CHANGES = new Set([
  "agentExtensions", "disable", "enable", "importExtension", "install",
  "market.applyUpdates", "market.install", "reload", "scope", "settings", "uninstall",
]);

export function createForegroundCacheWarming({
  getMainWindow,
  getSidecar,
}: {
  getMainWindow: () => BrowserWindow | null;
  getSidecar: () => AgentSidecar | null;
}) {
  let enabled = false;
  let viewingSessionId: string | null = null;
  let suspended = false;
  let screenLocked = false;
  let rendererGone = false;

  function publish(sessionId: string | null, waitAllowed = false): void {
    void getSidecar()?.call("agent.setCacheWarmingSession", { sessionId, waitAllowed }).catch(() => undefined);
  }

  function sync(): void {
    const window = getMainWindow();
    const visible = window && !window.isDestroyed() && window.isFocused() &&
      window.isVisible() && !window.isMinimized();
    const waitAllowed = enabled && Boolean(visible) && !suspended && !screenLocked && !rendererGone;
    publish(waitAllowed ? viewingSessionId : null, waitAllowed);
  }

  function clearView(): void {
    viewingSessionId = null;
    sync();
  }

  return {
    sync,
    notePluginChanged(change: unknown): void {
      const reason = (change as { reason?: unknown } | null)?.reason;
      if (typeof reason === "string" && PLUGIN_CHANGES.has(reason)) {
        void getSidecar()?.call("agent.invalidateCacheWarming", { all: true }).catch(() => undefined);
      }
    },
    applySettings(settings?: { foregroundCacheWarmingEnabled?: unknown } | null): void {
      enabled = settings?.foregroundCacheWarmingEnabled === true;
      sync();
    },
    setViewingSession(sessionId: string | null): void {
      viewingSessionId = sessionId;
      sync();
    },
    noteTurnStarted(sessionId: string): void {
      if (enabled && sessionId === viewingSessionId) {
        void getSidecar()?.call("agent.invalidateCacheWarming", { sessionId }).catch(() => undefined);
      }
    },
    observeWindow(window: BrowserWindow): void {
      rendererGone = false;
      window.on("focus", sync);
      window.on("blur", () => publish(null));
      window.on("hide", () => publish(null));
      window.on("minimize", () => publish(null));
      window.once("closed", () => {
        viewingSessionId = null;
        publish(null);
      });
      window.webContents.on("render-process-gone", () => {
        rendererGone = true;
        clearView();
      });
      window.webContents.on("did-finish-load", () => {
        rendererGone = false;
        sync();
      });
      window.webContents.on("did-start-navigation", (_event, _url, inPlace, isMainFrame) => {
        if (isMainFrame && !inPlace) clearView();
      });
    },
    observePowerMonitor(monitor: typeof import("electron").powerMonitor): void {
      monitor.on("suspend", () => {
        suspended = true;
        publish(null);
      });
      monitor.on("resume", () => {
        suspended = false;
        sync();
      });
      monitor.on("lock-screen", () => {
        screenLocked = true;
        publish(null);
      });
      monitor.on("unlock-screen", () => {
        screenLocked = false;
        sync();
      });
    },
  };
}
