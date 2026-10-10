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
): Pick<BrowserWindowConstructorOptions, "backgroundColor" | "transparent"> {
  if (platform === "win32") {
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
): boolean {
  if (platform === "darwin") return false;

  const electronColor = toElectronBackgroundColor(color);
  if (platform === "win32") {
    window.contentView.setBackgroundColor(electronColor);
  } else {
    window.setBackgroundColor(electronColor);
  }
  return true;
}
