import type { BrowserWindow } from "electron";
import type { AgentSidecar } from "../agent-sidecar";

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

  function publish(sessionId: string | null): void {
    void getSidecar()?.call("agent.setCacheWarmingSession", { sessionId }).catch(() => undefined);
  }

  function sync(): void {
    const window = getMainWindow();
    const visible = window && !window.isDestroyed() && window.isFocused() &&
      window.isVisible() && !window.isMinimized();
    publish(enabled && visible && !suspended && !screenLocked ? viewingSessionId : null);
  }

  function clearView(): void {
    viewingSessionId = null;
    publish(null);
  }

  return {
    sync,
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
      window.on("focus", sync);
      window.on("blur", () => publish(null));
      window.on("hide", () => publish(null));
      window.on("minimize", () => publish(null));
      window.once("closed", clearView);
      window.webContents.once("render-process-gone", clearView);
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
