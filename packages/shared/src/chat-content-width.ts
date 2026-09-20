/**
 * Centered chat content band width (D439).
 *
 * The transcript, empty-home stack, and composer share one preferred max
 * width. The live used width is `min(available pane, preferred)` so a
 * squeezed sidebar or work panel compresses the band without rewriting the
 * preference.
 */
export const DEFAULT_CHAT_CONTENT_MAX_WIDTH = 760;
export const MIN_CHAT_CONTENT_MAX_WIDTH = 560;
/** Gutter kept on each side of the pane so handles and the minimap stay usable. */
export const CHAT_CONTENT_WIDTH_GUTTER = 24;

export type ChatContentResizeSide = "left" | "right";

/**
 * Persistable preference. Absent / invalid → default 760. Numbers below the
 * drag floor snap up; the live pane may still draw narrower than this.
 */
export function resolveChatContentMaxWidth(value: unknown): number {
  const normalized = normalizeChatContentMaxWidth(value);
  return normalized ?? DEFAULT_CHAT_CONTENT_MAX_WIDTH;
}

export function normalizeChatContentMaxWidth(
  value: unknown,
): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(MIN_CHAT_CONTENT_MAX_WIDTH, Math.round(value));
}

/** Clamp a drag/keyboard candidate against the live pane. */
export function clampChatContentMaxWidth(
  width: number,
  paneWidth: number,
): number {
  const available = Math.max(
    0,
    Math.round(paneWidth) - 2 * CHAT_CONTENT_WIDTH_GUTTER,
  );
  if (available <= 0) return MIN_CHAT_CONTENT_MAX_WIDTH;
  const floor = Math.min(MIN_CHAT_CONTENT_MAX_WIDTH, available);
  return Math.min(available, Math.max(floor, Math.round(width)));
}

/** Both handles move the same centered band: 1px pointer → 2px width. */
export function chatContentWidthFromDrag(args: {
  side: ChatContentResizeSide;
  startWidth: number;
  startClientX: number;
  clientX: number;
  paneWidth: number;
}): number {
  const delta = args.clientX - args.startClientX;
  const next =
    args.side === "left"
      ? args.startWidth - 2 * delta
      : args.startWidth + 2 * delta;
  return clampChatContentMaxWidth(next, args.paneWidth);
}
