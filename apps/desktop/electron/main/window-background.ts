import type { BrowserWindow, BrowserWindowConstructorOptions } from "electron";
import { isWindowBackgroundColor } from "@pi-desktop/plugin-sdk";

type BackgroundPlatform = NodeJS.Platform;
type BackgroundWindow = Pick<BrowserWindow, "contentView" | "setBackgroundColor">;

/** Convert the Plugin SDK's RRGGBBAA value to Electron's unambiguous CSS form. */
export function toElectronBackgroundColor(color: string): string {
  if (!isWindowBackgroundColor(color)) {
    throw new TypeError("invalid window background color");
  }

  const red = Number.parseInt(color.slice(1, 3), 16);
  const green = Number.parseInt(color.slice(3, 5), 16);
  const blue = Number.parseInt(color.slice(5, 7), 16);
  const alpha = color.length === 9
    ? Number.parseInt(color.slice(7, 9), 16) / 255
    : 1;
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

/** Options needed before the main window is created to avoid a color flash. */
export function mainWindowBackgroundOptions(
  platform: BackgroundPlatform,
  color: string,
  windows11NativeCorners = false,
  opaqueFallbackColor = color,
): Pick<BrowserWindowConstructorOptions, "backgroundColor" | "transparent"> {
  if (platform === "win32") {
    if (windows11NativeCorners) {
      return {
        transparent: false,
        backgroundColor: toOpaqueElectronBackgroundColor(color, opaqueFallbackColor),
      };
    }
    return { transparent: true, backgroundColor: "#00000000" };
  }
  if (platform === "darwin") return {};
  return { backgroundColor: toElectronBackgroundColor(color) };
}

/** Apply a theme background to its platform-owned surface. */
export function applyMainWindowBackground(
  window: BackgroundWindow,
  platform: BackgroundPlatform,
  color: string,
  windows11NativeCorners = false,
  opaqueFallbackColor = color,
): boolean {
  if (platform === "darwin") return false;

  const useOpaqueWindowsSurface = platform === "win32" && windows11NativeCorners;
  const electronColor = useOpaqueWindowsSurface
    ? toOpaqueElectronBackgroundColor(color, opaqueFallbackColor)
    : toElectronBackgroundColor(color);
  if (platform === "win32" && !useOpaqueWindowsSurface) {
    window.contentView.setBackgroundColor(electronColor);
  } else {
    window.setBackgroundColor(electronColor);
  }
  return true;
}

/**
 * Windows 11's DWM corner path requires an opaque top-level surface. Preserve
 * a plugin theme's translucent color by flattening it onto the host palette.
 */
function toOpaqueElectronBackgroundColor(color: string, fallbackColor: string): string {
  if (!isWindowBackgroundColor(color) || !isWindowBackgroundColor(fallbackColor)) {
    throw new TypeError("invalid window background color");
  }

  const foreground = [
    Number.parseInt(color.slice(1, 3), 16),
    Number.parseInt(color.slice(3, 5), 16),
    Number.parseInt(color.slice(5, 7), 16),
  ];
  const background = [
    Number.parseInt(fallbackColor.slice(1, 3), 16),
    Number.parseInt(fallbackColor.slice(3, 5), 16),
    Number.parseInt(fallbackColor.slice(5, 7), 16),
  ];
  const alpha = color.length === 9 ? Number.parseInt(color.slice(7, 9), 16) / 255 : 1;
  const channels = foreground.map((value, index) => {
    const behind = background[index];
    if (behind === undefined) throw new TypeError("invalid window background color");
    return Math.round(value * alpha + behind * (1 - alpha));
  });
  return `#${channels.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}
