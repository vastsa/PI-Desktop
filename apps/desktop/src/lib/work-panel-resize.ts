// Narrower dock: the default opens a third slimmer than the original 420px, and
// the floor scales with it so that default stays reachable.
export const WORK_PANEL_MIN_WIDTH = 244;
export const WORK_PANEL_DEFAULT_WIDTH = 280;
export const WORK_PANEL_MAX_WIDTH = 720;
export const WORK_PANEL_CHAT_MIN_WIDTH = 1040;
export const WORK_PANEL_CHAT_MAX_WIDTH = 10000;
export const MAIN_PANE_MIN_WIDTH = 360;

export type WorkPanelChatResizeGesture = {
  startClientX: number;
  startWidth: number;
};

export function workPanelWidthLimits() {
  return {
    min: WORK_PANEL_MIN_WIDTH,
    max: WORK_PANEL_MAX_WIDTH,
  };
}

export function clampWorkPanelWidth(width: number) {
  const limits = workPanelWidthLimits();
  return Math.max(limits.min, Math.min(limits.max, width));
}

export function clampWorkPanelChatWidth(width: number) {
  return Math.max(
    WORK_PANEL_CHAT_MIN_WIDTH,
    Math.min(WORK_PANEL_CHAT_MAX_WIDTH, Math.round(width)),
  );
}

export function workPanelChatWidthFromPointer(
  gesture: WorkPanelChatResizeGesture,
  clientX: number,
) {
  return clampWorkPanelChatWidth(
    gesture.startWidth + clientX - gesture.startClientX,
  );
}

export function parseWorkPanelChatWidth(input: unknown): number | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return null;
  }
  const width = (input as { width?: unknown }).width;
  if (
    typeof width !== "number" ||
    !Number.isSafeInteger(width) ||
    width < WORK_PANEL_CHAT_MIN_WIDTH ||
    width > WORK_PANEL_CHAT_MAX_WIDTH
  ) {
    return null;
  }
  return width;
}

export function committedWorkPanelChatWidth(
  gesture: WorkPanelChatResizeGesture,
  previewWidth: number,
  commit: boolean,
) {
  if (!commit || previewWidth === gesture.startWidth) return null;
  return previewWidth;
}
