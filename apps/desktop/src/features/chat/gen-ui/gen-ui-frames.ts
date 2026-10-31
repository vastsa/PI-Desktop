/**
 * Pure frame-side rules for inline visualizations: which guest messages the
 * host trusts, how reported heights are bounded, and how many guest frames may
 * be live at once.
 */
import {
  GEN_UI_ERROR_MESSAGE,
  GEN_UI_KEY_MESSAGE,
  GEN_UI_MAX_HEIGHT,
  GEN_UI_MAX_SCRIPT_ERROR_LENGTH,
  GEN_UI_MIN_HEIGHT,
  GEN_UI_READY_MESSAGE,
  GEN_UI_SCRIPT_ERROR_MESSAGE,
  GEN_UI_SIZE_MESSAGE,
  GEN_UI_WHEEL_MESSAGE,
  isGenUiErrorCode,
  type GenUiErrorCode,
} from "@pi-desktop/shared";

type FrameMessageEvent = { source: unknown; data: unknown };

/**
 * The payload of a message from `frameWindow` with the given `type`, or null.
 * Any guest can post to the host window, so the source check is what binds a
 * message to its own card.
 */
function ownFrameMessage(
  event: FrameMessageEvent,
  frameWindow: unknown,
  type: string,
): Record<string, unknown> | null {
  if (!frameWindow || event.source !== frameWindow) return null;
  const data = event.data;
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  return record.type === type ? record : null;
}

/** Clamp a guest-reported height into the inline card's bounds. */
export function clampGenUiHeight(height: number): number {
  return Math.min(GEN_UI_MAX_HEIGHT, Math.max(GEN_UI_MIN_HEIGHT, Math.ceil(height)));
}

/**
 * The bounded height from a `message` event, or `null` when the event did not
 * come from `frameWindow` or is not a well-formed size report. Any guest can
 * post to the host window, so the source check is what binds a report to its
 * own card.
 */
export function genUiHeightFromMessage(event: FrameMessageEvent, frameWindow: unknown): number | null {
  const record = ownFrameMessage(event, frameWindow, GEN_UI_SIZE_MESSAGE);
  if (!record) return null;
  const height = record.height;
  if (typeof height !== "number" || !Number.isFinite(height)) return null;
  return clampGenUiHeight(height);
}

export type GenUiWheel = { deltaX: number; deltaY: number; deltaMode: number };

const MAX_WHEEL_DELTA = 10_000;

const boundedDelta = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.max(-MAX_WHEEL_DELTA, Math.min(MAX_WHEEL_DELTA, value))
    : null;

/**
 * A wheel report from this card's own frame, or null. The values only feed a
 * synthetic event that never scrolls anything, but stay shape-checked and
 * bounded because the guest is untrusted.
 */
export function genUiWheelFromMessage(event: FrameMessageEvent, frameWindow: unknown): GenUiWheel | null {
  const record = ownFrameMessage(event, frameWindow, GEN_UI_WHEEL_MESSAGE);
  if (!record) return null;
  const deltaX = boundedDelta(record.deltaX);
  const deltaY = boundedDelta(record.deltaY);
  const deltaMode = record.deltaMode;
  if (deltaX === null || deltaY === null) return null;
  if (deltaMode !== 0 && deltaMode !== 1 && deltaMode !== 2) return null;
  return { deltaX, deltaY, deltaMode };
}

/** The error code from this card's own frame's error shell, or null. */
export function genUiErrorFromMessage(event: FrameMessageEvent, frameWindow: unknown): GenUiErrorCode | null {
  const record = ownFrameMessage(event, frameWindow, GEN_UI_ERROR_MESSAGE);
  return record && isGenUiErrorCode(record.code) ? record.code : null;
}

/**
 * A fragment script failure from this card's own frame, or null. The text is
 * guest-controlled: it is whitespace-collapsed and bounded here and must only
 * ever be rendered as plain text. An empty message is still a failure.
 */
export function genUiScriptErrorFromMessage(event: FrameMessageEvent, frameWindow: unknown): string | null {
  const record = ownFrameMessage(event, frameWindow, GEN_UI_SCRIPT_ERROR_MESSAGE);
  if (!record) return null;
  const message = typeof record.message === "string" ? record.message : "";
  return message.replace(/\s+/g, " ").trim().slice(0, GEN_UI_MAX_SCRIPT_ERROR_LENGTH);
}

/** A forwarded key from this card's own frame; only `Escape` is accepted. */
export function genUiKeyFromMessage(event: FrameMessageEvent, frameWindow: unknown): "Escape" | null {
  const record = ownFrameMessage(event, frameWindow, GEN_UI_KEY_MESSAGE);
  return record?.key === "Escape" ? "Escape" : null;
}

/** Whether this card's own frame announced that its runtime is running. */
export function isGenUiReadyMessage(event: FrameMessageEvent, frameWindow: unknown): boolean {
  return ownFrameMessage(event, frameWindow, GEN_UI_READY_MESSAGE) !== null;
}

/** Upper bound on simultaneously mounted guest frames across all panes. */
export const GEN_UI_MAX_LIVE_FRAMES = 8;

type LiveFrame = { onEvict: () => void; visible: boolean; inlineSlot?: symbol };

/**
 * Bounded set of live frames. Cards hold a slot only while near the viewport
 * and release it when they scroll away, so the pool overflows only when many
 * cards are near at once (tall windows, split panes). Acquiring beyond the
 * limit evicts an off-screen inline frame first, then the oldest inline frame.
 * Expanded frames share the quota and protect their source inline state while
 * open. An off-screen newcomer never displaces a visible frame.
 */
export function createGenUiFramePool(limit = GEN_UI_MAX_LIVE_FRAMES) {
  const live = new Map<symbol, LiveFrame>();
  const victim = (newcomer: symbol): symbol => {
    const protectedSlots = new Set([...live.values()].flatMap((frame) => frame.inlineSlot ? [frame.inlineSlot] : []));
    const inline = [...live].filter(([id, frame]) => !frame.inlineSlot && !protectedSlots.has(id));
    for (const [id, frame] of inline) if (!frame.visible) return id;
    for (const [id] of inline) if (id !== newcomer) return id;
    if (inline.some(([id]) => id === newcomer)) return newcomer;
    // Multiple panes may hold expanded views; the global bound still wins.
    for (const [id, frame] of live) if (frame.inlineSlot && id !== newcomer) return id;
    return newcomer;
  };
  const acquire = (id: symbol, frame: LiveFrame): void => {
    live.delete(id);
    live.set(id, frame);
    while (live.size > limit) {
      const evicted = victim(id);
      const entry = live.get(evicted);
      live.delete(evicted);
      entry?.onEvict();
    }
  };
  return {
    acquire(id: symbol, onEvict: () => void, visible = true): void {
      acquire(id, { onEvict, visible });
    },
    acquireExpanded(id: symbol, inlineSlot: symbol, onEvict: () => void): void {
      acquire(id, { onEvict, visible: true, inlineSlot });
    },
    setVisible(id: symbol, visible: boolean): void {
      const frame = live.get(id);
      if (frame) frame.visible = visible;
    },
    release(id: symbol): void {
      live.delete(id);
    },
    get size(): number {
      return live.size;
    },
  };
}

export const genUiFramePool = createGenUiFramePool();
