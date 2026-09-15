import { useCallback, useRef, type RefObject } from "react";
import {
  adoptDisclosureAnchor,
  resolveDisclosureAnchor,
  type DisclosureAnchor,
  type DisclosureAnchorFrame,
} from "../lib/disclosure-anchor";
import {
  useDisclosureAnchorNotifier,
  type DisclosureAnchorNotifier,
} from "../lib/disclosure-anchor-context";

type HeldTitle = DisclosureAnchor & { element: HTMLElement };

export type DisclosureAnchorControl = {
  /**
   * Context value for the rows this scroller renders. Called synchronously by a
   * manual disclosure, before its state changes, so the title is measured while
   * the layout still matches what the user clicked.
   */
  notifier: DisclosureAnchorNotifier;
  /**
   * Puts the held title back where it was; run from the scroller's own
   * `ResizeObserver`, so it covers every frame of a height transition. Returns
   * `true` while a title is held, which is also the signal to skip follow
   * scrolling for this frame.
   */
  restore: () => boolean;
  /** Whether a title is held, for callers that queue follow work. */
  isHeld: () => boolean;
  /** Drops the hold: real input, a follow re-pin, or a departing pane. */
  release: () => void;
};

/**
 * Reading position held across one manual disclosure (#324).
 *
 * Shared by the transcript scroller and every nested follow scroller (D302) so
 * both answer the same way: the title keeps its viewport offset for as long as
 * the content around it keeps changing height, and the scroller stops
 * re-bottoming until the reader takes the viewport back.
 */
export function useDisclosureAnchor(
  scrollRef: RefObject<HTMLDivElement | null>,
  /** Called once when a hold begins, to leave follow mode. */
  onHold: () => void,
  /** Records the scroll position a correction reached, as own scroll work. */
  onPosition: (scrollTop: number) => void,
): DisclosureAnchorControl {
  const heldRef = useRef<HeldTitle | null>(null);
  const onHoldRef = useRef(onHold);
  const onPositionRef = useRef(onPosition);
  onHoldRef.current = onHold;
  onPositionRef.current = onPosition;
  // A scroller nested in another one (the transcript's delegate dock, D302)
  // passes its hold outward as well: growing the inner scroller grows the outer
  // content, so an outer scroller still in follow mode would re-bottom and drag
  // the same title away. Reading the ambient notifier here — at this
  // component's own position in the tree — never sees this owner's own value.
  const outerNotifier = useDisclosureAnchorNotifier();

  const measure = useCallback(
    (element: HTMLElement): DisclosureAnchorFrame | null => {
      const scroller = scrollRef.current;
      if (!scroller || !scroller.isConnected || !element.isConnected) {
        return null;
      }
      return {
        elementOffset:
          element.getBoundingClientRect().top -
          scroller.getBoundingClientRect().top,
        scrollTop: scroller.scrollTop,
        scrollHeight: scroller.scrollHeight,
        clientHeight: scroller.clientHeight,
      };
    },
    [scrollRef],
  );

  const notifier = useCallback<DisclosureAnchorNotifier>(
    (title) => {
      if (!title) return;
      const frame = measure(title);
      if (!frame) return;
      heldRef.current = { element: title, offset: frame.elementOffset };
      onHoldRef.current();
      outerNotifier?.(title);
    },
    [measure, outerNotifier],
  );

  const release = useCallback(() => {
    heldRef.current = null;
  }, []);

  const isHeld = useCallback(() => heldRef.current !== null, []);

  const restore = useCallback(() => {
    const held = heldRef.current;
    if (!held) return false;
    const scroller = scrollRef.current;
    const before = measure(held.element);
    if (!scroller || !before) {
      // The title or the scroller is gone: there is nothing left to hold.
      heldRef.current = null;
      return false;
    }
    const target = resolveDisclosureAnchor(held, before);
    if (target !== null) {
      scroller.scrollTop = target;
      // Record what the scroller actually reached, exactly as follow scrolling
      // does, so its own native scroll event is not read as a user gesture.
      onPositionRef.current(scroller.scrollTop);
    }
    // Adopt the position the title actually reached: a boundary clamp is the
    // browser's answer, not an error to correct again on the next frame.
    const after = measure(held.element);
    if (after) {
      heldRef.current = {
        element: held.element,
        ...adoptDisclosureAnchor(after),
      };
    }
    return true;
  }, [measure, scrollRef]);

  return { notifier, restore, release, isHeld };
}
