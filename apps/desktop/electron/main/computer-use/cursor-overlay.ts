import { app, BrowserWindow, screen } from "electron";
import { join } from "node:path";
import { IPC, type ComputerCursorEvent, type ComputerRect } from "@pi-desktop/shared";
import { getModuleDirectory } from "../module-path";
import { suppressLinuxFramelessSystemMenu } from "../frameless-system-menu";

/**
 * The agent's own cursor, drawn over the granted window (ADR 0340 §10).
 *
 * This window is visualization and nothing else. It is click-through, so it
 * cannot take a press away from the user, and it owns no part of any action:
 * the loop tells it where it is about to act, and the host's re-measurement —
 * not this overlay — remains the authority on where an action landed. A
 * failure to create or draw it never blocks or replaces an action, which is
 * why every method here swallows its own errors.
 *
 * It exists because the actions themselves are invisible: an accessibility
 * press moves no pointer, so without a drawn cursor the user would watch an
 * application change by itself with nothing to point at or interrupt.
 */

export type ComputerCursorOverlay = {
  /** Apply one draw command. Never throws. */
  apply: (event: ComputerCursorEvent) => void;
  /** Tear the window down; called when a grant ends and at shutdown. */
  close: () => void;
};

/** Margin around the target so a cursor drawn at the edge is not clipped. */
const OVERLAY_MARGIN = 48;

export function createComputerCursorOverlay(input: {
  log?: (message: string, data?: Record<string, unknown>) => void;
}): ComputerCursorOverlay {
  let window: BrowserWindow | null = null;
  let creating: Promise<BrowserWindow | null> | null = null;
  let loaded = false;
  let pending: ComputerCursorEvent[] = [];
  let currentGrant: string | null = null;

  function destroy(): void {
    const current = window;
    window = null;
    loaded = false;
    pending = [];
    currentGrant = null;
    if (current && !current.isDestroyed()) current.destroy();
  }

  function overlayBounds(bounds: ComputerRect): Electron.Rectangle {
    const x = Math.round(bounds.x - OVERLAY_MARGIN);
    const y = Math.round(bounds.y - OVERLAY_MARGIN);
    const width = Math.round(bounds.width + OVERLAY_MARGIN * 2);
    const height = Math.round(bounds.height + OVERLAY_MARGIN * 2);
    // Keep the window inside the display that holds the target, so a target
    // near a screen edge does not produce an off-screen overlay.
    const area = screen.getDisplayMatching({ x, y, width: Math.max(1, width), height: Math.max(1, height) }).bounds;
    return {
      x: Math.max(area.x, x),
      y: Math.max(area.y, y),
      width: Math.min(width, area.width),
      height: Math.min(height, area.height),
    };
  }

  function send(event: ComputerCursorEvent): void {
    const current = window;
    if (!current || current.isDestroyed() || !loaded) {
      pending.push(event);
      // The overlay is decoration; a backlog is dropped rather than grown.
      if (pending.length > 32) pending.shift();
      return;
    }
    try {
      current.webContents.send(IPC.event.computerCursor, event);
    } catch (error) {
      input.log?.("computer cursor overlay send failed", { data: String(error) });
    }
  }

  async function ensureWindow(bounds: ComputerRect): Promise<BrowserWindow | null> {
    if (window && !window.isDestroyed()) {
      window.setBounds(overlayBounds(bounds));
      return window;
    }
    if (creating) return creating;
    const promise = (async () => {
      try {
        const created = new BrowserWindow({
          ...overlayBounds(bounds),
          title: "PI-Desktop Computer Use",
          show: false,
          frame: false,
          transparent: true,
          backgroundColor: "#00000000",
          hasShadow: false,
          resizable: false,
          movable: false,
          minimizable: false,
          maximizable: false,
          fullscreenable: false,
          skipTaskbar: true,
          focusable: false,
          alwaysOnTop: true,
          autoHideMenuBar: true,
          ...(process.platform === "darwin" ? { type: "panel" as const } : {}),
          webPreferences: {
            preload: join(getModuleDirectory(import.meta.url), "../preload/index.cjs"),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            additionalArguments: [`--pi-desktop-locale=${app.getLocale()}`],
          },
        });
        window = created;
        suppressLinuxFramelessSystemMenu(created);
        // The whole point: the overlay never takes a click from the user.
        created.setIgnoreMouseEvents(true, { forward: false });
        created.setAlwaysOnTop(true, "screen-saver");
        if (process.platform === "darwin") {
          created.setVisibleOnAllWorkspaces(true, {
            visibleOnFullScreen: true,
            skipTransformProcessType: true,
          });
        }
        created.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
        created.webContents.on("will-navigate", (event, url) => {
          const devOrigin = process.env.ELECTRON_RENDERER_URL;
          if (devOrigin && url.startsWith(devOrigin)) return;
          event.preventDefault();
        });
        created.webContents.on("did-finish-load", () => {
          loaded = true;
          const queued = pending;
          pending = [];
          for (const event of queued) send(event);
        });
        created.on("closed", () => {
          if (window === created) {
            window = null;
            loaded = false;
          }
        });
        if (process.env.ELECTRON_RENDERER_URL) {
          const url = new URL(process.env.ELECTRON_RENDERER_URL);
          url.searchParams.set("surface", "computer-cursor");
          await created.loadURL(url.toString());
        } else {
          await created.loadFile(
            join(getModuleDirectory(import.meta.url), "../renderer/index.html"),
            { query: { surface: "computer-cursor" } },
          );
        }
        created.showInactive();
        return created;
      } catch (error) {
        input.log?.("computer cursor overlay failed to open", { data: String(error) });
        destroy();
        return null;
      } finally {
        creating = null;
      }
    })();
    creating = promise;
    return promise;
  }

  return {
    apply(event) {
      try {
        if (event.kind === "hide") {
          if (currentGrant && event.grantId !== currentGrant) return;
          destroy();
          return;
        }
        if (event.kind === "show") {
          currentGrant = event.grantId;
          void ensureWindow(event.bounds).then((created) => {
            if (created) send(event);
          });
          return;
        }
        // A draw command for a grant that already ended is dropped: the
        // overlay must never outlive the authority it was drawn for.
        if (currentGrant && event.grantId !== currentGrant) return;
        send(event);
      } catch (error) {
        input.log?.("computer cursor overlay command failed", { data: String(error) });
      }
    },
    close() {
      destroy();
    },
  };
}
