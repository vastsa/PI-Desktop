import { createContext, useContext } from "react";

/**
 * Hands the title element of a disclosure to the scroll container that owns it
 * (#324). A manual disclosure calls this synchronously, before its expansion
 * state changes; an automatic completion fold calls it with `"automatic"`, so
 * a scroller can keep a reader who scrolled away on that header without
 * stopping a reader who is still following the tail.
 *
 * Every scroll owner provides its own notifier — the transcript scroller and
 * each nested follow scroller (D302) — so the innermost owner wins: a row inside
 * a delegate's dock hands its reading position to that dock, not to the
 * transcript behind it, and a row inside the transcript hands it to the
 * transcript. Without a provider (a row rendered outside any scroller) the
 * notification is simply a no-op.
 */
export type DisclosureAnchorNotifier = (
  title: HTMLElement | null,
  reason?: "manual" | "automatic",
) => void;

export const DisclosureAnchorContext =
  createContext<DisclosureAnchorNotifier | null>(null);

export function useDisclosureAnchorNotifier(): DisclosureAnchorNotifier | null {
  return useContext(DisclosureAnchorContext);
}
