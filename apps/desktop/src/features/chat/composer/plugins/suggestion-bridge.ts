/**
 * The renderer end of `pi.composer.suggest` (ADR 0333).
 *
 * A plugin process offers one line, the shell decides whether the composer can
 * take it, and the user takes it with Tab, drops it with Esc, or drops it by
 * typing. This module owns that decision and the single suggestion slot; the
 * main process owns the two facts the composer cannot know (which session is on
 * screen, which turn is current) and has already refused a stale offer before it
 * reaches here.
 *
 * The suggestion is never a draft value: it lives beside the draft and shows in
 * the placeholder layer, so nothing a plugin offers can be sent without the user
 * accepting it. Every reason the slot can be emptied is handled here:
 *
 * - the draft stops being empty (typing, pasting, a chip, `composer.insertText`,
 *   `composer.replaceDraft`) — the composer publishes each change;
 * - the composer takes input for another session, or stops taking input at all;
 * - the offer's own lifetime runs out;
 * - the main process says so: a new turn started, the plugin stopped, or the
 *   plugin asked to clear it.
 *
 * A renderer reload and a window close end the whole module with the page, so
 * there is nothing to hold over.
 */
import type { PluginComposerSuggestionRefusal } from "@pi-desktop/plugin-sdk";
import type { ComposerDraftHandle } from "./draft-bridge";

/** One suggestion the shell may draw in the placeholder layer. */
export type ComposerSuggestion = {
  readonly pluginId: string;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly text: string;
  /** Epoch milliseconds; the line goes away at this moment. */
  readonly expiresAt: number;
};

/** What the main process asks the shell to consider. */
export type ComposerSuggestionOffer = ComposerSuggestion;

/** Whether the offer is on screen now. */
export type ComposerSuggestionOutcome =
  | { shown: true }
  | { shown: false; reason: PluginComposerSuggestionRefusal };

/** Narrowing filter for a host-ordered clear; nothing named means everything. */
export type ComposerSuggestionFilter = {
  readonly pluginId?: string;
  readonly sessionId?: string;
};

type Live = {
  readonly sessionId: string;
  readonly text: string;
  /** References the draft holds, staged attachments included. */
  readonly referenceCount: number;
};

function now(): number {
  return Date.now();
}

export class ComposerSuggestionBridge {
  private readonly handles: ComposerDraftHandle[] = [];
  private readonly listeners = new Set<() => void>();
  private current: ComposerSuggestion | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  /** Lend the bridge a composer; the returned call takes it back. */
  register(handle: ComposerDraftHandle): () => void {
    this.handles.push(handle);
    this.reconcile();
    return () => {
      const index = this.handles.lastIndexOf(handle);
      if (index === -1) return;
      this.handles.splice(index, 1);
      this.reconcile();
    };
  }

  /**
   * The composer's word that its draft changed. The suggestion belongs to an
   * empty draft of one session, so a first character, a staged attachment or a
   * switch of session ends it here — before any render draws it again.
   */
  publish(handle: ComposerDraftHandle): void {
    if (this.handles.at(-1) !== handle) return;
    this.reconcile();
  }

  /** The suggestion on screen, or `null`. Stable between changes. */
  get(): ComposerSuggestion | null {
    return this.current;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Consider one offer. Only the composer taking input can answer, so a window
   * with no composer reports `unsupported` instead of pretending.
   */
  offer(offer: ComposerSuggestionOffer): ComposerSuggestionOutcome {
    const live = this.live();
    if (!live) return { shown: false, reason: "unsupported" };
    if (live.sessionId !== offer.sessionId) return { shown: false, reason: "session-not-visible" };
    if (live.text.length > 0 || live.referenceCount > 0) {
      return { shown: false, reason: "draft-not-empty" };
    }
    // The main process dates the offer when the plugin made it, so an offer
    // that arrives after its own lifetime describes a moment that is over.
    if (offer.expiresAt <= now()) return { shown: false, reason: "stale-turn" };
    this.set({
      pluginId: offer.pluginId,
      sessionId: offer.sessionId,
      ...(offer.turnId ? { turnId: offer.turnId } : {}),
      text: offer.text,
      expiresAt: offer.expiresAt,
    });
    return { shown: true };
  }

  /**
   * Take the suggestion: the draft becomes its text, the caret lands at the end
   * and the input takes focus, which is exactly what typing that sentence would
   * have done. The existing references are kept, so an image staged in the
   * meantime is not lost.
   */
  accept(): boolean {
    const suggestion = this.current;
    const draft = this.handles.at(-1)?.read() ?? null;
    if (
      !suggestion ||
      !draft ||
      draft.text.length > 0 ||
      draft.sessionId !== suggestion.sessionId
    ) {
      this.dismiss();
      return false;
    }
    this.dismiss();
    this.handles
      .at(-1)
      ?.write(suggestion.text, [...draft.references], suggestion.text.length, true);
    return true;
  }

  /** Drop whatever is on screen. */
  dismiss(): void {
    this.set(null);
  }

  /** A host-ordered clear: one plugin, one session, or everything. */
  clear(filter: ComposerSuggestionFilter = {}): void {
    const suggestion = this.current;
    if (!suggestion) return;
    if (filter.pluginId && filter.pluginId !== suggestion.pluginId) return;
    if (filter.sessionId && filter.sessionId !== suggestion.sessionId) return;
    this.dismiss();
  }

  private set(next: ComposerSuggestion | null): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.current === next) return;
    this.current = next;
    if (next) {
      // A lifetime the shell already spent is not a suggestion any more.
      const remaining = next.expiresAt - now();
      this.timer = setTimeout(
        () => {
          if (this.current?.expiresAt === next.expiresAt) this.dismiss();
        },
        Math.max(0, remaining),
      );
    }
    for (const listener of [...this.listeners]) listener();
  }

  /** The composer taking input and its draft, or `null`. */
  private live(): Live | null {
    const handle = this.handles.at(-1);
    const draft = handle?.read() ?? null;
    if (!handle || !draft) return null;
    return {
      sessionId: draft.sessionId,
      text: draft.text,
      referenceCount: draft.references.length,
    };
  }

  /**
   * End the suggestion when the composer can no longer hold it. Called on every
   * draft change and on every registration change, so the slot never outlives
   * the empty draft it was offered for.
   */
  private reconcile(): void {
    const suggestion = this.current;
    if (!suggestion) return;
    const live = this.live();
    if (
      !live ||
      live.sessionId !== suggestion.sessionId ||
      live.text.length > 0 ||
      live.referenceCount > 0
    ) {
      this.dismiss();
    }
  }
}

/** The app window's suggestion slot. */
export const composerSuggestion = new ComposerSuggestionBridge();
