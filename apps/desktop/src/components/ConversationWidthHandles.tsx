import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useTranslation } from "react-i18next";
import {
  DEFAULT_CHAT_CONTENT_MAX_WIDTH,
  MIN_CHAT_CONTENT_MAX_WIDTH,
  chatContentWidthFromDrag,
  clampChatContentMaxWidth,
  resolveChatContentMaxWidth,
  type ChatContentResizeSide,
} from "@pi-desktop/shared";
import { api } from "../lib/api";
import { useAppStore } from "../stores/app-store";
import { cx } from "./ui";

type DragState = {
  pointerId: number;
  side: ChatContentResizeSide;
  startClientX: number;
  startWidth: number;
  paneWidth: number;
  currentWidth: number;
  frame: number;
};

function surfaceOf(host: HTMLDivElement | null): HTMLElement | null {
  return host?.parentElement ?? null;
}

function applyPreferredWidth(surface: HTMLElement | null, width: number) {
  if (!surface) return;
  const px = `${width}px`;
  surface.style.setProperty("--chat-content-max-width", px);
  surface.style.setProperty("--chat-composer-max-width", px);
  // The per-message prose width must track the band, otherwise the message
  // rows stay frozen at the `.main-pane` default (760px) while the band it
  // sits in widens (the bug this fixes: content no longer scales with it).
  surface.style.setProperty("--chat-prose-max-width", px);

}

function setResizing(surface: HTMLElement | null, on: boolean) {
  if (!surface) return;
  if (on) {
    surface.dataset.chatResizing = "true";
    document.documentElement.dataset.chatResizing = "true";
  } else {
    delete surface.dataset.chatResizing;
    delete document.documentElement.dataset.chatResizing;
  }
}

/**
 * Dual edge handles for the centered conversation band (D439). Both sides
 * change one preferred max-width; the live band is `min(100%, preferred)`.
 */
export function ConversationWidthHandles() {
  const { t } = useTranslation();
  const hostRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const persisted = useAppStore((state) =>
    resolveChatContentMaxWidth(state.settings?.chatContentMaxWidth),
  );
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const [paneWidth, setPaneWidth] = useState(0);
  const width = dragWidth ?? persisted;

  useLayoutEffect(() => {
    applyPreferredWidth(surfaceOf(hostRef.current), width);
  }, [width]);

  useEffect(() => {
    const surface = surfaceOf(hostRef.current);
    if (!surface) return;
    const sync = () => setPaneWidth(surface.clientWidth);
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(surface);
    return () => observer.disconnect();
  }, []);

  useEffect(
    () => () => {
      const drag = dragRef.current;
      if (drag?.frame) cancelAnimationFrame(drag.frame);
      dragRef.current = null;
      setResizing(surfaceOf(hostRef.current), false);
    },
    [],
  );

  const persistWidth = useCallback(async (next: number) => {
    const settings = useAppStore.getState().settings;
    if (!settings) return;
    if (settings.chatContentMaxWidth === next) return;
    const payload = { ...settings, chatContentMaxWidth: next };
    try {
      await api.setSettings(payload);
      useAppStore.setState({ settings: payload });
    } catch {
      /* keep the live band; the next drag can retry */
    }
  }, []);

  const finishDrag = useCallback(
    (target: HTMLDivElement, pointerId: number, cancelled: boolean) => {
      const drag = dragRef.current;
      if (drag?.pointerId !== pointerId) return;
      if (drag.frame) cancelAnimationFrame(drag.frame);
      dragRef.current = null;
      if (target.hasPointerCapture(pointerId)) {
        target.releasePointerCapture(pointerId);
      }
      setResizing(surfaceOf(hostRef.current), false);
      const committed = cancelled ? drag.startWidth : drag.currentWidth;
      setDragWidth(null);
      applyPreferredWidth(surfaceOf(hostRef.current), committed);
      if (!cancelled) void persistWidth(committed);
    },
    [persistWidth],
  );

  const onPointerDown = useCallback(
    (side: ChatContentResizeSide) =>
      (event: ReactPointerEvent<HTMLDivElement>) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.focus({ preventScroll: true });
        const surface = surfaceOf(hostRef.current);
        const livePane = surface?.clientWidth ?? paneWidth;
        const startWidth = clampChatContentMaxWidth(width, livePane);
        dragRef.current = {
          pointerId: event.pointerId,
          side,
          startClientX: event.clientX,
          startWidth,
          paneWidth: livePane,
          currentWidth: startWidth,
          frame: 0,
        };
        setDragWidth(startWidth);
        setResizing(surface, true);
        event.currentTarget.setPointerCapture(event.pointerId);
      },
    [paneWidth, width],
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (drag?.pointerId !== event.pointerId) return;
      drag.currentWidth = chatContentWidthFromDrag({
        side: drag.side,
        startWidth: drag.startWidth,
        startClientX: drag.startClientX,
        clientX: event.clientX,
        paneWidth: drag.paneWidth,
      });
      if (drag.frame) return;
      drag.frame = requestAnimationFrame(() => {
        if (dragRef.current !== drag) return;
        drag.frame = 0;
        setDragWidth(drag.currentWidth);
      });
    },
    [],
  );

  const onPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      finishDrag(event.currentTarget, event.pointerId, false);
    },
    [finishDrag],
  );

  const onPointerCancel = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      finishDrag(event.currentTarget, event.pointerId, true);
    },
    [finishDrag],
  );

  const onDoubleClick = useCallback(() => {
    setDragWidth(null);
    applyPreferredWidth(surfaceOf(hostRef.current), DEFAULT_CHAT_CONTENT_MAX_WIDTH);
    void persistWidth(DEFAULT_CHAT_CONTENT_MAX_WIDTH);
  }, [persistWidth]);

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (event.key === "Escape" && drag) {
        event.preventDefault();
        finishDrag(event.currentTarget, drag.pointerId, true);
        return;
      }
      const livePane = surfaceOf(hostRef.current)?.clientWidth ?? paneWidth;
      const step = event.shiftKey ? 32 : 16;
      let next: number | null = null;
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        const towardWider =
          (event.currentTarget.dataset.side === "left" && event.key === "ArrowLeft") ||
          (event.currentTarget.dataset.side === "right" && event.key === "ArrowRight");
        next = width + (towardWider ? step : -step);
      } else if (event.key === "Home") {
        next = DEFAULT_CHAT_CONTENT_MAX_WIDTH;
      } else if (event.key === "End") {
        next = Number.POSITIVE_INFINITY;
      }
      if (next === null) return;
      event.preventDefault();
      const clamped = clampChatContentMaxWidth(next, livePane);
      applyPreferredWidth(surfaceOf(hostRef.current), clamped);
      void persistWidth(clamped);
    },
    [finishDrag, paneWidth, persistWidth, width],
  );

  const max = clampChatContentMaxWidth(Number.POSITIVE_INFINITY, paneWidth || 10_000);
  const label = t("nav.resizeChatWidth");
  const valueText = t("nav.chatWidth", { width });
  const resizing = dragWidth !== null;

  return (
    <div ref={hostRef} className="chat-width-handles">
      {(["left", "right"] as const).map((side) => (
        <div
          key={side}
          role="separator"
          aria-orientation="vertical"
          aria-label={label}
          aria-valuemin={MIN_CHAT_CONTENT_MAX_WIDTH}
          aria-valuemax={max}
          aria-valuenow={width}
          aria-valuetext={valueText}
          data-side={side}
          data-testid={`chat-width-handle-${side}`}
          tabIndex={0}
          className={cx(
            "chat-width-handle",
            `chat-width-handle-${side}`,
            "no-drag",
            resizing && "is-resizing",
          )}
          onPointerDown={onPointerDown(side)}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          onDoubleClick={onDoubleClick}
          onKeyDown={onKeyDown}
        />
      ))}
    </div>
  );
}
