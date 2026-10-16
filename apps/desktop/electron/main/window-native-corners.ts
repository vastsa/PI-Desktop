import type { BrowserWindow, Screen } from "electron";
import { MAX_WINDOW_CORNER_RADIUS } from "@pi-desktop/plugin-sdk";
import type { HostProcess } from "./host-process";
import type { Logger } from "./logger";
import { isWindowFullScreen } from "./window-fullscreen.ts";

/** Matches the renderer's global `--radius-md` token (12px). */
export const DEFAULT_WINDOW_CORNER_RADIUS = 12;

export function normalizeWindowCornerRadius(radius: number): number {
  return Math.max(0, Math.min(MAX_WINDOW_CORNER_RADIUS, Math.round(radius)));
}

const controllers = new WeakMap<BrowserWindow, NativeCornerController>();

export type NativeCornerController = {
  setRadius: (radius: number) => Promise<number>;
  flush: () => Promise<void>;
};

type CornerScreen = Pick<Screen, "on" | "removeListener">;
type HostProvider = () => HostProcess | null;
type WindowLogger = Pick<Logger, "app">;

/** Windows 11 reports NT 10.0 with a build number starting at 22000. */
export function usesWindows11NativeCorners(
  platform: NodeJS.Platform,
  systemVersion: string,
): boolean {
  if (platform !== "win32") return false;
  const parts = systemVersion.split(".");
  const major = Number(parts[0]);
  const minor = Number(parts[1]);
  const build = Number(parts[2]);
  return Number.isInteger(major) && Number.isInteger(minor) && Number.isInteger(build) &&
    (major > 10 || (major === 10 && minor === 0 && build >= 22000));
}

function nativeHandleAsDecimal(window: BrowserWindow): string {
  const bytes = window.getNativeWindowHandle();
  if (bytes.length === 0) throw new Error("native window handle is unavailable");
  let handle = 0n;
  for (let index = bytes.length - 1; index >= 0; index -= 1) {
    const byte = bytes[index];
    if (byte === undefined) throw new Error("native window handle is invalid");
    handle = (handle << 8n) | BigInt(byte);
  }
  if (handle === 0n) throw new Error("native window handle is invalid");
  return handle.toString(10);
}

/** Keep Windows 10's native rectangle; only Windows 11 can round a thick frame. */
export async function installWindowsCornerController(
  window: BrowserWindow,
  systemVersion: string,
  getHost: HostProvider,
  windowScreen: CornerScreen,
  logger: WindowLogger,
  initialRadius = DEFAULT_WINDOW_CORNER_RADIUS,
): Promise<NativeCornerController> {
  if (usesWindows11NativeCorners("win32", systemVersion)) {
    return installWindows11CornerController(window, initialRadius, getHost, windowScreen, logger);
  }

  // A content-sized setShape() region is relative to the outer HWND, not its
  // client origin: it exposes the left non-client rim and cuts the right edge.
  // Cropping to the client area would also remove native resize hit regions.
  // Leave both the HWND and content view unclipped on Windows 10. Continue to
  // acknowledge theme radius requests without changing the IPC response shape.
  const controller: NativeCornerController = {
    setRadius: async (radius) => normalizeWindowCornerRadius(radius),
    flush: async () => {},
  };
  controllers.set(window, controller);
  window.once("closed", () => controllers.delete(window));
  return controller;
}

/**
 * Use the Windows 11 DWM preference for the main window. The native API owns
 * the visible edge and hit testing; earlier Windows builds stay rectangular.
 */
export async function installWindows11CornerController(
  window: BrowserWindow,
  initialRadius: number = DEFAULT_WINDOW_CORNER_RADIUS,
  getHost: HostProvider,
  windowScreen: CornerScreen,
  logger: WindowLogger,
): Promise<NativeCornerController> {
  const nativeHandle = nativeHandleAsDecimal(window);
  let radius = normalizeWindowCornerRadius(initialRadius);
  let generation = 0;
  let disposed = false;
  let pending: Promise<void> = Promise.resolve();

  const enqueue = (): Promise<void> => {
    const requestGeneration = ++generation;
    const rounded = radius > 0 && !window.isMaximized() && !isWindowFullScreen(window);
    const operation = pending.catch(() => undefined).then(async () => {
      if (disposed || window.isDestroyed() || requestGeneration !== generation) return;
      const host = getHost();
      if (!host) throw new Error("host-core is unavailable for native window corners");
      await host.call("window.setNativeCornerPreference", {
        nativeHandle,
        ownerPid: process.pid,
        preference: rounded ? "round" : "square",
      }, 5_000);
    });
    pending = operation;
    return operation;
  };

  const reportFailure = (error: unknown) => {
    logger.app("lifecycle", "warn", "native window corner preference failed", {
      data: String(error),
    });
  };
  const reapply = () => {
    void enqueue().catch(reportFailure);
  };
  const reapplyAfterFullScreen = () => {
    // Electron publishes the native fullscreen flag after its window event.
    setImmediate(() => {
      if (disposed || window.isDestroyed()) return;
      reapply();
    });
  };
  const controller: NativeCornerController = {
    async setRadius(nextRadius) {
      radius = normalizeWindowCornerRadius(nextRadius);
      try {
        await enqueue();
        // If another state transition queued while this request was pending,
        // wait until the newest preference has reached DWM before replying.
        while (true) {
          const latest = pending;
          await latest;
          if (latest === pending) break;
        }
        return radius;
      } catch (error) {
        reportFailure(error);
        throw error;
      }
    },
    async flush() {
      while (true) {
        const latest = pending;
        await latest;
        if (latest === pending) return;
      }
    },
  };
  controllers.set(window, controller);

  window.on("maximize", reapply);
  window.on("unmaximize", reapply);
  window.on("enter-full-screen", reapplyAfterFullScreen);
  window.on("leave-full-screen", reapplyAfterFullScreen);
  window.on("show", reapply);
  window.on("restore", reapply);
  windowScreen.on("display-metrics-changed", reapply);
  windowScreen.on("display-added", reapply);
  windowScreen.on("display-removed", reapply);

  const dispose = () => {
    disposed = true;
    window.removeListener("maximize", reapply);
    window.removeListener("unmaximize", reapply);
    window.removeListener("enter-full-screen", reapplyAfterFullScreen);
    window.removeListener("leave-full-screen", reapplyAfterFullScreen);
    window.removeListener("show", reapply);
    window.removeListener("restore", reapply);
    window.removeListener("closed", dispose);
    windowScreen.removeListener("display-metrics-changed", reapply);
    windowScreen.removeListener("display-added", reapply);
    windowScreen.removeListener("display-removed", reapply);
    controllers.delete(window);
  };
  window.once("closed", dispose);

  try {
    await controller.setRadius(radius);
  } catch {
    // Keep startup available when the backend cannot apply the optional DWM
    // hint. The failure is logged; Windows may still apply its default policy.
  }
  return controller;
}

/** Acknowledge a theme's radius request; the installed platform policy owns its rendering. */
export async function applyWindowCornerRadius(
  window: BrowserWindow,
  radius: number,
): Promise<number | null> {
  if (window.isDestroyed()) return null;
  const nativeController = controllers.get(window);
  if (nativeController) return nativeController.setRadius(radius);
  return null;
}
