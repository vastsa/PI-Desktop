/**
 * Which key, if any, acts on the composer's plugin suggestion (ADR 0332).
 *
 * The composer already has owners for both keys and they keep them: a `@` / `/`
 * completion list takes `Tab` (and `Enter`), and its own `Escape` closes it
 * first. Only when neither claims the key, the draft is empty and a suggestion
 * is on screen does `Tab` take it and `Esc` drop it.
 *
 * Pure, so the ordering is tested without a DOM.
 */
export type ComposerSuggestionKeyAction = "accept" | "dismiss";

export type ComposerSuggestionKeyEvent = {
  readonly key: string;
  readonly shiftKey?: boolean;
  readonly altKey?: boolean;
  readonly metaKey?: boolean;
  readonly ctrlKey?: boolean;
};

export type ComposerSuggestionKeyState = {
  /** A suggestion is on screen. */
  readonly suggestion: boolean;
  /** The completion list has items, so `Tab` belongs to it. */
  readonly completionItems: boolean;
  /** A completion list is open, so the first `Escape` closes it. */
  readonly completionOpen: boolean;
};

export function composerSuggestionKeyAction(
  event: ComposerSuggestionKeyEvent,
  state: ComposerSuggestionKeyState,
): ComposerSuggestionKeyAction | null {
  if (!state.suggestion) return null;
  if (state.completionItems) return null;
  const plain = !event.altKey && !event.metaKey && !event.ctrlKey;
  if (event.key === "Escape") {
    // The list closes on the first Escape; the suggestion is the second one.
    if (state.completionOpen) return null;
    return plain ? "dismiss" : null;
  }
  if (event.key !== "Tab" || !plain) return null;
  return event.shiftKey ? null : "accept";
}
