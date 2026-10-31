import type { BrowserWindow } from "electron";
import type { WorkPanelTabMenuRequest } from "@pi-desktop/shared";
import { scaleBoundsToDip } from "./plugin-view-bounds";

type WindowCloseEvents = Pick<BrowserWindow, "once" | "removeListener">;

function normalizeMenuLabel(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 1024) return null;
  const label = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return label ? label.slice(0, 256) : null;
}

export function parseWorkPanelTabMenuRequest(value: unknown): WorkPanelTabMenuRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const closeTabLabel = normalizeMenuLabel(input.closeTabLabel);
  const closeOtherTabsLabel = normalizeMenuLabel(input.closeOtherTabsLabel);
  const closeAllTabsLabel = normalizeMenuLabel(input.closeAllTabsLabel);
  if (
    !closeTabLabel ||
    !closeOtherTabsLabel ||
    !closeAllTabsLabel ||
    typeof input.canCloseOthers !== "boolean" ||
    typeof input.x !== "number" ||
    !Number.isFinite(input.x) ||
    input.x < 0 ||
    typeof input.y !== "number" ||
    !Number.isFinite(input.y) ||
    input.y < 0
  ) return null;
  return {
    closeTabLabel,
    closeOtherTabsLabel,
    closeAllTabsLabel,
    canCloseOthers: input.canCloseOthers,
    x: input.x,
    y: input.y,
  };
}

export function clampWorkPanelTabMenuPointToDip(
  point: Pick<WorkPanelTabMenuRequest, "x" | "y">,
  zoomFactor: number,
  contentWidth: number,
  contentHeight: number,
): { x: number; y: number } {
  const scaled = scaleBoundsToDip(
    { x: point.x, y: point.y, width: 0, height: 0 },
    zoomFactor,
  );
  return {
    x: Math.min(scaled.x, Math.max(0, contentWidth - 1)),
    y: Math.min(scaled.y, Math.max(0, contentHeight - 1)),
  };
}

export function waitForNativeMenuResult<T>(
  window: WindowCloseEvents,
  showMenu: (onMenuClosed: () => void) => void,
  getSelection: () => T | null,
): Promise<T | null> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (result: T | null) => {
      if (settled) return;
      settled = true;
      window.removeListener("closed", onWindowClosed);
      resolve(result);
    };
    const onWindowClosed = () => finish(null);
    window.once("closed", onWindowClosed);
    try {
      showMenu(() => finish(getSelection()));
    } catch (error) {
      window.removeListener("closed", onWindowClosed);
      reject(error);
    }
  });
}
