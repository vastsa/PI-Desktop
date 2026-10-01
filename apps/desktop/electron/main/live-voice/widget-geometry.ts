/**
 * Geometry for the docked Live Voice widget window.
 *
 * Kept apart from the window module so the placement arithmetic can be proven
 * without Electron. The window itself is frameless, transparent, always on top
 * and dragged through its own app-region handle, so the only geometry left to
 * decide is where a saved placement and the widget's own reported box may land:
 * a placement saved on a wider display, or by a hand-edited preference file,
 * must never strand the call controls off-screen.
 */

/** Smallest gap the widget keeps to any edge of the work area. */
export const LIVE_VOICE_WIDGET_MARGIN = 8;
/** Default content box before the widget has reported its own measured size. */
export const LIVE_VOICE_WIDGET_SIZE = { width: 420, height: 64 };
export const LIVE_VOICE_WIDGET_MIN_WIDTH = 220;
export const LIVE_VOICE_WIDGET_MAX_WIDTH = 680;
export const LIVE_VOICE_WIDGET_MIN_HEIGHT = 40;
export const LIVE_VOICE_WIDGET_MAX_HEIGHT = 260;

export type LiveVoiceWidgetPosition = { x: number; y: number };
export type LiveVoiceWidgetSize = { width: number; height: number };
/** A display's usable box; Electron reports this shape as `Rectangle`. */
export type LiveVoiceWidgetWorkArea = { x: number; y: number; width: number; height: number };

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Parse a stored position, treating anything malformed as "never dragged". */
export function parseLiveVoiceWidgetPosition(raw: string | null): LiveVoiceWidgetPosition | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    const x = finite(record.x);
    const y = finite(record.y);
    if (x === null || y === null) return null;
    return { x: Math.round(x), y: Math.round(y) };
  } catch {
    return null;
  }
}

/** Keep a whole window inside the work area, never off its edges. */
export function clampLiveVoiceWidgetPosition(
  position: LiveVoiceWidgetPosition,
  size: LiveVoiceWidgetSize,
  workArea: LiveVoiceWidgetWorkArea,
  margin = LIVE_VOICE_WIDGET_MARGIN,
): LiveVoiceWidgetPosition {
  const left = workArea.x + margin;
  const top = workArea.y + margin;
  // A widget wider or taller than the work area pins to the leading edge instead
  // of computing a maximum past it.
  const maximumX = Math.max(left, workArea.x + workArea.width - size.width - margin);
  const maximumY = Math.max(top, workArea.y + workArea.height - size.height - margin);
  return {
    x: Math.round(Math.min(Math.max(position.x, left), maximumX)),
    y: Math.round(Math.min(Math.max(position.y, top), maximumY)),
  };
}

/** A measured content box from the widget, bounded to what the bar can need. */
export function clampLiveVoiceWidgetSize(size: LiveVoiceWidgetSize): LiveVoiceWidgetSize {
  const width = finite(size.width) ?? LIVE_VOICE_WIDGET_SIZE.width;
  const height = finite(size.height) ?? LIVE_VOICE_WIDGET_SIZE.height;
  return {
    width: Math.round(Math.min(Math.max(width, LIVE_VOICE_WIDGET_MIN_WIDTH), LIVE_VOICE_WIDGET_MAX_WIDTH)),
    height: Math.round(Math.min(Math.max(height, LIVE_VOICE_WIDGET_MIN_HEIGHT), LIVE_VOICE_WIDGET_MAX_HEIGHT)),
  };
}
