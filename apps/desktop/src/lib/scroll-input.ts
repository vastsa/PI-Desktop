import {
  consumesVerticalScroll,
  SCROLL_OWNER_ATTRIBUTE,
  type ScrollInputContext,
} from "./transcript-scroll";

/** Elements that own a press: clicking one is an ordinary click. */
const CONTROL_SELECTOR = [
  "button",
  "a",
  "input",
  "textarea",
  "select",
  "summary",
  "[contenteditable='true']",
  "[role='button']",
  "[role='link']",
  "[role='tab']",
  "[role='menuitem']",
  "[role='checkbox']",
  "[role='switch']",
  "[role='radio']",
].join(", ");

const EDITABLE_SELECTOR = "input, textarea, [contenteditable='true']";

/**
 * Reads what one DOM input event means for `owner`, a marked scroll container
 * (D302 nested scrollers included).
 *
 * Input is attributed to the nearest scroll container that can consume it, so a
 * wheel inside a delegate's dock never counts as the reader scrolling the
 * transcript behind it, and a press on a row control never counts as the start
 * of a scroll at all.
 */
export function readScrollInputContext(
  event: Event,
  owner: Element | null,
  content: Element | null,
): ScrollInputContext {
  const target = event.target;
  const nearestOwner =
    target instanceof Element
      ? target.closest(`[${SCROLL_OWNER_ATTRIBUTE}]`)
      : null;
  const context: ScrollInputContext = {
    nestedOwner:
      nearestOwner !== null &&
      nearestOwner !== owner &&
      consumesVerticalScroll(nearestOwner),
  };
  if (event instanceof KeyboardEvent) {
    context.key = event.key;
    context.editable =
      target instanceof Element &&
      target.closest(EDITABLE_SELECTOR) !== null;
    return context;
  }
  if (event.type === "pointerdown") {
    const inside =
      owner !== null &&
      (target === owner || target === content || owner.contains(target as Node));
    context.pointerOnScrollSurface =
      inside &&
      !(target instanceof Element && target.closest(CONTROL_SELECTOR) !== null);
  }
  return context;
}
