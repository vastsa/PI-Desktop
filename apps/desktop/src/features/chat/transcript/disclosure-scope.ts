import { createContext } from "react";

/**
 * The scope one disclosure level presents to the levels it reveals.
 *
 * Kept in its own module so a level that *provides* a scope (the turn's process
 * disclosure) and the module that *consumes* it (`useAutomaticDisclosure`) do
 * not import each other. `disclosure.tsx` owns the consumer side and re-exports
 * the type.
 */
export type DisclosureScopeValue = {
  /**
   * Hold this level and its ancestors open while a reader is using the content.
   * The hold is transient and never becomes a disclosure choice.
   */
  claim: () => void;
  /** Reveal this level and its ancestors, and keep the revealed path open. */
  reveal: () => void;
  /** Whether this level's contents are currently shown at all. */
  visible: boolean;
};

/** The implicit root scope: nothing above the transcript owns it. */
export const ScopeContext = createContext<DisclosureScopeValue>({
  claim: () => {},
  reveal: () => {},
  visible: true,
});
