import { useEffect, useRef, useState } from "react";
import {
  GEN_UI_INITIAL_HEIGHT,
  GEN_UI_THEME_MESSAGE,
  GEN_UI_VIEW_MESSAGE,
  type GenUiErrorCode,
} from "@pi-desktop/shared";
import {
  genUiErrorFromMessage,
  genUiHeightFromMessage,
  genUiKeyFromMessage,
  genUiScriptErrorFromMessage,
  genUiWheelFromMessage,
  isGenUiReadyMessage,
} from "./gen-ui-frames";
import { currentGenUiTheme, subscribeGenUiTheme, type GenUiThemePayload } from "./gen-ui-theme";

/**
 * One sandboxed guest frame. The guest has an opaque origin (no
 * `allow-same-origin`), so it can neither reach the host DOM nor the preload
 * bridge; the only channel is `postMessage`, and only messages from this
 * frame's own window are honored.
 */
export function GenUiFrame({
  url,
  title,
  fill = false,
  initialHeight = GEN_UI_INITIAL_HEIGHT,
  onHeight,
  onError,
  onScriptError,
  onEscape,
}: {
  url: string;
  title: string;
  /** Fill the container (expanded view) instead of following guest height. */
  fill?: boolean;
  /** Height before the guest reports one, e.g. the last height of a reloaded card. */
  initialHeight?: number;
  onHeight?: (height: number) => void;
  /** Main served an error shell for this URL. */
  onError?: (code: GenUiErrorCode) => void;
  /** A fragment script threw; the bounded, plain-text message. */
  onScriptError?: (message: string) => void;
  /** Escape was pressed inside the guest. */
  onEscape?: () => void;
}) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [height, setHeight] = useState(initialHeight);
  const callbacks = useRef({ onHeight, onError, onScriptError, onEscape });
  useEffect(() => {
    callbacks.current = { onHeight, onError, onScriptError, onEscape };
  });

  useEffect(() => {
    const post = (message: unknown) => {
      // The guest origin is opaque, so "*" is the only target that reaches
      // it; theme variables and the view mode carry no secrets.
      frameRef.current?.contentWindow?.postMessage(message, "*");
    };
    const postTheme = (theme: GenUiThemePayload) => post({ type: GEN_UI_THEME_MESSAGE, ...theme });
    // Sent when the guest runtime announces itself (before first paint) and
    // again on `load` in case the announcement raced the listener.
    const postSetup = () => {
      post({ type: GEN_UI_VIEW_MESSAGE, view: fill ? "expanded" : "inline" });
      postTheme(currentGenUiTheme());
    };
    const onMessage = (event: MessageEvent) => {
      const frameWindow = frameRef.current?.contentWindow;
      const next = genUiHeightFromMessage(event, frameWindow);
      if (next !== null) {
        setHeight(next);
        callbacks.current.onHeight?.(next);
        return;
      }
      // Wheel input inside the out-of-process guest never reaches this
      // document, so a scroll chaining out of the card looks programmatic to
      // the transcript and follow mode pulls the reader back. Replay it on the
      // frame element: an untrusted event scrolls nothing, it only lets
      // gesture listeners attribute the scroll that the browser already does.
      const wheel = genUiWheelFromMessage(event, frameWindow);
      if (wheel !== null) {
        frameRef.current?.dispatchEvent(new WheelEvent("wheel", { ...wheel, bubbles: true }));
        return;
      }
      if (isGenUiReadyMessage(event, frameWindow)) {
        postSetup();
        return;
      }
      const error = genUiErrorFromMessage(event, frameWindow);
      if (error !== null) {
        callbacks.current.onError?.(error);
        return;
      }
      const scriptError = genUiScriptErrorFromMessage(event, frameWindow);
      if (scriptError !== null) {
        callbacks.current.onScriptError?.(scriptError);
        return;
      }
      if (genUiKeyFromMessage(event, frameWindow) === "Escape") callbacks.current.onEscape?.();
    };
    window.addEventListener("message", onMessage);
    const frame = frameRef.current;
    frame?.addEventListener("load", postSetup);
    const unsubscribe = subscribeGenUiTheme(postTheme);
    return () => {
      window.removeEventListener("message", onMessage);
      frame?.removeEventListener("load", postSetup);
      unsubscribe();
    };
  }, [fill]);

  return (
    <iframe
      ref={frameRef}
      className="gen-ui-frame"
      src={url}
      title={title}
      sandbox="allow-scripts"
      loading="lazy"
      referrerPolicy="no-referrer"
      style={fill ? undefined : { height }}
    />
  );
}
