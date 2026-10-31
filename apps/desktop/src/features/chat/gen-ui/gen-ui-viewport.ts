/**
 * Viewport lifecycle of one inline visualization card: whether its frame is
 * mounted. A card mounts when it nears the viewport and unmounts (releasing
 * its live-frame slot) when it moves away, so slots follow what the reader
 * can reach instead of the order cards were first seen.
 */
import { useEffect, useReducer, type RefObject } from "react";

export type GenUiViewportState = {
  /** Within the preload margin of the viewport. */
  near: boolean;
  /** Actually intersecting the viewport. */
  visible: boolean;
  /** The live-frame pool took this card's slot while it was near. */
  evicted: boolean;
};

export type GenUiViewportEvent =
  | { type: "near"; value: boolean }
  | { type: "visible"; value: boolean }
  | { type: "evict" }
  | { type: "load" };

export const GEN_UI_VIEWPORT_INITIAL: GenUiViewportState = { near: false, visible: false, evicted: false };

/**
 * Leaving the near zone clears an eviction, so re-entry reloads without a
 * click. Scrolling an evicted card into view retries once per entry; while it
 * stays visible it waits for the reader, which keeps two evicting cards from
 * trading the same slot back and forth.
 */
export function genUiViewportReducer(state: GenUiViewportState, event: GenUiViewportEvent): GenUiViewportState {
  switch (event.type) {
    case "near":
      if (!event.value) return { near: false, visible: false, evicted: false };
      return state.near ? state : { ...state, near: true };
    case "visible":
      if (event.value === state.visible) return state;
      return event.value ? { ...state, visible: true, evicted: false } : { ...state, visible: false };
    case "evict":
      return state.evicted ? state : { ...state, evicted: true };
    case "load":
      return state.evicted ? { ...state, evicted: false } : state;
  }
}

export function isGenUiViewportLive(state: GenUiViewportState): boolean {
  return state.near && !state.evicted;
}

/** Preload margin: frames mount a little before they scroll into view. */
const NEAR_MARGIN = "240px 0px";

/** Track `ref` against the viewport; always live without IntersectionObserver. */
export function useGenUiViewport(ref: RefObject<HTMLElement | null>) {
  const [state, dispatch] = useReducer(genUiViewportReducer, GEN_UI_VIEWPORT_INITIAL);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof IntersectionObserver === "undefined") {
      dispatch({ type: "near", value: true });
      dispatch({ type: "visible", value: true });
      return;
    }
    const watch = (type: "near" | "visible", rootMargin: string) => {
      const observer = new IntersectionObserver(
        (entries) => {
          const entry = entries.at(-1);
          if (entry) dispatch({ type, value: entry.isIntersecting });
        },
        { rootMargin },
      );
      observer.observe(element);
      return observer;
    };
    const near = watch("near", NEAR_MARGIN);
    const visible = watch("visible", "0px");
    return () => {
      near.disconnect();
      visible.disconnect();
    };
  }, [ref]);
  return [state, dispatch] as const;
}
