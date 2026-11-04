import { shell } from "electron";
import { needsAccessibilityRequest, type ComputerCapabilities } from "@pi-desktop/shared";

/** Fixed OS pane only; neither renderer nor model can supply an external URL. */
export const ACCESSIBILITY_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";

/** TCC may not show another prompt, so expose the switch in System Settings. */
export async function openAccessibilitySettings(
  capabilities: ComputerCapabilities,
  openExternal: (url: string) => Promise<void> = (url) => shell.openExternal(url),
): Promise<boolean> {
  if (!needsAccessibilityRequest(capabilities)) return false;
  await openExternal(ACCESSIBILITY_SETTINGS_URL);
  return true;
}
