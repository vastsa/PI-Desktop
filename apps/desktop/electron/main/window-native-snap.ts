import type { BrowserWindow } from "electron";
import type { HostProcess } from "./host-process";
import type { Logger } from "./logger";
import { isWindowFullScreen } from "./window-fullscreen.ts";
import { nativeWindowHandle } from "./window-native-handle.ts";

/** Restore shell styles without opting back into Electron's native frame insets. */
export async function installWindowsNativeSnap(
  window: BrowserWindow,
  getHost: () => Pick<HostProcess, "call"> | null,
  logger: Pick<Logger, "app">,
): Promise<{ flush: () => Promise<void> }> {
  const nativeHandle = nativeWindowHandle(window);
  let disposed = false;
  let pending: Promise<void> = Promise.resolve();
  const apply = (): Promise<void> => {
    pending = pending.catch(() => undefined).then(async () => {
      if (disposed || window.isDestroyed() || isWindowFullScreen(window)) return;
      const host = getHost();
      if (!host) throw new Error("host-core is unavailable for native window snapping");
      await host.call("window.enableNativeSnap", { nativeHandle, ownerPid: process.pid }, 5_000);
    });
    return pending;
  };
  const reportFailure = (error: unknown) => {
    logger.app("lifecycle", "warn", "native window snapping failed", { data: String(error) });
  };
  const refresh = () => { void apply().catch(reportFailure); };
  window.on("show", refresh);
  window.on("focus", refresh);
  window.on("blur", refresh);
  window.on("restore", refresh);
  window.on("maximize", refresh);
  window.on("unmaximize", refresh);
  window.on("leave-full-screen", refresh);
  window.once("closed", () => {
    disposed = true;
    window.removeListener("show", refresh);
    window.removeListener("focus", refresh);
    window.removeListener("blur", refresh);
    window.removeListener("restore", refresh);
    window.removeListener("maximize", refresh);
    window.removeListener("unmaximize", refresh);
    window.removeListener("leave-full-screen", refresh);
  });
  await apply().catch(reportFailure);
  return { flush: () => pending };
}
