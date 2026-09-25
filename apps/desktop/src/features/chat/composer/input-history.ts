import type { ComposerHistoryEntry } from "../../../lib/composer-input-history";

export type HistoryDirection = "older" | "newer";

/**
 * Move the browse cursor. `null` means "not browsing" (the empty draft the
 * user started from); index 0 is the newest entry.
 */
export function stepHistoryIndex(
  index: number | null,
  direction: HistoryDirection,
  length: number,
): number | null {
  if (length <= 0) return null;
  if (direction === "older") return index === null ? 0 : Math.min(index + 1, length - 1);
  if (index === null || index <= 0) return null;
  return index - 1;
}

export type HistoryNavigationPlan =
  /** Not ours: leave the key to the editor's native caret movement. */
  | { action: "ignore" }
  /** Ours, but the boundary entry is already on screen. */
  | { action: "keep" }
  /** Show the entry at `index` (0 is the newest). */
  | { action: "load"; index: number }
  /** Leave browsing and empty the draft. */
  | { action: "exit" };

/**
 * Decide what one ArrowUp/ArrowDown does.
 *
 * `index` is the entry on screen, or `null` when not browsing — the caller
 * passes `null` for a draft the user edited, because browsing never survives an
 * edit. `draftEmpty` means no text and no references for this session, which is
 * the only draft a fresh browse may start from.
 */
export function planHistoryNavigation(input: {
  index: number | null;
  direction: HistoryDirection;
  length: number;
  draftEmpty: boolean;
}): HistoryNavigationPlan {
  if (input.index === null) {
    if (input.direction === "newer" || !input.draftEmpty || input.length === 0) {
      return { action: "ignore" };
    }
    return { action: "load", index: 0 };
  }
  const next = stepHistoryIndex(input.index, input.direction, input.length);
  if (next === null) return { action: "exit" };
  if (next === input.index) return { action: "keep" };
  return { action: "load", index: next };
}

export type HistoryStepEffects<TReference> = {
  /** Replace the draft: text, its references, and the caret to land on. */
  applyDraft: (text: string, references: readonly TReference[], caret: number) => void;
};

export type HistoryStepResult = {
  /** True when the key belongs to history and must not move the caret. */
  consumed: boolean;
  /** Browse snapshot to keep for the next step ([] when not browsing). */
  entries: readonly ComposerHistoryEntry[];
  /** Entry index on screen, or null when not browsing. */
  index: number | null;
  /** True when an entry was applied, so the caller can record its revision. */
  applied: boolean;
};

/**
 * Run one ArrowUp/ArrowDown against a browse snapshot and apply its effect.
 *
 * Kept free of React and of the draft controller so the whole recall sequence —
 * fresh browse, stepping, boundary, and an edit behind the recalled text — is
 * drivable from a test. Every entry comes from the current conversation, so its
 * references are always restored with it.
 */
export function runHistoryStep<TReference>(options: {
  /** Snapshot of the active browse, empty when not browsing. */
  entries: readonly ComposerHistoryEntry[];
  /** Entry index on screen, or null when not browsing. */
  index: number | null;
  /** References belonging to other conversations that must survive the step. */
  keptReferences: readonly TReference[];
  direction: HistoryDirection;
  draftEmpty: boolean;
  /** The draft changed behind the recalled entry, so browsing is over. */
  edited: boolean;
  loadHistory: () => readonly ComposerHistoryEntry[];
  createReference: (
    reference: ComposerHistoryEntry["fileReferences"][number],
  ) => TReference;
  effects: HistoryStepEffects<TReference>;
}): HistoryStepResult {
  const browsing = options.index !== null && !options.edited;
  const entries = browsing ? options.entries : options.loadHistory();
  const plan = planHistoryNavigation({
    index: browsing ? options.index : null,
    direction: options.direction,
    length: entries.length,
    draftEmpty: options.draftEmpty,
  });
  if (plan.action === "ignore") {
    if (options.edited) {
      return { consumed: false, entries: [], index: null, applied: false };
    }
    return { consumed: false, entries: options.entries, index: options.index, applied: false };
  }
  if (plan.action === "keep") {
    return { consumed: true, entries: options.entries, index: options.index, applied: false };
  }
  if (plan.action === "exit") {
    options.effects.applyDraft("", options.keptReferences, 0);
    return { consumed: true, entries: [], index: null, applied: false };
  }
  const entry = entries[plan.index];
  if (!entry) return { consumed: true, entries: [], index: null, applied: false };
  options.effects.applyDraft(
    entry.text,
    [...options.keptReferences, ...entry.fileReferences.map(options.createReference)],
    entry.text.length,
  );
  return { consumed: true, entries, index: plan.index, applied: true };
}
