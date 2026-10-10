import type { BrowserWindow, Screen } from "electron";
import type { HostProcess } from "./host-process";
import type { Logger } from "./logger";
import { isWindowFullScreen } from "./window-fullscreen.ts";
import {
  DEFAULT_WINDOW_CORNER_RADIUS,
  normalizeWindowCornerRadius,
  setWindowCornerRadius,
} from "./window-shape.ts";

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

/**
 * Use the Windows 11 DWM preference for the main window. The native API owns
 * the visible edge and hit testing; Electron's region-based shape remains the
 * fallback for Windows builds before 22000.
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
  window.on("enter-full-screen", reapply);
  window.on("leave-full-screen", reapply);
  window.on("show", reapply);
  window.on("restore", reapply);
  windowScreen.on("display-metrics-changed", reapply);
  windowScreen.on("display-added", reapply);
  windowScreen.on("display-removed", reapply);

  const dispose = () => {
    disposed = true;
    window.removeListener("maximize", reapply);
    window.removeListener("unmaximize", reapply);
    window.removeListener("enter-full-screen", reapply);
    window.removeListener("leave-full-screen", reapply);
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

/** Apply a theme's requested radius through DWM or the legacy Windows path. */
export async function applyWindowCornerRadius(
  window: BrowserWindow,
  radius: number,
): Promise<number | null> {
  const nativeController = controllers.get(window);
  if (nativeController) return nativeController.setRadius(radius);
  return setWindowCornerRadius(window, radius);
}
