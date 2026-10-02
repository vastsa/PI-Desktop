import { app, BrowserWindow, screen, type Rectangle } from "electron";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { IPC, type LiveCallView, type LiveVoiceWidgetAction } from "@pi-desktop/shared";
import { getModuleDirectory } from "../module-path";
import { suppressLinuxFramelessSystemMenu } from "../frameless-system-menu";

/**
 * The docked Live Voice widget: the call chrome as a desktop-level window.
 *
 * The call itself stays owned by the main window (media, microphone lease,
 * provider transport and the work scope all live there), so this window is
 * presentation plus a thin remote control: main pushes the authoritative call
 * state in, the widget sends actions back out, and every action is executed by
 * the main window's controller. Nothing here mutates the call.
 *
 * The window is frameless, transparent and always on top, and it is dragged
 * through the renderer's `app-region: drag` handle, so the only geometry this
 * module owns is the remembered position: the widget reports the size its own
 * content needs, and both the size and the position are clamped into the work
 * area so a saved placement can never strand the controls off-screen.
 */

export const LIVE_VOICE_WIDGET_STATE_FILE = "live-voice-widget.json";
import {
  LIVE_VOICE_WIDGET_MAX_HEIGHT,
  LIVE_VOICE_WIDGET_MAX_WIDTH,
  LIVE_VOICE_WIDGET_MIN_HEIGHT,
  LIVE_VOICE_WIDGET_MIN_WIDTH,
  LIVE_VOICE_WIDGET_SIZE,
  clampLiveVoiceWidgetPosition,
  clampLiveVoiceWidgetSize,
  parseLiveVoiceWidgetPosition,
  type LiveVoiceWidgetPosition,
  type LiveVoiceWidgetSize,
} from "./widget-geometry";

export type LiveVoiceWidget = {
  /** Push the authoritative call view; the window appears on the first call. */
  publish: (view: LiveCallView | null) => void;
  /**
   * What only the owner frame knows about this call: its own failure code (a
   * refused action) and whether the bound work session is waiting on a decision.
   * Neither is in the call view, so the widget can only show them because the
   * owner reports them, and both are dropped when the call they belong to changes.
   */
  setOwnerState: (state: { callId: string; errorCode: string | null; decisionWaiting: boolean }) => void;
  /** True when these contents are the widget window's own renderer. */
  owns: (webContentsId: number) => boolean;
  /** Follow the widget's own presentation decision and measured content box. */
  setPresentation: (visible: boolean, size: LiveVoiceWidgetSize) => void;
  /** Ask the owner frame (the main window) to run a call action. */
  requestAction: (action: LiveVoiceWidgetAction) => void;
  close: () => void;
};

export function createLiveVoiceWidget(input: {
  getMainWindow: () => BrowserWindow | null;
  dataDir: string;
  safeOpenExternal: (rawUrl: unknown) => Promise<void>;
  log?: (message: string, data?: Record<string, unknown>) => void;
}): LiveVoiceWidget {
  let window: BrowserWindow | null = null;
  let creation: Promise<BrowserWindow | null> | null = null;
  let loaded = false;
  let lastView: LiveCallView | null = null;
  let lastErrorCode: string | undefined;
  let lastDecisionWaiting = false;
  let visible = false;
  let size: LiveVoiceWidgetSize = { ...LIVE_VOICE_WIDGET_SIZE };
  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  const statePath = join(input.dataDir, LIVE_VOICE_WIDGET_STATE_FILE);

  function readPosition(): LiveVoiceWidgetPosition | null {
    try {
      return parseLiveVoiceWidgetPosition(readFileSync(statePath, "utf8"));
    } catch {
      return null;
    }
  }

  function writePosition(position: LiveVoiceWidgetPosition): void {
    try {
      writeFileSync(statePath, `${JSON.stringify(position)}\n`, "utf8");
    } catch (error) {
      // A position that cannot be written costs the remembered placement only.
      input.log?.("live voice widget position was not saved", { data: String(error) });
    }
  }

  function workAreaFor(position: LiveVoiceWidgetPosition | null): Rectangle {
    const fallback = screen.getPrimaryDisplay();
    if (!position) return fallback.workArea;
    return screen.getDisplayMatching({ x: position.x, y: position.y, width: 1, height: 1 }).workArea;
  }

  function initialBounds(): { x: number; y: number; width: number; height: number } {
    const stored = readPosition();
    const workArea = workAreaFor(stored);
    const preferred = stored ?? {
      x: workArea.x + workArea.width - size.width,
      y: workArea.y + workArea.height - size.height,
    };
    const position = clampLiveVoiceWidgetPosition(preferred, size, workArea);
    return { ...position, ...size };
  }

  function savePosition(): void {
    const current = window;
    if (!current || current.isDestroyed()) return;
    const bounds = current.getBounds();
    writePosition({ x: bounds.x, y: bounds.y });
  }

  function schedulePositionSave(): void {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      savePosition();
    }, 400);
  }

  function sendView(): void {
    const current = window;
    if (!current || current.isDestroyed() || !loaded || !lastView) return;
    current.webContents.send(IPC.event.liveVoiceWidgetState, {
      call: lastView,
      ...(lastErrorCode ? { errorCode: lastErrorCode } : {}),
      ...(lastDecisionWaiting ? { decisionWaiting: true } : {}),
    });
  }

  async function ensureWindow(): Promise<BrowserWindow | null> {
    if (window && !window.isDestroyed()) return window;
    if (creation) return creation;
    const promise = (async () => {
      const created = new BrowserWindow({
        ...initialBounds(),
        title: "PI-Desktop Live Voice",
        show: false,
        frame: false,
        transparent: true,
        backgroundColor: "#00000000",
        hasShadow: false,
        resizable: true,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        autoHideMenuBar: true,
        minWidth: LIVE_VOICE_WIDGET_MIN_WIDTH,
        maxWidth: LIVE_VOICE_WIDGET_MAX_WIDTH,
        minHeight: LIVE_VOICE_WIDGET_MIN_HEIGHT,
        maxHeight: LIVE_VOICE_WIDGET_MAX_HEIGHT,
        useContentSize: true,
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

      if (process.platform === "darwin") {
        // Follow the launcher (ADR 0086): join every Space and float above this
        // app's own fullscreen window without transforming the whole process
        // into a UI-element application.
        created.setVisibleOnAllWorkspaces(true, {
          visibleOnFullScreen: true,
          skipTransformProcessType: true,
        });
      }
      created.webContents.setWindowOpenHandler(({ url }) => {
        void input.safeOpenExternal(url).catch(() => undefined);
        return { action: "deny" };
      });
      created.webContents.on("will-navigate", (event, url) => {
        const devOrigin = process.env.ELECTRON_RENDERER_URL;
        if (devOrigin && url.startsWith(devOrigin)) return;
        event.preventDefault();
      });
      created.webContents.on("did-finish-load", () => {
        loaded = true;
        sendView();
      });
      created.on("moved", schedulePositionSave);
      created.on("closed", () => {
        if (window === created) window = null;
        loaded = false;
      });

      try {
        if (process.env.ELECTRON_RENDERER_URL) {
          const url = new URL(process.env.ELECTRON_RENDERER_URL);
          url.searchParams.set("surface", "live-voice-widget");
          await created.loadURL(url.toString());
        } else {
          await created.loadFile(
            join(getModuleDirectory(import.meta.url), "../renderer/index.html"),
            { query: { surface: "live-voice-widget" } },
          );
        }
        return created;
      } catch (error) {
        if (!created.isDestroyed()) created.destroy();
        if (window === created) window = null;
        input.log?.("live voice widget window failed to load", { data: String(error) });
        return null;
      }
    })();
    creation = promise;
    void promise.then(() => {
      if (creation === promise) creation = null;
    });
    return promise;
  }

  function applyBounds(next: { x: number; y: number; width: number; height: number }): void {
    const current = window;
    if (!current || current.isDestroyed()) return;
    const bounds = current.getBounds();
    if (bounds.x === next.x && bounds.y === next.y && bounds.width === next.width && bounds.height === next.height) return;
    current.setBounds(next, false);
  }

  return {
    publish(view) {
      // A new call starts blank: the previous call's failure and its pending
      // decision must not be reported over the next one.
      if (view?.callId !== lastView?.callId) {
        lastErrorCode = undefined;
        lastDecisionWaiting = false;
      }
      lastView = view;
      if (view || window) void ensureWindow().then(sendView);
    },
    setOwnerState(state) {
      if (lastView?.callId !== state.callId) return;
      lastErrorCode = state.errorCode ?? undefined;
      lastDecisionWaiting = state.decisionWaiting;
      sendView();
    },
    owns(webContentsId) {
      return Boolean(window && !window.isDestroyed() && window.webContents.id === webContentsId);
    },
    setPresentation(nextVisible, nextSize) {
      visible = nextVisible;
      size = clampLiveVoiceWidgetSize(nextSize);
      const current = window;
      if (!visible) {
        if (current && !current.isDestroyed() && current.isVisible()) {
          // Hiding keeps the renderer warm for the next call and saves the
          // placement the user dragged to.
          savePosition();
          current.hide();
        }
        // The renderer reports its presentation after installing its event
        // subscription. Replay here so a state sent during page load cannot be
        // lost before React is ready to receive it.
        sendView();
        return;
      }
      void ensureWindow().then((created) => {
        if (!created || created.isDestroyed() || !visible) return;
        const workArea = screen.getDisplayMatching({
          x: created.getBounds().x,
          y: created.getBounds().y,
          width: 1,
          height: 1,
        }).workArea;
        const position = clampLiveVoiceWidgetPosition(
          { x: created.getBounds().x, y: created.getBounds().y },
          size,
          workArea,
        );
        applyBounds({ ...position, ...size });
        if (!created.isVisible()) {
          // Appearing must not steal focus from whatever the user is doing.
          created.showInactive();
        }
        sendView();
      });
    },
    requestAction(action) {
      const main = input.getMainWindow();
      if (!main || main.isDestroyed()) return;
      if (action === "details" || action === "settings" || action === "resume") {
        // The details surface and the Settings route live in the main window,
        // so the action has to hand the user over to it.
        if (main.isMinimized()) main.restore();
        if (!main.isVisible()) main.show();
        main.focus();
      }
      main.webContents.send(IPC.event.liveVoiceWidgetAction, { action });
    },
    close() {
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      savePosition();
      const current = window;
      window = null;
      loaded = false;
      if (current && !current.isDestroyed()) current.destroy();
    },
  };
}
