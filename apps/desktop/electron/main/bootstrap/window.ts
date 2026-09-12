import { app, BrowserWindow, nativeTheme, screen, type Tray } from "electron";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { APP_NAME, IPC, type CloseBehavior } from "@pi-desktop/shared";
import type { BrowserPane } from "../browser-view";
import type { HostProcess } from "../host-process";
import type { Logger } from "../logger";
import type { PluginRuntime } from "../plugin-runtime";
import type { PluginViewHost } from "../plugin-view-host";
import {
  baseWindowBounds,
  clampBoundsOriginToWorkArea,
  displayWorkAreaKey,
  emptyWorkPanelReservationState,
  isWorkPanelOuterResizeEdge,
  parseWorkPanelChatWidth,
  parseWorkPanelReservationWidth,
  planWorkPanelChatResize,
  planWorkPanelReservation,
  reconcileBaseWindowBounds,
  WORK_PANEL_MAX_WIDTH,
  WORK_PANEL_MIN_WIDTH,
  windowBoundsEqual,
  type DisplayTransition,
  type WindowBounds,
  type WorkPanelReservationState,
} from "../work-panel-window";
import { readWindowState, writeWindowState } from "../window-preferences";

export type WindowLifecycleState = {
  mainWindow: BrowserWindow | null;
  notificationViewingSessionId: string | null;
  requestedWorkPanelReservation: number;
  workPanelReservation: WorkPanelReservationState;
  workPanelDisplayKey: string | null;
  workPanelBaseBounds: WindowBounds | null;
  workPanelLastAppliedBounds: WindowBounds | null;
  expectedWorkPanelBounds: WindowBounds | null;
  workPanelUserMovePending: boolean;
  workPanelNativeResizeActive: boolean;
  workPanelChatResizeTimer: NodeJS.Timeout | null;
  workPanelChatResizeActive: boolean;
  setWorkPanelChatWidthForWindow: ((width: number) => number) | null;
  pluginLauncherBinding: string | null;
  closePromptOpen: boolean;
  quitConfirmed: boolean;
  menuRendererReadyGate: WindowMenuRendererReadyGate | null;
  quitting: boolean;
  tray: Tray | null;
  closeBehavior: CloseBehavior;
  developerMode: boolean;
  pluginLauncherWindow: BrowserWindow | null;
  host: HostProcess | null;
};

export type WindowMenuRendererReadyGate = {
  window: BrowserWindow;
  ready: boolean;
  promise: Promise<void>;
  resolve: () => void;
};

export type WindowLifecycleDependencies = {
  state: WindowLifecycleState;
  dataDir: string;
  windowMinWidth: number;
  windowMinHeight: number;
  windowBoundsSettleMs: number;
  workPanelNativeResizeSettleMs: number;
  windowsAllowedToClose: WeakSet<BrowserWindow>;
  applyWorkPanelReservation: () => WorkPanelReservationState;
  markWorkPanelChatResizeActive: () => void;
  workPanelMinimumWindowWidth: () => number;
  observedWorkPanelBaseBounds: (windowBounds: WindowBounds, transition: DisplayTransition) => WindowBounds;
  classifyDisplayTransition: (displayKey: string) => DisplayTransition;
  resetMenuRendererReady: (window: BrowserWindow) => void;
  markMenuRendererReady: (window: BrowserWindow) => boolean;
  sendToRenderer: (channel: string, payload: unknown) => void;
  safeOpenExternal: (rawUrl: unknown) => Promise<void>;
  showPluginLauncher: () => Promise<void>;
  askCloseBehavior: (window: BrowserWindow) => Promise<CloseBehavior | null>;
  applyCloseBehavior: (behavior: CloseBehavior) => void;
  createTray: () => void;
  browserPane: BrowserPane;
  pluginViews: PluginViewHost;
  plugins: PluginRuntime;
  logger: Pick<Logger, "app">;
};

export async function createWindow({
  state: windowState,
  dataDir,
  windowMinWidth,
  windowMinHeight,
  windowBoundsSettleMs,
  workPanelNativeResizeSettleMs,
  windowsAllowedToClose,
  applyWorkPanelReservation,
  markWorkPanelChatResizeActive,
  workPanelMinimumWindowWidth,
  observedWorkPanelBaseBounds,
  classifyDisplayTransition,
  resetMenuRendererReady,
  markMenuRendererReady,
  sendToRenderer,
  safeOpenExternal,
  showPluginLauncher,
  askCloseBehavior,
  applyCloseBehavior,
  createTray,
  browserPane,
  pluginViews,
  plugins,
  logger,
}: WindowLifecycleDependencies): Promise<void> {

  windowState.notificationViewingSessionId = null;
  windowState.requestedWorkPanelReservation = 0;
  windowState.workPanelReservation = emptyWorkPanelReservationState();
  windowState.workPanelDisplayKey = null;
  windowState.workPanelBaseBounds = null;
  windowState.workPanelLastAppliedBounds = null;
  windowState.expectedWorkPanelBounds = null;
  windowState.workPanelUserMovePending = false;
  windowState.workPanelNativeResizeActive = false;
  if (windowState.workPanelChatResizeTimer) clearTimeout(windowState.workPanelChatResizeTimer);
  windowState.workPanelChatResizeTimer = null;
  windowState.workPanelChatResizeActive = false;
  windowState.setWorkPanelChatWidthForWindow = null;
  const savedState = await readWindowState(
    dataDir,
    windowMinWidth,
    windowMinHeight,
  );
  windowState.mainWindow = new BrowserWindow({
    ...(savedState ?? { width: 1200, height: 800 }),
    minWidth: windowMinWidth,
    minHeight: windowMinHeight,
    title: APP_NAME,
    show: false,
    // Keep native edge/corner resizing explicit. Frameless chrome owns the
    // titlebar only; the OS remains responsible for the resize hit regions.
    resizable: true,
    // One frameless look everywhere: macOS keeps inset traffic lights;
    // Windows/Linux hide native chrome entirely — the renderer draws its
    // own Codex-style window controls (see WindowControls.tsx).
    ...(process.platform === "darwin"
      ? {
          titleBarStyle: "hiddenInset" as const,
          trafficLightPosition: { x: 16, y: 16 },
          vibrancy: "sidebar" as const,
          visualEffectState: "followWindow" as const,
          transparent: true,
          backgroundColor: "#00000000",
        }
      : {
          frame: false,
          backgroundColor: nativeTheme.shouldUseDarkColors ? "#181818" : "#ffffff",
        }),
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Preload runs in a sandbox and cannot import Electron's main-only `app`
      // module. Pass the display locale at process creation so it remains
      // available synchronously before the renderer's first paint.
      additionalArguments: [`--pi-desktop-locale=${app.getLocale()}`],
    },
  });
  const window = windowState.mainWindow;
  const initialBounds = window.getBounds();
  windowState.workPanelBaseBounds = savedState ? { ...savedState } : { ...initialBounds };
  windowState.workPanelLastAppliedBounds = { ...initialBounds };
  resetMenuRendererReady(window);
  const isLiveWindow = () =>
    windowState.mainWindow === window &&
    !window.isDestroyed() &&
    !window.webContents.isDestroyed();

  // Keep the macOS traffic-light minimize tray-resident. Windows/Linux
  // minimize actions use Electron's native transition so the OS keeps the
  // ordinary taskbar entry available for restore. Close-to-tray remains an
  // explicit close behavior handled below.
  window.on("minimize", () => {
    if (windowState.quitting || !windowState.tray || process.platform !== "darwin") return;
    window.hide();
  });
  let workPanelReconcileTimer: NodeJS.Timeout | null = null;
  const scheduleWorkPanelReservation = () => {
    if (workPanelReconcileTimer) clearTimeout(workPanelReconcileTimer);
    workPanelReconcileTimer = setTimeout(() => {
      workPanelReconcileTimer = null;
      if (isLiveWindow()) applyWorkPanelReservation();
    }, 0);
  };

  type NativeWorkPanelResize = {
    baseBounds: WindowBounds;
    initialBounds: WindowBounds;
    settleTimer: NodeJS.Timeout | null;
  };
  let nativeWorkPanelResize: NativeWorkPanelResize | null = null;

  const sendWorkPanelResize = (
    phase: "preview" | "commit",
    panelWidth: number,
  ) => {
    if (!isLiveWindow()) return;
    window.webContents.send(IPC.event.windowWorkPanelResize, {
      phase,
      panelWidth,
    });
  };

  const nativePanelWidth = (bounds: WindowBounds, baseBounds: WindowBounds) =>
    Math.max(
      WORK_PANEL_MIN_WIDTH,
      Math.min(WORK_PANEL_MAX_WIDTH, bounds.width - baseBounds.width),
    );

  const syncNativeWorkPanelResize = (phase: "preview" | "commit") => {
    const state = nativeWorkPanelResize;
    if (!state || !isLiveWindow()) return;
    const currentBounds = window.getBounds();
    const panelWidth = nativePanelWidth(currentBounds, state.baseBounds);
    windowState.requestedWorkPanelReservation = panelWidth;
    windowState.workPanelReservation = {
      width: Math.max(0, currentBounds.width - state.baseBounds.width),
      xOffset: currentBounds.x - state.baseBounds.x,
    };
    windowState.workPanelLastAppliedBounds = { ...currentBounds };
    sendWorkPanelResize(phase, panelWidth);
    return panelWidth;
  };

  const finishNativeWorkPanelResize = () => {
    const state = nativeWorkPanelResize;
    if (!state || !isLiveWindow()) return;
    nativeWorkPanelResize = null;
    windowState.workPanelNativeResizeActive = false;
    if (state.settleTimer) clearTimeout(state.settleTimer);

    const currentBounds = window.getBounds();
    const panelWidth = nativePanelWidth(currentBounds, state.baseBounds);
    const nextBaseBounds: WindowBounds = {
      x: state.baseBounds.x + currentBounds.x - state.initialBounds.x,
      y: state.baseBounds.y + currentBounds.y - state.initialBounds.y,
      width: state.baseBounds.width,
      height: Math.max(
        0,
        state.baseBounds.height + currentBounds.height - state.initialBounds.height,
      ),
    };
    windowState.workPanelBaseBounds = nextBaseBounds;
    windowState.workPanelLastAppliedBounds = { ...currentBounds };
    const display = screen.getDisplayMatching(currentBounds);
    windowState.workPanelDisplayKey = displayWorkAreaKey(display.id, display.workArea);
    windowState.requestedWorkPanelReservation = panelWidth;
    windowState.workPanelReservation = {
      width: Math.max(0, currentBounds.width - nextBaseBounds.width),
      xOffset: currentBounds.x - nextBaseBounds.x,
    };
    const minimumWidth = Math.max(
      windowMinWidth,
      Math.min(display.workArea.width, windowMinWidth + panelWidth),
    );
    window.setMinimumSize(minimumWidth, windowMinHeight);
    sendWorkPanelResize("commit", panelWidth);
  };

  const armNativeWorkPanelResizeFinish = () => {
    if (!nativeWorkPanelResize) return;
    if (nativeWorkPanelResize.settleTimer) {
      clearTimeout(nativeWorkPanelResize.settleTimer);
    }
    nativeWorkPanelResize.settleTimer = setTimeout(() => {
      nativeWorkPanelResize = nativeWorkPanelResize
        ? { ...nativeWorkPanelResize, settleTimer: null }
        : null;
      finishNativeWorkPanelResize();
    }, workPanelNativeResizeSettleMs);
  };

  const beginNativeWorkPanelResize = (baseBoundsOverride?: WindowBounds) => {
    if (
      nativeWorkPanelResize ||
      windowState.requestedWorkPanelReservation <= 0 ||
      window.isFullScreen() ||
      window.isMaximized()
    ) {
      return nativeWorkPanelResize;
    }
    const currentBounds = window.getBounds();
    const baseBounds = baseBoundsOverride
      ? { ...baseBoundsOverride }
      : windowState.workPanelBaseBounds
        ? { ...windowState.workPanelBaseBounds }
        : baseWindowBounds(currentBounds, windowState.workPanelReservation);
    nativeWorkPanelResize = {
      baseBounds,
      initialBounds: { ...currentBounds },
      settleTimer: null,
    };
    windowState.workPanelNativeResizeActive = true;
    // Let the right edge reach the panel minimum while the base chat width
    // remains fixed. The normal minimum is restored after the gesture settles.
    window.setMinimumSize(baseBounds.width + WORK_PANEL_MIN_WIDTH, windowMinHeight);
    return nativeWorkPanelResize;
  };

  const setWorkPanelChatWidth = (requestedWidth: number) => {
    if (
      !isLiveWindow() ||
      windowState.requestedWorkPanelReservation <= 0 ||
      window.isFullScreen() ||
      window.isMaximized()
    ) {
      return windowState.workPanelBaseBounds?.width ?? windowMinWidth;
    }
    markWorkPanelChatResizeActive();
    const currentBounds = window.getBounds();
    const display = screen.getDisplayMatching(currentBounds);
    const transition = classifyDisplayTransition(
      displayWorkAreaKey(display.id, display.workArea),
    );
    const observedBase = observedWorkPanelBaseBounds(currentBounds, transition);
    const baseBounds =
      transition === "user-moved"
        ? clampBoundsOriginToWorkArea(observedBase, display.workArea)
        : observedBase;
    windowState.workPanelBaseBounds = baseBounds;
    windowState.workPanelDisplayKey = displayWorkAreaKey(display.id, display.workArea);
    if (transition === "user-moved") windowState.workPanelUserMovePending = false;
    const next = planWorkPanelChatResize({
      baseBounds,
      workArea: display.workArea,
      reservationWidth: windowState.workPanelReservation.width,
      requestedWidth,
    });
    const minimumWidth = Math.max(
      windowMinWidth,
      Math.min(display.workArea.width, windowMinWidth + next.reservation.width),
    );
    if (next.bounds.width < currentBounds.width) {
      window.setMinimumSize(minimumWidth, windowMinHeight);
    }
    windowState.expectedWorkPanelBounds = next.bounds;
    window.setBounds(next.bounds, false);
    if (next.bounds.width >= currentBounds.width) {
      window.setMinimumSize(minimumWidth, windowMinHeight);
    }
    const appliedBounds = window.getBounds();
    windowState.expectedWorkPanelBounds = appliedBounds;
    windowState.workPanelLastAppliedBounds = { ...appliedBounds };
    windowState.workPanelBaseBounds = baseWindowBounds(appliedBounds, next.reservation);
    windowState.workPanelReservation = {
      width: Math.max(0, appliedBounds.width - windowState.workPanelBaseBounds.width),
      xOffset: appliedBounds.x - windowState.workPanelBaseBounds.x,
    };
    return windowState.workPanelBaseBounds.width;
  };
  windowState.setWorkPanelChatWidthForWindow = setWorkPanelChatWidth;

  window.on("will-resize", (event, newBounds, details) => {
    if (windowState.workPanelChatResizeActive) return;
    if (!isWorkPanelOuterResizeEdge(details?.edge)) return;
    const currentBounds = window.getBounds();
    const state = beginNativeWorkPanelResize(
      observedWorkPanelBaseBounds(currentBounds, "none"),
    );
    if (!state) return;
    const rawPanelWidth = newBounds.width - state.baseBounds.width;
    const panelWidth = nativePanelWidth(newBounds, state.baseBounds);
    if (rawPanelWidth !== panelWidth) {
      event.preventDefault();
      const display = screen.getDisplayMatching(newBounds);
      const next = planWorkPanelReservation({
        baseBounds: state.baseBounds,
        workArea: display.workArea,
        requestedWidth: panelWidth,
      });
      windowState.expectedWorkPanelBounds = next.bounds;
      window.setBounds(next.bounds, false);
    }
    windowState.requestedWorkPanelReservation = panelWidth;
    sendWorkPanelResize("preview", panelWidth);
    armNativeWorkPanelResizeFinish();
  });

  const observeNativeWorkPanelResize = () => {
    if (windowState.workPanelChatResizeActive) return;
    if (nativeWorkPanelResize) {
      syncNativeWorkPanelResize("preview");
      armNativeWorkPanelResizeFinish();
      return;
    }
    // Electron exposes `will-resize` on macOS and Windows. On Linux, retain
    // the same ownership using the pointer's right-edge position as the
    // narrow fallback available to the main process.
    if (windowState.requestedWorkPanelReservation > 0) {
      const bounds = window.getBounds();
      const cursor = screen.getCursorScreenPoint();
      if (Math.abs(cursor.x - (bounds.x + bounds.width)) <= 12) {
        beginNativeWorkPanelResize();
        syncNativeWorkPanelResize("preview");
        armNativeWorkPanelResizeFinish();
        return;
      }
    }
    scheduleBoundsCheck();
  };
  window.on("resized", armNativeWorkPanelResizeFinish);

  window.webContents.setWindowOpenHandler(({ url }) => {
    void safeOpenExternal(url).catch(() => undefined);
    return { action: "deny" };
  });
  window.webContents.on("did-start-loading", () => {
    windowState.notificationViewingSessionId = null;
    if (windowState.mainWindow === window) resetMenuRendererReady(window);
  });
  window.webContents.on("render-process-gone", () => {
    windowState.notificationViewingSessionId = null;
  });

  // Devtools shortcut, gated on developer mode. Frameless windows get no
  // default binding, and Windows/Linux run with the application menu set to
  // null, so F12 is wired here; macOS additionally inherits Cmd+Alt+I from
  // the View menu role (see application-menu.ts).
  window.webContents.on("before-input-event", (event, input) => {
    const isPluginLauncherChord =
      process.platform === "win32" &&
      windowState.pluginLauncherBinding === "Alt+Space" &&
      input.type === "keyDown" &&
      input.code === "Space" &&
      input.alt &&
      !input.control &&
      !input.meta &&
      !input.shift;
    if (isPluginLauncherChord) {
      // Keep a focused-window fallback if the host's Windows hook could not
      // be installed. The frameless shell has no system menu of its own.
      event.preventDefault();
      void showPluginLauncher();
      return;
    }
    if (input.type !== "keyDown" || !windowState.developerMode) return;
    // `code` rather than `key`: Option+I on macOS produces a dead key.
    const isDevToolsChord =
      input.code === "F12" ||
      (process.platform !== "darwin" &&
        input.code === "KeyI" &&
        input.control &&
        input.shift);
    if (!isDevToolsChord) return;
    event.preventDefault();
    if (window.webContents.isDevToolsOpened()) window.webContents.closeDevTools();
    else window.webContents.openDevTools({ mode: "detach" });
  });

  // Fullscreen hides the macOS traffic lights; the renderer shifts its
  // titlebar controls left to reclaim the space.
  const sendFullScreen = () => {
    if (window.isDestroyed() || window.webContents.isDestroyed()) return;
    window.webContents.send(IPC.event.windowFullScreen, {
      fullScreen: window.isFullScreen(),
    });
  };
  window.on("enter-full-screen", sendFullScreen);
  window.on("leave-full-screen", () => {
    sendFullScreen();
    scheduleWorkPanelReservation();
  });
  window.webContents.on("did-finish-load", sendFullScreen);

  const sendMaximized = () => {
    if (window.isDestroyed() || window.webContents.isDestroyed()) return;
    window.webContents.send(IPC.event.windowMaximized, {
      maximized: window.isMaximized(),
    });
  };
  // Custom window controls (Windows/Linux) need maximize state to swap the
  // maximize/restore glyph.
  if (process.platform !== "darwin") {
    window.on("maximize", sendMaximized);
    // Native-runner E2E fixture: establish the initial native state before
    // the renderer mounts, then let WindowControls query it through IPC.
    if (process.env.PI_DESKTOP_START_MAXIMIZED === "1") window.maximize();
  }
  window.on("unmaximize", () => {
    if (process.platform !== "darwin") sendMaximized();
    scheduleWorkPanelReservation();
  });

  const reconcileWorkPanelDisplay = () => {
    if (!isLiveWindow()) return;
    const display = screen.getDisplayMatching(window.getBounds());
    const nextDisplayKey = displayWorkAreaKey(display.id, display.workArea);
    if (nextDisplayKey === windowState.workPanelDisplayKey) return;
    scheduleWorkPanelReservation();
  };

  // A native `move` stream is a drag in progress. Re-planning bounds mid-drag
  // fights the window server and lands as a jump on pointer release, so the
  // move path only marks the user-move window and defers reconciliation until
  // the stream goes quiet (D263, issue #18).
  //
  // The retire deadline only bounds how long an unconsumed marker can linger;
  // it never decides attribution, which the flag itself owns.
  const WORK_PANEL_USER_MOVE_RETIRE_MS = 2000;
  let workPanelSettleExpiryTimer: NodeJS.Timeout | null = null;
  const WORK_PANEL_MOVE_SETTLE_MS = 220;
  let workPanelMoveSettleTimer: NodeJS.Timeout | null = null;
  const noteUserWindowMove = () => {
    if (!isLiveWindow()) return;
    const currentBounds = window.getBounds();
    if (
      windowState.expectedWorkPanelBounds &&
      windowBoundsEqual(currentBounds, windowState.expectedWorkPanelBounds)
    ) {
      windowState.expectedWorkPanelBounds = null;
      return;
    }
    windowState.expectedWorkPanelBounds = null;
    windowState.workPanelUserMovePending = true;
    if (workPanelMoveSettleTimer) clearTimeout(workPanelMoveSettleTimer);
    workPanelMoveSettleTimer = setTimeout(() => {
      workPanelMoveSettleTimer = null;
      reconcileWorkPanelDisplay();
      // The flag must outlive reconciliation far enough for the debounced state
      // save to still see the drag, but it must not survive into a later,
      // unrelated OS display change. `applyWorkPanelReservation` defers geometry
      // for a maximized or fullscreen window and never consumes the flag, so the
      // save deadline is the backstop that always retires it.
      if (workPanelSettleExpiryTimer) clearTimeout(workPanelSettleExpiryTimer);
      workPanelSettleExpiryTimer = setTimeout(() => {
        workPanelSettleExpiryTimer = null;
        windowState.workPanelUserMovePending = false;
      }, WORK_PANEL_USER_MOVE_RETIRE_MS);
    }, WORK_PANEL_MOVE_SETTLE_MS);
  };
  const initialDisplay = screen.getDisplayMatching(window.getBounds());
  windowState.workPanelDisplayKey = displayWorkAreaKey(
    initialDisplay.id,
    initialDisplay.workArea,
  );
  // A topology change is the OS acting, not the user dragging. Drop any pending
  // drag attribution first so a display removed right after a move is not
  // mistaken for one (D263).
  const reconcileDisplayTopology = () => {
    windowState.workPanelUserMovePending = false;
    reconcileWorkPanelDisplay();
  };
  screen.on("display-metrics-changed", reconcileDisplayTopology);
  screen.on("display-added", reconcileDisplayTopology);
  screen.on("display-removed", reconcileDisplayTopology);

  browserPane.setWindow(window);
  pluginViews.setWindow(window);
  window.on("closed", () => {
    screen.removeListener("display-metrics-changed", reconcileDisplayTopology);
    screen.removeListener("display-added", reconcileDisplayTopology);
    screen.removeListener("display-removed", reconcileDisplayTopology);
    if (nativeWorkPanelResize?.settleTimer) {
      clearTimeout(nativeWorkPanelResize.settleTimer);
    }
    nativeWorkPanelResize = null;
    windowState.workPanelNativeResizeActive = false;
    if (windowState.workPanelChatResizeTimer) clearTimeout(windowState.workPanelChatResizeTimer);
    windowState.workPanelChatResizeTimer = null;
    windowState.workPanelChatResizeActive = false;
    if (windowState.setWorkPanelChatWidthForWindow) windowState.setWorkPanelChatWidthForWindow = null;
    if (workPanelReconcileTimer) {
      clearTimeout(workPanelReconcileTimer);
      workPanelReconcileTimer = null;
    }
    if (windowState.menuRendererReadyGate?.window === window) {
      windowState.menuRendererReadyGate.resolve();
      windowState.menuRendererReadyGate = null;
    }
    if (windowState.mainWindow !== window) return;
    windowState.mainWindow = null;
    browserPane.setWindow(null);
    pluginViews.setWindow(null);
    if (
      process.platform !== "darwin" &&
      windowState.pluginLauncherWindow &&
      !windowState.pluginLauncherWindow.isDestroyed()
    ) {
      windowState.pluginLauncherWindow.close();
    }
  });

  // Block navigation away from the app shell (dev server origin or local file).
  window.webContents.on("will-navigate", (event, url) => {
    const devOrigin = process.env.ELECTRON_RENDERER_URL;
    if (devOrigin && url.startsWith(devOrigin)) return;
    event.preventDefault();
    logger.app("diagnostics", "warn", "blocked navigation attempt", { data: { url } });
  });

  // Codex-like default footprint. CG bounds are truth under Stage Manager.
  const CODEX_BOUNDS = { x: 40, y: 30, width: 1200, height: 800 } as const;
  let boundsGuard = false;
  let boundsTimer: NodeJS.Timeout | null = null;
  let pinUntil = 0;
  let captureViewportOverride = false;
  let lastCgAt = 0;
  let lastCg: { x: number; y: number; width: number; height: number } | null = null;
  let missingCgStreak = 0;
  // The CG helper is dev tooling; without it, CG-based shelf detection must
  // stay inert or every machine would look permanently "shelved".
  const cgHelperPath = "/tmp/pi-window-bounds";
  const cgHelperAvailable = existsSync(cgHelperPath);

  const readCgBounds = (): { x: number; y: number; width: number; height: number } | null => {
    if (!cgHelperAvailable) return null;
    // Cache briefly — Stage Manager checks should not spawn tools every frame.
    if (Date.now() - lastCgAt < 700) return lastCg;
    try {
      const out = execFileSync(cgHelperPath, [String(process.pid)], {
        encoding: "utf8",
        timeout: 800,
      }).trim();
      lastCgAt = Date.now();
      if (!out) {
        lastCg = null;
        return null;
      }
      const [x, y, w, h] = out.split(",").map((n: string) => Number(n));
      if (![x, y, w, h].every((n: number) => Number.isFinite(n))) {
        lastCg = null;
        return null;
      }
      lastCg = { x, y, width: w, height: h };
      return lastCg;
    } catch {
      lastCgAt = Date.now();
      lastCg = null;
      return null;
    }
  };

  const ensureStableBounds = (force = false) => {
    if (
      !isLiveWindow() ||
      boundsGuard ||
      windowState.workPanelChatResizeActive ||
      captureViewportOverride ||
      // Never fight the user's own state: a minimized window stays
      // minimized and a tray-hidden window stays hidden.
      window.isMinimized() ||
      !window.isVisible()
    ) {
      return;
    }
    const electronBounds = window.getBounds();
    const cg = readCgBounds();
    if (!cg && cgHelperAvailable) missingCgStreak += 1;
    else missingCgStreak = 0;
    // Tiny/offscreen CG footprint is Stage Manager shelf. Missing CG alone is not
    // conclusive (alwaysOnTop can change window layer); require a short streak.
    const shelved =
      (!!cg && (cg.width < 500 || cg.height < 400 || cg.x < -40)) ||
      (!cg && cgHelperAvailable && missingCgStreak >= 3);
    const electronTiny =
      electronBounds.width < 500 || electronBounds.height < 400;
    if (!force && !shelved && !electronTiny) return;

    boundsGuard = true;
    try {
      if (window.isMinimized()) window.restore();
      window.setMinimumSize(windowMinWidth, windowMinHeight);
      // Prefer normal layer so CG helpers and Stage Manager stay stable.
      window.setAlwaysOnTop(false);
      window.show();
      window.focus();
      window.moveTop();
      if (shelved) {
        window.hide();
        window.setBounds({ ...CODEX_BOUNDS }, false);
        window.show();
      } else {
        window.setBounds({ ...CODEX_BOUNDS }, false);
      }
      window.setSize(CODEX_BOUNDS.width, CODEX_BOUNDS.height, false);
      window.setPosition(CODEX_BOUNDS.x, CODEX_BOUNDS.y, false);
      const restoredBounds = window.getBounds();
      windowState.workPanelBaseBounds = { ...restoredBounds };
      windowState.workPanelLastAppliedBounds = { ...restoredBounds };
      windowState.workPanelReservation = emptyWorkPanelReservationState();
      // A forced recovery is not user intent; drop any pending drag attribution
      // so the reservation replan below is treated as an OS-owned adjustment.
      windowState.workPanelUserMovePending = false;
      applyWorkPanelReservation();
      // Brief pin only when actively recovering from a shelf.
      if (shelved || electronTiny) {
        window.setAlwaysOnTop(true, "floating");
        pinUntil = Date.now() + 4000;
      } else {
        pinUntil = 0;
      }
      // bust CG cache after mutation
      lastCgAt = 0;
      console.log("BOUNDS_RESTORE", {
        electron: electronBounds,
        cg,
        shelved,
        afterElectron: window.getBounds(),
        afterCg: readCgBounds(),
      });
    } finally {
      setTimeout(() => {
        boundsGuard = false;
      }, 350);
    }
  };

  const scheduleBoundsCheck = () => {
    if (boundsTimer) clearTimeout(boundsTimer);
    if (!isLiveWindow() || windowState.workPanelChatResizeActive) return;
    const scheduledBounds = window.getBounds();
    boundsTimer = setTimeout(() => {
      boundsTimer = null;
      if (!isLiveWindow()) return;
      // A slow native gesture may emit another resize/move just after the
      // timer was armed. Never restore from a stale snapshot while that is
      // happening; the latest event will arm a fresh settle window.
      if (!windowBoundsEqual(window.getBounds(), scheduledBounds)) {
        scheduleBoundsCheck();
        return;
      }
      ensureStableBounds(false);
    }, windowBoundsSettleMs);
  };

  window.on("show", () => ensureStableBounds(false));
  window.on("focus", () => ensureStableBounds(false));
  window.on("restore", () => ensureStableBounds(false));
  window.on("resize", observeNativeWorkPanelResize);
  window.on("move", scheduleBoundsCheck);
  window.on("move", noteUserWindowMove);

  // Persist last good user bounds so relaunch restores them.
  let saveTimer: NodeJS.Timeout | null = null;
  const persistNormalWindowState = () => {
    if (
      !isLiveWindow() ||
      boundsGuard ||
      windowState.workPanelNativeResizeActive ||
      windowState.workPanelChatResizeActive
    ) {
      return;
    }
    const normalBounds = window.getNormalBounds();
    const display = screen.getDisplayMatching(normalBounds);
    const nextDisplayKey = displayWorkAreaKey(display.id, display.workArea);
    const displayTransition = classifyDisplayTransition(nextDisplayKey);
    const observedBase =
      windowState.workPanelBaseBounds && windowState.workPanelLastAppliedBounds
        ? observedWorkPanelBaseBounds(normalBounds, displayTransition)
        : baseWindowBounds(window.getNormalBounds(), windowState.workPanelReservation);
    // Normalize the same way the reservation path does. A maximized or
    // fullscreen window makes `applyWorkPanelReservation` defer geometry, so
    // this can be the first and only consumer of a cross-display drag; without
    // it, a rect straddling the boundary would be what relaunch restores.
    const bounds =
      displayTransition === "user-moved"
        ? clampBoundsOriginToWorkArea(observedBase, display.workArea)
        : observedBase;
    // An OS re-fit keeps the remembered base so a later return to a roomy
    // display restores it. Same-display moves and user cross-display drags are
    // both real intent, so they advance the base and get persisted; otherwise
    // relaunch would reopen the window on the display the user left (D263).
    if (displayTransition !== "os-adjusted") {
      windowState.workPanelBaseBounds = bounds;
      windowState.workPanelLastAppliedBounds = { ...normalBounds };
      if (displayTransition === "user-moved") {
        windowState.workPanelDisplayKey = nextDisplayKey;
        windowState.workPanelUserMovePending = false;
      }
    }
    if (bounds.width >= windowMinWidth && bounds.height >= windowMinHeight) {
      writeWindowState(dataDir, bounds);
    }
  };
  const scheduleStateSave = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      persistNormalWindowState();
    }, 600);
  };
  window.on("resize", scheduleStateSave);
  window.on("move", scheduleStateSave);
  window.on("close", (event) => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    persistNormalWindowState();
    // Windows/Linux close-behavior: "tray" hides the window and keeps the
    // app running under the tray icon, "ask" prompts on the first close,
    // and "quit" (plus macOS and explicit-quit closes) falls through to the
    // default close.
    if (
      process.platform === "darwin" ||
      windowState.quitting ||
      windowsAllowedToClose.has(window)
    ) {
      return;
    }
    event.preventDefault();
    void (async () => {
      if (windowState.closeBehavior === "ask") {
        if (windowState.closePromptOpen) return;
        windowState.closePromptOpen = true;
        try {
          const choice = await askCloseBehavior(window);
          if (!choice) return; // canceled: keep the window open
          applyCloseBehavior(choice);
        } finally {
          windowState.closePromptOpen = false;
        }
      }
      if (windowState.closeBehavior === "tray") {
        createTray();
        // The tray is the only way back to a hidden window; if the icon
        // could not be created, fall back to a real quit instead of
        // leaving the app invisible.
        if (windowState.tray) {
          window.hide();
          return;
        }
      }
      // "quit" means quit: go through the ordered `before-quit` shutdown
      // rather than relying on `window-all-closed`, which stays silent while
      // the D216 tray is resident. Mark `quitConfirmed` because the user
      // already chose to quit in the close-behavior dialog above.
      windowState.quitConfirmed = true;
      windowsAllowedToClose.add(window);
      app.quit();
    })();
  });

  const boundsWatchdog = setInterval(() => {
    if (!isLiveWindow()) {
      clearInterval(boundsWatchdog);
      return;
    }
    const cg = readCgBounds();
    const electronBounds = window.getBounds();
    if (!cg && cgHelperAvailable) missingCgStreak += 1;
    else missingCgStreak = 0;
    const shelved =
      (!!cg && (cg.width < 500 || cg.height < 400 || cg.x < -40)) ||
      (!cg && cgHelperAvailable && missingCgStreak >= 3);
    const electronTiny =
      electronBounds.width < 500 || electronBounds.height < 400;
    if (shelved || electronTiny) {
      ensureStableBounds(true);
      return;
    }
    if (Date.now() > pinUntil) {
      try {
        window.setAlwaysOnTop(false);
      } catch {
        // ignore
      }
    }
  }, 1500);
  window.on("closed", () => {
    if (boundsTimer) {
      clearTimeout(boundsTimer);
      boundsTimer = null;
    }
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (workPanelMoveSettleTimer) {
      clearTimeout(workPanelMoveSettleTimer);
      workPanelMoveSettleTimer = null;
    }
    if (workPanelSettleExpiryTimer) {
      clearTimeout(workPanelSettleExpiryTimer);
      workPanelSettleExpiryTimer = null;
    }
    clearInterval(boundsWatchdog);
  });

  window.once("ready-to-show", () => {
    if (!isLiveWindow()) return;
    // Capture runs need the deterministic Codex footprint; normal launches
    // must respect restored user bounds and only fix real shelf states.
    ensureStableBounds(process.env.PI_DESKTOP_CAPTURE === "1");
    window.show();
    window.focus();
    // Burst re-assert only while Stage Manager initially settles / shelves us.
    for (const ms of [100, 250, 500, 1000, 2000, 3500, 5000, 8000, 12000]) {
      setTimeout(() => ensureStableBounds(false), ms);
    }
    if (process.env.PI_DESKTOP_CAPTURE === "1") {
      setTimeout(() => {
        void (async () => {
          try {
            if (!windowState.mainWindow) return;
            const { writeFileSync } = await import("node:fs");
            const shot = async (name: string) => {
              const img = await windowState.mainWindow!.webContents.capturePage();
              writeFileSync(`/tmp/codex-screens/${name}.png`, img.toPNG());
              console.log("CAPTURE", name, img.getSize());
            };
            const clickNav = async (nav: string) => {
              await windowState.mainWindow!.webContents.executeJavaScript(
                `document.querySelector('[data-nav="${nav}"]')?.dispatchEvent(new MouseEvent('click',{bubbles:true}))`,
              );
            };
            const setPage = async (page: string) => {
              await windowState.mainWindow!.webContents.executeJavaScript(
                `window.__PI_DESKTOP__?.setPage?.(${JSON.stringify(page)})`,
              );
            };
            const setSettingsTab = async (tab: string) => {
              await windowState.mainWindow!.webContents.executeJavaScript(
                `window.__PI_DESKTOP__?.setSettingsTab?.(${JSON.stringify(tab)})`,
              );
            };
            const setTheme = async (theme: "light" | "dark") => {
              await windowState.mainWindow!.webContents.executeJavaScript(
                `window.__PI_DESKTOP__?.setThemeAttr?.(${JSON.stringify(theme)})`,
              );
            };
            // Wait until React leaves the starting gate.
            for (let i = 0; i < 40; i++) {
              const state = await windowState.mainWindow!.webContents.executeJavaScript(`({
                readyText: document.body?.innerText?.slice(0,80) || "",
                theme: document.documentElement.dataset.theme || "",
                hasShell: !!document.querySelector(".app-shell"),
                hasSidebar: !!document.querySelector(".sidebar, .sidebar-rail"),
                sidebarClass: document.querySelector(".sidebar, .sidebar-rail")?.className || "",
                navCount: document.querySelectorAll("[data-nav]").length,
              })`);
              console.log("CAPTURE_STATE", i, state);
              if (state.hasShell && state.navCount > 0) break;
              await new Promise((r) => setTimeout(r, 250));
            }
            await windowState.mainWindow!.webContents.executeJavaScript(`
              window.__PI_DESKTOP__?.setThemeAttr?.("light");
              window.__PI_DESKTOP__?.setPage?.("chat");
              // ensure expanded sidebar if rail-only
              if (document.querySelector(".sidebar-rail") && !document.querySelector(".sidebar")) {
                document.dispatchEvent(new KeyboardEvent("keydown", { key: "b", metaKey: true, bubbles: true }));
              }
            `);
            await new Promise((r) => setTimeout(r, 400));
            try {
              await windowState.mainWindow!.webContents.executeJavaScript(
                `window.__PI_CAPTURE__ = 1; void window.__PI_DESKTOP__?.ensureVisualFixtures?.()`,
              );
            } catch {
              // fixtures optional
            }
            // Focused sidebar-status capture: one row per D135 state, in both
            // themes. The status-only mode exits before the broader visual
            // suite and is intended for narrow UI verification.
            if (process.env.PI_DESKTOP_CAPTURE_STATUS_ONLY === "1") {
              if (process.env.PI_DESKTOP_CAPTURE_REDUCED_MOTION === "1") {
                windowState.mainWindow!.webContents.debugger.attach("1.3");
                await windowState.mainWindow!.webContents.debugger.sendCommand(
                  "Emulation.setEmulatedMedia",
                  {
                    features: [
                      { name: "prefers-reduced-motion", value: "reduce" },
                    ],
                  },
                );
              }
              await windowState.mainWindow!.webContents.executeJavaScript(
                `window.__PI_DESKTOP__?.ensureVisualFixtures?.()`,
              );
              await new Promise((r) => setTimeout(r, 300));
              const statusFixture = await windowState.mainWindow!.webContents.executeJavaScript(
                `window.__PI_DESKTOP__?.seedSidebarStatuses?.()`,
              );
              const probeStatuses = async (theme: "light" | "dark") => {
                await setTheme(theme);
                await new Promise((r) => setTimeout(r, 350));
                const probe = await windowState.mainWindow!.webContents.executeJavaScript(`(() => ({
                  theme: document.documentElement.dataset.theme,
                  reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
                  rows: [...document.querySelectorAll('.thread-item-status')].map((status) => {
                    const row = status.closest('.thread-item');
                    const rect = status.getBoundingClientRect();
                    const before = getComputedStyle(status, '::before');
                    return {
                      state: [...status.classList].find((name) => name !== 'thread-item-status'),
                      label: status.getAttribute('aria-label'),
                      color: getComputedStyle(status).color,
                      fill: before.backgroundColor,
                      animation: before.animationName,
                      width: Math.round(rect.width),
                      height: Math.round(rect.height),
                      rowHeight: Math.round(row?.getBoundingClientRect().height || 0),
                    };
                  }),
                }))()`);
                console.log("SIDEBAR_STATUS_PROBE", probe);
                await shot(`pi-sidebar-status-${theme}`);
              };
              console.log("SIDEBAR_STATUS_FIXTURE", statusFixture);
              await probeStatuses("light");
              await probeStatuses("dark");
              console.log("CAPTURE_STATUS_DONE");
              app.quit();
              return;
            }
            // Provider fixture so settings/model-picker scenes have content.
            try {
              const existing = await windowState.host?.call<{ providers?: unknown[] }>(
                "providers.list",
                { includeDisabled: true },
              );
              if (windowState.host && (existing?.providers?.length ?? 0) === 0) {
                await windowState.host.call("providers.create", {
                  name: "OJ Gateway",
                  vendorKey: "custom",
                  type: "openai_compatible",
                  protocol: "openai_compatible",
                  baseUrl: "https://api.oj.ink/v1",
                  authKind: "api_key_and_base_url",
                  defaultModelId: "mimo-v2.5",
                  secretValue: "sk-capture-fixture",
                  apiStyle: "chat_completions",
                });
                await windowState.mainWindow!.webContents.executeJavaScript(
                  `void window.__PI_DESKTOP__?.refreshProviders?.()`,
                );
                await new Promise((r) => setTimeout(r, 300));
              }
            } catch {
              // provider fixture optional
            }
            await new Promise((r) => setTimeout(r, 500));
            // Prefer a titled empty recent (Codex gold selects a real title, not "New task").
            try {
              await windowState.mainWindow!.webContents.executeJavaScript(`
                (() => {
                  const items = [...document.querySelectorAll('.thread-item .thread-item-main, .thread-item-main, .thread-item')];
                  const prefer =
                    items.find((el) => /同步代码/.test(el.textContent || '')) ||
                    items.find((el) => !/新\s*建\s*任\s*务|New task|未命名/i.test(el.textContent || ''));
                  if (prefer) prefer.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                })()
              `);
              await new Promise((r) => setTimeout(r, 450));
            } catch {
              await clickNav("new-task");
              await new Promise((r) => setTimeout(r, 500));
            }
            try {
              if (windowState.mainWindow!.isMinimized()) windowState.mainWindow!.restore();
              windowState.mainWindow!.show();
              windowState.mainWindow!.focus();
              windowState.mainWindow!.moveTop();
            } catch {
              // ignore
            }
            await new Promise((r) => setTimeout(r, 350));
            // Composer visibility probe (empty draft must not collapse)
            const composerProbe = await windowState.mainWindow!.webContents.executeJavaScript(`(() => { const ta=document.querySelector("textarea.composer-input"); if(!ta) return null; const r=ta.getBoundingClientRect(); return {value:ta.value, ph:ta.placeholder, h:ta.offsetHeight, y:Math.round(r.y)}; })()`);
            console.log("COMPOSER_PROBE", composerProbe);
            await shot("pi-final");
            // Work panel scenes are opened by simulated artifacts; production
            // exposes no empty/manual panel entry point (D119). The panels need
            // an active workspace, so switch to a project-scoped session first —
            // otherwise every panel renders its "open a project" empty state.
            await windowState.mainWindow!.webContents.executeJavaScript(`
              (() => {
                const scoped = document.querySelector(
                  "[data-sidebar-project-group] .thread-item-main, [data-sidebar-project-group] .thread-item",
                );
                scoped?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
              })()
            `);
            await new Promise((r) => setTimeout(r, 700));
            // No artifact has run yet, so this session's panel context is
            // empty — the one moment in the suite where the no-resource body
            // and its tool list are on screen (D224). Photograph it in both
            // themes before the artifact scenes create tabs.
            await windowState.mainWindow!.webContents.executeJavaScript(
              `window.__PI_DESKTOP__?.openWorkPanel()`,
            );
            await new Promise((r) => setTimeout(r, 500));
            await shot("pi-panel-empty");
            await setTheme("dark");
            await new Promise((r) => setTimeout(r, 300));
            await shot("pi-panel-empty-dark");
            await setTheme("light");
            await new Promise((r) => setTimeout(r, 300));
            const openPanelArtifact = (kind: string, resource?: string) =>
              windowState.mainWindow!.webContents.executeJavaScript(
                `window.__PI_DESKTOP__?.openWorkPanelArtifact(${JSON.stringify(kind)}, ${JSON.stringify(resource)})`,
              );
            await openPanelArtifact("review");
            // The Review tab reads the session transcript, so without a change
            // fixture every review scene would shoot the empty state.
            await windowState.mainWindow!.webContents.executeJavaScript(
              `void window.__PI_DESKTOP__?.seedReviewChanges?.(4)`,
            );
            await new Promise((r) => setTimeout(r, 500));
            await shot("pi-panel-review");
            // Same rows in the transcript: tool activity is collapsed by
            // default, so open every group, then expand one row's diff.
            await windowState.mainWindow!.webContents.executeJavaScript(`
              (() => {
                for (const header of document.querySelectorAll(".tool-activity-header")) {
                  if (header.getAttribute("aria-expanded") !== "true") {
                    header.dispatchEvent(new MouseEvent("click", { bubbles: true }));
                  }
                }
              })()
            `);
            await new Promise((r) => setTimeout(r, 400));
            await windowState.mainWindow!.webContents.executeJavaScript(`
              (() => {
                const rows = document.querySelectorAll(
                  ".thread-content .review-change-card-header",
                );
                const row = rows[Math.max(0, rows.length - 2)];
                row?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
                row?.scrollIntoView({ block: "center" });
              })()
            `);
            await new Promise((r) => setTimeout(r, 450));
            await shot("pi-review-rows");
            await windowState.mainWindow!.webContents.executeJavaScript(
              `window.__PI_DESKTOP__?.setThemeAttr("dark")`,
            );
            await new Promise((r) => setTimeout(r, 350));
            await shot("pi-review-rows-dark");
            await windowState.mainWindow!.webContents.executeJavaScript(
              `window.__PI_DESKTOP__?.setThemeAttr("light")`,
            );
            await new Promise((r) => setTimeout(r, 250));
            await windowState.mainWindow!.webContents.executeJavaScript(
              `void window.__PI_DESKTOP__?.seedReviewChanges?.(0)`,
            );
            await new Promise((r) => setTimeout(r, 250));
            // A run row keeps its command in the head and only its output in the
            // body (D226). Seed one row per state, open the activity groups, and
            // hover the open row so its copy control and caret are on screen.
            await windowState.mainWindow!.webContents.executeJavaScript(
              `void window.__PI_DESKTOP__?.seedRunRows?.(3)`,
            );
            await new Promise((r) => setTimeout(r, 400));
            await windowState.mainWindow!.webContents.executeJavaScript(`
              (() => {
                for (const header of document.querySelectorAll(".tool-activity-header")) {
                  if (header.getAttribute("aria-expanded") !== "true") {
                    header.dispatchEvent(new MouseEvent("click", { bubbles: true }));
                  }
                }
              })()
            `);
            await new Promise((r) => setTimeout(r, 400));
            await windowState.mainWindow!.webContents.executeJavaScript(`
              (() => {
                const row = document.querySelector(
                  ".tool-row.status-success .tool-row-header",
                );
                row?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
                // The failed row sits above it and opens itself, so framing from
                // there catches every outcome the head can state (D227).
                document
                  .querySelector(".tool-row.status-error")
                  ?.scrollIntoView({ block: "start" });
              })()
            `);
            await new Promise((r) => setTimeout(r, 450));
            await shot("pi-run-rows");
            await windowState.mainWindow!.webContents.executeJavaScript(
              `window.__PI_DESKTOP__?.setThemeAttr("dark")`,
            );
            await new Promise((r) => setTimeout(r, 350));
            await shot("pi-run-rows-dark");
            await windowState.mainWindow!.webContents.executeJavaScript(
              `window.__PI_DESKTOP__?.setThemeAttr("light")`,
            );
            await new Promise((r) => setTimeout(r, 250));
            await windowState.mainWindow!.webContents.executeJavaScript(
              `void window.__PI_DESKTOP__?.seedRunRows?.(0)`,
            );
            await new Promise((r) => setTimeout(r, 250));
            // Every delegation is a card, a lone one included: seed one `Task`
            // and a two-`Task` fan-out so the scene shows the two read alike.
            await windowState.mainWindow!.webContents.executeJavaScript(
              `void window.__PI_DESKTOP__?.seedDelegationRows?.(3)`,
            );
            await new Promise((r) => setTimeout(r, 400));
            await windowState.mainWindow!.webContents.executeJavaScript(`
              (() => {
                for (const header of document.querySelectorAll(".tool-activity-header")) {
                  if (header.getAttribute("aria-expanded") !== "true") {
                    header.dispatchEvent(new MouseEvent("click", { bubbles: true }));
                  }
                }
                document
                  .querySelector(".tool-activity-group.has-subagents")
                  ?.scrollIntoView({ block: "start" });
              })()
            `);
            await new Promise((r) => setTimeout(r, 450));
            await shot("pi-delegation-cards");
            await windowState.mainWindow!.webContents.executeJavaScript(
              `window.__PI_DESKTOP__?.setThemeAttr("dark")`,
            );
            await new Promise((r) => setTimeout(r, 350));
            await shot("pi-delegation-cards-dark");
            await windowState.mainWindow!.webContents.executeJavaScript(
              `window.__PI_DESKTOP__?.setThemeAttr("light")`,
            );
            await new Promise((r) => setTimeout(r, 250));
            await windowState.mainWindow!.webContents.executeJavaScript(
              `void window.__PI_DESKTOP__?.seedDelegationRows?.(0)`,
            );
            await new Promise((r) => setTimeout(r, 250));
            await openPanelArtifact("browser");
            await new Promise((r) => setTimeout(r, 400));
            await shot("pi-panel-browser");
            const probeWorkPanelNewPage = async (scene: string) => {
              const probe = await windowState.mainWindow!.webContents.executeJavaScript(`(() => {
                const blank = document.querySelector('[data-testid="work-panel-empty"]');
                const add = document.querySelector('.work-panel-new-tab');
                return {
                  scene: ${JSON.stringify(scene)},
                  viewport: { width: innerWidth, height: innerHeight },
                  blankPage: Boolean(blank),
                  launcherRows: blank?.querySelectorAll('.work-panel-launcher-row').length ?? 0,
                  popupCount: blank?.querySelectorAll('[role="menu"]').length ?? 0,
                  addHasPopup: add?.hasAttribute('aria-haspopup') ?? false,
                };
              })()`);
              console.log("WORK_PANEL_NEW_PAGE_PROBE", probe);
              if (!probe?.blankPage || probe.launcherRows < 1 || probe.popupCount || probe.addHasPopup) {
                throw new Error(`work-panel blank page contract failed in ${scene}`);
              }
            };
            await windowState.mainWindow!.webContents.executeJavaScript(
              `window.__PI_DESKTOP__?.openNewWorkPanelTab?.()`,
            );
            await new Promise((r) => setTimeout(r, 350));
            await shot("pi-panel-new");
            await probeWorkPanelNewPage("new-page");
            await setTheme("dark");
            await new Promise((r) => setTimeout(r, 300));
            await shot("pi-panel-new-dark");
            await probeWorkPanelNewPage("new-page-dark");
            await setTheme("light");
            await new Promise((r) => setTimeout(r, 250));
            await windowState.mainWindow!.webContents.executeJavaScript(`
              document.querySelector('[data-work-panel-launcher-item="pi.browser/browser"]')?.dispatchEvent(
                new MouseEvent('click', { bubbles: true }),
              )
            `);
            await new Promise((r) => setTimeout(r, 500));
            await shot("pi-panel-browser-from-new");
            await openPanelArtifact("file", "apps/desktop/src/App.tsx");
            await new Promise((r) => setTimeout(r, 500));
            await shot("pi-panel-files");
            await setTheme("dark");
            await new Promise((r) => setTimeout(r, 300));
            await shot("pi-panel-files-dark");
            await setTheme("light");
            await new Promise((r) => setTimeout(r, 250));
            const probeWorkPanelHeader = async (scene: string) => {
              const probe = await windowState.mainWindow!.webContents.executeJavaScript(`(() => {
                const rectFor = (selector) => {
                  const element = document.querySelector(selector);
                  if (!element) return null;
                  const rect = element.getBoundingClientRect();
                  return {
                    left: Math.round(rect.left),
                    top: Math.round(rect.top),
                    right: Math.round(rect.right),
                    bottom: Math.round(rect.bottom),
                  };
                };
                const add = rectFor('.work-panel-new-tab');
                const toggle = rectFor('.app-work-panel-toggle');
                const header = rectFor('.work-panel-header');
                return {
                  scene: ${JSON.stringify(scene)},
                  viewport: { width: innerWidth, height: innerHeight },
                  header,
                  add,
                  toggle,
                  gap: add && toggle ? toggle.left - add.right : null,
                  overlaps: add && toggle
                    ? add.left < toggle.right && add.right > toggle.left &&
                      add.top < toggle.bottom && add.bottom > toggle.top
                    : null,
                };
              })()`);
              console.log("WORK_PANEL_HEADER_PROBE", probe);
              if (probe?.overlaps) {
                throw new Error(`work-panel header controls overlap in ${scene}`);
              }
              if (probe?.gap != null && probe.gap < 24) {
                throw new Error(`work-panel header controls are too close in ${scene}`);
              }
            };
            await probeWorkPanelHeader("browser-from-new");
            // Exercise the smallest supported shell with the smallest panel
            // width. The notification-only 420px scene below intentionally
            // tests a clipped surface, so it is not suitable for this header
            // geometry check.
            await windowState.mainWindow!.webContents.executeJavaScript(
              `window.__PI_DESKTOP__?.setWorkPanelWidth?.(244)`,
            );
            await new Promise((r) => setTimeout(r, 250));
            captureViewportOverride = true;
            try {
              windowState.mainWindow!.setMinimumSize(1040, 700);
              windowState.mainWindow!.setSize(1040, 700, false);
              await new Promise((r) => setTimeout(r, 350));
              await probeWorkPanelHeader("minimum-supported");
              await shot("pi-panel-minimum-supported");
            } finally {
              windowState.mainWindow!.setSize(CODEX_BOUNDS.width, CODEX_BOUNDS.height, false);
              windowState.mainWindow!.setMinimumSize(
                workPanelMinimumWindowWidth(),
                windowMinHeight,
              );
              captureViewportOverride = false;
            }
            await new Promise((r) => setTimeout(r, 250));
            await windowState.mainWindow!.webContents.executeJavaScript(
              `window.__PI_DESKTOP__?.collapseWorkPanel()`,
            );
            await new Promise((r) => setTimeout(r, 300));
            // Open composer + menu for chrome parity proof.
            await windowState.mainWindow!.webContents.executeJavaScript(`
              (() => {
                const btn = document.querySelector('.composer-model-thinking button');
                if (btn) btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
              })()
            `);
            await new Promise((r) => setTimeout(r, 250));
            await shot("pi-model-menu");
            await windowState.mainWindow!.webContents.executeJavaScript(`
              document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            `);
            // Composer autocomplete scenes (D123–D125): "/" command menu and
            // "@" file menu. React's controlled textarea needs the native
            // value setter + input event to register the draft.
            const setComposerDraft = (draft: string) =>
              windowState.mainWindow!.webContents.executeJavaScript(`
                (() => {
                  const ta = document.querySelector("textarea.composer-input");
                  if (!ta) return false;
                  ta.focus();
                  const set = Object.getOwnPropertyDescriptor(
                    HTMLTextAreaElement.prototype,
                    "value",
                  ).set;
                  set.call(ta, ${JSON.stringify(draft)});
                  ta.dispatchEvent(new Event("input", { bubbles: true }));
                  return true;
                })()
              `);
            await setComposerDraft("/");
            await new Promise((r) => setTimeout(r, 450));
            const slashProbe = await windowState.mainWindow!.webContents.executeJavaScript(
              `(() => { const m = document.querySelector(".composer-autocomplete"); return m ? { rows: m.querySelectorAll(".composer-ac-item").length, groups: [...m.querySelectorAll(".composer-model-group-label")].map((g) => g.textContent) } : null; })()`,
            );
            console.log("COMPOSER_AC_SLASH", slashProbe);
            await shot("pi-composer-slash");
            await setComposerDraft("@");
            await new Promise((r) => setTimeout(r, 450));
            const atProbe = await windowState.mainWindow!.webContents.executeJavaScript(
              `(() => { const m = document.querySelector(".composer-autocomplete"); return m ? { rows: m.querySelectorAll(".composer-ac-item").length, empty: m.querySelector(".composer-model-empty")?.textContent || "" } : null; })()`,
            );
            console.log("COMPOSER_AC_AT", atProbe);
            await shot("pi-composer-at");
            await setComposerDraft("");
            await new Promise((r) => setTimeout(r, 200));
            // Conversation minimap: seed a capture-only transcript, magnify
            // mid-rail (Dock effect + preview popover), then restore.
            await windowState.mainWindow!.webContents.executeJavaScript(
              `void window.__PI_DESKTOP__?.seedTranscript?.()`,
            );
            await new Promise((r) => setTimeout(r, 600));
            await shot("pi-minimap");
            const minimapProbe = await windowState.mainWindow!.webContents.executeJavaScript(`
              (() => {
                const rail = document.querySelector(".minimap-rail");
                if (!rail) return null;
                const r = rail.getBoundingClientRect();
                rail.dispatchEvent(new MouseEvent("mousemove", {
                  bubbles: true,
                  clientX: r.left + 10,
                  clientY: r.top + r.height / 2,
                }));
                return { markers: rail.querySelectorAll(".minimap-marker").length };
              })()
            `);
            console.log("MINIMAP_PROBE", minimapProbe);
            await new Promise((r) => setTimeout(r, 350));
            await shot("pi-minimap-hover");
            await windowState.mainWindow!.webContents.executeJavaScript(
              `void window.__PI_DESKTOP__?.seedTranscript?.(0)`,
            );
            await new Promise((r) => setTimeout(r, 250));
            // Notification inbox: mixed status, long title, read state, 99+ badge,
            // both themes, then the responsive fixed-position popover.
            const openNotificationFixture = async () => {
              await windowState.mainWindow!.webContents.executeJavaScript(`
                window.__PI_DESKTOP__?.seedNotifications?.(105);
                document.querySelector('.notification-trigger')?.dispatchEvent(
                  new MouseEvent('click', { bubbles: true })
                );
              `);
              // Opening refreshes the durable inbox; reapply the capture-only
              // fixture after that request settles.
              await new Promise((r) => setTimeout(r, 350));
              await windowState.mainWindow!.webContents.executeJavaScript(
                `window.__PI_DESKTOP__?.seedNotifications?.(105)`,
              );
              await new Promise((r) => setTimeout(r, 150));
            };
            const probeNotificationFixture = async (scene: string) => {
              const probe = await windowState.mainWindow!.webContents.executeJavaScript(`(() => {
                const popover = document.querySelector('.notification-popover');
                const title = document.querySelector('.notification-item-title');
                const badge = document.querySelector('.notification-badge');
                if (!popover || !title) return null;
                const rect = popover.getBoundingClientRect();
                const titleStyle = getComputedStyle(title);
                return {
                  scene: ${JSON.stringify(scene)},
                  viewport: { width: innerWidth, height: innerHeight },
                  popover: {
                    left: Math.round(rect.left),
                    top: Math.round(rect.top),
                    right: Math.round(rect.right),
                    bottom: Math.round(rect.bottom),
                    position: getComputedStyle(popover).position,
                  },
                  withinViewport:
                    rect.left >= 0 && rect.top >= 0 &&
                    rect.right <= innerWidth && rect.bottom <= innerHeight,
                  badge: badge?.textContent?.trim() || '',
                  rowCount: document.querySelectorAll('.notification-item').length,
                  unreadRows: document.querySelectorAll('.notification-item.unread').length,
                  failedRows: document.querySelectorAll('.notification-kind-icon.failed').length,
                  titleTruncated:
                    title.scrollWidth > title.clientWidth &&
                    titleStyle.textOverflow === 'ellipsis',
                };
              })()`);
              console.log("NOTIFICATION_PROBE", probe);
            };
            await setTheme("light");
            await setPage("chat");
            await openNotificationFixture();
            await probeNotificationFixture("light");
            await shot("pi-notifications-light");
            await windowState.mainWindow!.webContents.executeJavaScript(`
              document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            `);
            await setTheme("dark");
            await openNotificationFixture();
            await probeNotificationFixture("dark");
            await shot("pi-notifications-dark");
            await windowState.mainWindow!.webContents.executeJavaScript(`
              document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            `);
            captureViewportOverride = true;
            try {
              windowState.mainWindow!.setMinimumSize(420, 640);
              windowState.mainWindow!.setSize(420, 760, false);
              await new Promise((r) => setTimeout(r, 250));
              await setTheme("light");
              await openNotificationFixture();
              await probeNotificationFixture("narrow");
              await shot("pi-notifications-narrow");
              await windowState.mainWindow!.webContents.executeJavaScript(`
                document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
                window.__PI_DESKTOP__?.seedNotifications?.(0);
              `);
            } finally {
              windowState.mainWindow!.setSize(CODEX_BOUNDS.width, CODEX_BOUNDS.height, false);
              windowState.mainWindow!.setMinimumSize(
                workPanelMinimumWindowWidth(),
                windowMinHeight,
              );
              captureViewportOverride = false;
            }
            await new Promise((r) => setTimeout(r, 300));
            // Destination + theme captures (robust via __PI_DESKTOP__ hooks).
            await setTheme("dark");
            await setPage("chat");
            await new Promise((r) => setTimeout(r, 250));
            await shot("pi-dark-home");
            // Destinations are lazy route chunks; the first visit needs long
            // enough for the chunk to resolve or the shot catches a spinner.
            await setPage("settings");
            await setSettingsTab("projects");
            await new Promise((r) => setTimeout(r, 800));
            await shot("pi-dark-project-archive");
            await setPage("pulls");
            await new Promise((r) => setTimeout(r, 800));
            await shot("pi-dark-pulls");
            await setPage("settings");
            await setSettingsTab("general");
            await new Promise((r) => setTimeout(r, 800));
            await shot("pi-dark-settings");
            await setTheme("light");
            await setPage("pulls");
            await new Promise((r) => setTimeout(r, 600));
            await shot("pi-pulls-live");
            await setSettingsTab("projects");
            await new Promise((r) => setTimeout(r, 500));
            await shot("pi-project-archive-live");
            await setPage("scheduled");
            await new Promise((r) => setTimeout(r, 700));
            await shot("pi-scheduled-live");
            await windowState.mainWindow!.webContents.executeJavaScript(
              `window.__PI_DESKTOP__?.seedPlugins?.(4);
               window.__PI_DESKTOP__?.seedExtensions?.(3)`,
            );
            await setPage("plugins");
            await new Promise((r) => setTimeout(r, 350));
            // Mounting the page refreshes the store slice from IPC, which
            // replaces the fixture with the real (near-empty) index; seed again
            // once the mount effect has settled.
            await windowState.mainWindow!.webContents.executeJavaScript(
              `window.__PI_DESKTOP__?.seedPlugins?.(4)`,
            );
            await new Promise((r) => setTimeout(r, 250));
            await shot("pi-plugins-live");
            // Disclosed row details: capability, service and permission chips
            // inside the raised detail block (D296).
            await windowState.mainWindow!.webContents.executeJavaScript(`
              (() => {
                const details = document.querySelector('.plugins-row-details');
                if (details) details.open = true;
              })()
            `);
            await new Promise((r) => setTimeout(r, 250));
            await shot("pi-plugins-row-details");
            await windowState.mainWindow!.webContents.executeJavaScript(`
              (() => {
                const details = document.querySelector('.plugins-row-details');
                if (details) details.open = false;
              })()
            `);
            // Row overflow menu on the last row of a group: rows are separate
            // tiles, so this scene guards the menu against the tile below.
            await windowState.mainWindow!.webContents.executeJavaScript(`
              (() => {
                const rows = [...document.querySelectorAll('.plugins-row')];
                const last = rows[rows.length - 1];
                last?.scrollIntoView({ block: 'center' });
                const btns = [...(last?.querySelectorAll('.plugins-row-actions .plugins-icon-btn') ?? [])];
                btns[btns.length - 1]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
              })()
            `);
            await new Promise((r) => setTimeout(r, 250));
            await shot("pi-plugins-row-menu");
            await windowState.mainWindow!.webContents.executeJavaScript(
              `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`,
            );
            await new Promise((r) => setTimeout(r, 150));
            // The page's segments, in order: installed, marketplace. (MCP,
            // skills and subagents moved to Settings; their scenes below are
            // shot from there and only reuse this helper's click plumbing.)
            const extTab = async (index: number, settle = 350) => {
              await windowState.mainWindow!.webContents.executeJavaScript(`
                (() => {
                  const tabs = [...document.querySelectorAll('.plugins-segment-btn')];
                  tabs[${index}]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                })()
              `);
              await new Promise((r) => setTimeout(r, settle));
            };
            // MCP tab: one row per connection state and per activation state, so
            // the glyph colours and the scope chip are all on screen at once.
            await extTab(1);
            await shot("pi-extensions-mcp");
            // The scope popover has to escape the panel's rounded-corner clip,
            // so it is opened on the last row where a clip would show.
            await windowState.mainWindow!.webContents.executeJavaScript(`
              (() => {
                const rows = [...document.querySelectorAll('.ext-row')];
                const last = rows[rows.length - 1];
                last?.scrollIntoView({ block: 'center' });
                last?.querySelector('.scope-chip')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
                  ?? last?.querySelector('.scope-seg:nth-child(2)')
                    ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
              })()
            `);
            await new Promise((r) => setTimeout(r, 300));
            await shot("pi-extensions-scope");
            await windowState.mainWindow!.webContents.executeJavaScript(
              `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`,
            );
            await new Promise((r) => setTimeout(r, 150));
            // Editor sheet: transport cards, key/value rows, and the in-sheet
            // scope field that renders in place instead of floating.
            await windowState.mainWindow!.webContents.executeJavaScript(`
              (() => {
                document.querySelector('.ext-section-actions button:last-of-type')
                  ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
              })()
            `);
            await new Promise((r) => setTimeout(r, 300));
            await shot("pi-extensions-mcp-editor");
            await windowState.mainWindow!.webContents.executeJavaScript(
              `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`,
            );
            await new Promise((r) => setTimeout(r, 200));
            // Skills tab: the byte counter and the disabled row read differently
            // from the MCP rows, so it gets its own scene.
            await extTab(2);
            await shot("pi-extensions-skills");
            // Subagents tab: the writable registry list, whose rows carry the
            // Task handle, the tinted mutating grants and the shadow/inactive
            // tags, above the read-only effective catalog.
            await extTab(3);
            await shot("pi-extensions-subagents");
            // The read-only half sits below the fold: builtin and project rows,
            // which carry a source tag and a copy action instead of a scope.
            await windowState.mainWindow!.webContents.executeJavaScript(`
              (() => {
                const rows = [...document.querySelectorAll('.ext-row')];
                rows[rows.length - 1]?.scrollIntoView({ block: 'end' });
              })()
            `);
            await new Promise((r) => setTimeout(r, 300));
            await shot("pi-extensions-subagents-provided");
            await windowState.mainWindow!.webContents.executeJavaScript(
              `document.querySelector('.plugins-page')?.scrollTo(0, 0)`,
            );
            await new Promise((r) => setTimeout(r, 200));
            // Editor sheet: the tool grant sits above the prompt, which is the
            // whole point of the field order, so it needs to be on screen.
            await windowState.mainWindow!.webContents.executeJavaScript(`
              (() => {
                document.querySelector('.ext-section-actions button:last-of-type')
                  ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
              })()
            `);
            await new Promise((r) => setTimeout(r, 350));
            await shot("pi-extensions-subagent-editor");
            await windowState.mainWindow!.webContents.executeJavaScript(
              `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`,
            );
            await new Promise((r) => setTimeout(r, 200));
            await setTheme("dark");
            await new Promise((r) => setTimeout(r, 300));
            await shot("pi-extensions-subagents-dark");
            await setTheme("light");
            await new Promise((r) => setTimeout(r, 250));
            await extTab(1, 250);
            await setTheme("dark");
            await new Promise((r) => setTimeout(r, 300));
            await shot("pi-extensions-mcp-dark");
            await setTheme("light");
            await new Promise((r) => setTimeout(r, 250));
            // Marketplace tab of the same page (D169 segmented control, fifth
            // since D202).
            await extTab(1, 900);
            await shot("pi-plugins-market");
            // Detail sheet opened from the first card: head, install CTA and
            // the section stack without rules between them (D296).
            await windowState.mainWindow!.webContents.executeJavaScript(`
              document.querySelector('.plugins-card-hit')
                ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
            `);
            await new Promise((r) => setTimeout(r, 500));
            await shot("pi-plugins-sheet");
            await windowState.mainWindow!.webContents.executeJavaScript(
              `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`,
            );
            await new Promise((r) => setTimeout(r, 250));
            // Template picker behind the overflow menu (D171). Selecting a
            // template only sets state, so no folder dialog opens here.
            await extTab(0, 250);
            await windowState.mainWindow!.webContents.executeJavaScript(`
              document
                .querySelector('.plugins-menu-wrap .plugins-icon-btn')
                ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
            `);
            await new Promise((r) => setTimeout(r, 250));
            await shot("pi-plugins-menu");
            await windowState.mainWindow!.webContents.executeJavaScript(`
              (() => {
                const items = [...document.querySelectorAll('.plugins-menu [role="menuitem"]')];
                items[items.length - 1]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
              })()
            `);
            await new Promise((r) => setTimeout(r, 300));
            await shot("pi-plugins-template");
            await windowState.mainWindow!.webContents.executeJavaScript(`
              (() => {
                const cancel = document.querySelector('.plugins-modal-actions button');
                cancel?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
              })()
            `);
            await new Promise((r) => setTimeout(r, 200));
            await windowState.mainWindow!.webContents.executeJavaScript(
              `window.__PI_DESKTOP__?.seedPlugins?.(0);
               window.__PI_DESKTOP__?.seedExtensions?.(0);
               window.__PI_DESKTOP__?.seedPluginThemes?.(2)`,
            );
            await setPage("settings");
            // The general tab carries the theme picker, including plugin themes
            // (D175); earlier scenes leave the sidebar on the archive tab.
            await setSettingsTab("general");
            // Seeding plugin themes activates one of them, which drags the
            // shell dark; the settings tabs are documented in light.
            await setTheme("light");
            await new Promise((r) => setTimeout(r, 350));
            await shot("pi-settings-live");
            await windowState.mainWindow!.webContents.executeJavaScript(
              `window.__PI_DESKTOP__?.seedPluginThemes?.(0)`,
            );
            // Dropping the seeded plugin themes re-applies the stored theme,
            // which is still dark from the destination pass; the remaining
            // settings scenes are light so the tabs read as one sequence.
            await setTheme("light");
            // Model configuration tab: vendor accounts, provider cards,
            // defaults, edit dialog. Addressed by tab id — the settings nav
            // has been reordered since this scene was written.
            await setSettingsTab("agent");
            await new Promise((r) => setTimeout(r, 350));
            await shot("pi-settings-models");
            await windowState.mainWindow!.webContents.executeJavaScript(`
              (() => {
                const edit = [...document.querySelectorAll('.provider-row-actions .provider-icon-btn')][0];
                const add = document.querySelector('.provider-section-head button');
                (edit ?? add)?.dispatchEvent(new MouseEvent('click',{bubbles:true}));
              })()
            `);
            await new Promise((r) => setTimeout(r, 350));
            await shot("pi-settings-provider-dialog");
            await windowState.mainWindow!.webContents.executeJavaScript(`
              document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            `);
            await new Promise((r) => setTimeout(r, 200));
            // Plugins marketplace: the source picker lives beside the catalog,
            // including the custom URL row that only appears for that source.
            await setPage("plugins");
            await windowState.mainWindow!.webContents.executeJavaScript(
              `document.querySelector('#plugins-tab-market')?.dispatchEvent(new MouseEvent('click',{bubbles:true}))`,
            );
            await new Promise((r) => setTimeout(r, 350));
            await shot("pi-settings-extensions");
            await windowState.mainWindow!.webContents.executeJavaScript(`
              (() => {
                const select = document.querySelector('.plugins-market-settings select');
                if (!select) return;
                const setter = Object.getOwnPropertyDescriptor(
                  window.HTMLSelectElement.prototype, 'value',
                )?.set;
                setter?.call(select, 'custom');
                select.dispatchEvent(new Event('change', { bubbles: true }));
              })()
            `);
            await new Promise((r) => setTimeout(r, 350));
            await shot("pi-settings-extensions-custom");
            await setPage("chat");
            await setTheme("light");
            await new Promise((r) => setTimeout(r, 250));
            const openSearch = () =>
              windowState.mainWindow!.webContents.executeJavaScript(`
                document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
              `);
            const typeSearch = (value: string) =>
              windowState.mainWindow!.webContents.executeJavaScript(`
                (() => {
                  const input = document.querySelector(".search-input");
                  if (!input) return;
                  const setter = Object.getOwnPropertyDescriptor(
                    window.HTMLInputElement.prototype,
                    "value",
                  ).set;
                  setter.call(input, ${JSON.stringify(value)});
                  input.dispatchEvent(new Event("input", { bubbles: true }));
                })()
              `);
            const searchKey = (key: string) =>
              windowState.mainWindow!.webContents.executeJavaScript(`
                document.querySelector(".search-input")?.dispatchEvent(
                  new KeyboardEvent("keydown", { key: ${JSON.stringify(key)}, bubbles: true }),
                );
              `);
            await openSearch();
            await new Promise((r) => setTimeout(r, 450));
            await shot("pi-search");
            await typeSearch("设计");
            await new Promise((r) => setTimeout(r, 350));
            await shot("pi-search-query");
            // Settings hits: "主题" resolves to 通用 tab's theme row.
            await typeSearch("主题");
            await new Promise((r) => setTimeout(r, 350));
            await shot("pi-search-settings");
            await setTheme("dark");
            await new Promise((r) => setTimeout(r, 250));
            await shot("pi-search-dark");
            await setTheme("light");
            await new Promise((r) => setTimeout(r, 250));
            // Page hits: "插件" surfaces the plugins page entry.
            await typeSearch("插件");
            await new Promise((r) => setTimeout(r, 350));
            await shot("pi-search-pages");
            // Anchor flash: Enter on the 主题 settings hit lands on 基础 and
            // flashes the theme row.
            await typeSearch("主题");
            await new Promise((r) => setTimeout(r, 350));
            await searchKey("ArrowDown");
            await searchKey("Enter");
            await new Promise((r) => setTimeout(r, 400));
            await shot("pi-search-anchor");
            // The anchor scene leaves the ⌘K dialog open; dismiss it so the
            // home hero below is unobstructed. The dialog only listens on its
            // own subtree, so close it the way a user does — click the overlay.
            await searchKey("Escape");
            await windowState.mainWindow!.webContents.executeJavaScript(`
              document.querySelector(".search-overlay")?.dispatchEvent(
                new MouseEvent("click", { bubbles: true }),
              );
            `);
            await new Promise((r) => setTimeout(r, 300));
            await setPage("chat");
            await new Promise((r) => setTimeout(r, 250));
            // Empty home hero in both themes — the first surface a new install
            // shows, and the one the README and docs gallery lead with. Shot
            // before the toast stack so the hero stays unobstructed.
            await clickNav("new-task");
            await new Promise((r) => setTimeout(r, 600));
            // Seeding the marketplace earlier raised a toast that outlives the
            // scenes above; clear the viewport so the hero is the only subject.
            const clearToasts = () =>
              windowState.mainWindow!.webContents.executeJavaScript(`
                document.querySelectorAll(".toast-dismiss").forEach((button) =>
                  button.dispatchEvent(new MouseEvent("click", { bubbles: true })),
                );
              `);
            await clearToasts();
            await new Promise((r) => setTimeout(r, 400));
            await shot("pi-home-light");
            await setTheme("dark");
            await new Promise((r) => setTimeout(r, 350));
            await shot("pi-home-dark");
            await setTheme("light");
            await new Promise((r) => setTimeout(r, 250));
            // Toast stack proof (ToastHost variants) in both themes.
            const raiseToasts = () =>
              windowState.mainWindow!.webContents.executeJavaScript(`
                window.__PI_DESKTOP__?.showToast?.("Provider saved", { variant: "success" });
                window.__PI_DESKTOP__?.showToast?.("Reconnecting to local backend…", { variant: "warning" });
                window.__PI_DESKTOP__?.showToast?.("Model request failed: 401 Unauthorized", { variant: "error" });
              `);
            await raiseToasts();
            await new Promise((r) => setTimeout(r, 400));
            await shot("pi-toasts-light");
            await setTheme("dark");
            await raiseToasts();
            await new Promise((r) => setTimeout(r, 400));
            await shot("pi-toasts-dark");
            await setTheme("light");
            console.log("CAPTURE_DONE");
            await windowState.mainWindow!.webContents.executeJavaScript(`
              document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            `);
            } catch (e) {
            console.error(e);
          }
        })();
      }, 1800);
    }
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    await window.loadURL(process.env.ELECTRON_RENDERER_URL);
    if (process.env.PI_DESKTOP_DEVTOOLS === "1") {
      window.webContents.openDevTools({ mode: "detach" });
    }
  } else {
    await window.loadFile(join(__dirname, "../renderer/index.html"));
  }
}
