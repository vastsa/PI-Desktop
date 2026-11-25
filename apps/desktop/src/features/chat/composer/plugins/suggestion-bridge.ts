/** The renderer owns the live composer and its one suggestion slot, separate from the draft. */
import type { ComposerSuggestionMessage } from "@pi-desktop/shared";
import type { PluginComposerSuggestionRefusal } from "@pi-desktop/plugin-sdk";
import type { ComposerDraftHandle } from "./draft-bridge";

/** An offer from main, without its IPC correlation fields. */
type OfferMessage = Extract<ComposerSuggestionMessage, { kind: "offer" }>;
type OfferFields = Pick<OfferMessage, "pluginId" | "sessionId" | "turnId" | "expiresAt">;
export type ComposerSuggestionOffer = OfferFields & (
  | { text: string }
  | { candidates: readonly string[]; revision: string; validUntil: number }
);

export type ComposerSuggestion = Readonly<OfferFields & {
  text: string;
  candidates: readonly string[];
  index: number;
  revision?: string;
}>;

export type ComposerSuggestionOutcome =
  | { shown: true }
  | { shown: false; reason: PluginComposerSuggestionRefusal };

export type ComposerSuggestionFilter = {
  readonly pluginId?: string;
  readonly sessionId?: string;
};

/** The version is read synchronously from the draft cache, even before React commits. */
export type ComposerSuggestionHandle = ComposerDraftHandle & {
  draftRevision: () => number;
  canSuggest?: () => boolean;
};
type Draft = NonNullable<ReturnType<ComposerDraftHandle["read"]>>;

export class ComposerSuggestionBridge {
  private readonly handles: ComposerSuggestionHandle[] = [];
  private readonly listeners = new Set<() => void>();
  private selectedSession: string | null | undefined;
  private revision: string | null = null;
  private liveStamp: { handle: ComposerSuggestionHandle; draftKey: string; sessionId: string; version: number } | null = null;
  private current: ComposerSuggestion | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  register(handle: ComposerSuggestionHandle): () => void {
    this.handles.push(handle);
    this.invalidateRevision();
    return () => {
      const index = this.handles.lastIndexOf(handle);
      if (index < 0) return;
      const wasActive = index === this.handles.length - 1;
      this.handles.splice(index, 1);
      if (wasActive) this.invalidateRevision();
    };
  }

  /** Call on every store selection transition, even those batched out of a React render. */
  selectSession(sessionId: string | null): void {
    if (this.selectedSession === sessionId) return;
    this.selectedSession = sessionId;
    this.invalidateRevision();
  }

  publish(handle: ComposerSuggestionHandle): void {
    if (this.handles.at(-1) === handle) this.live();
  }

  /** Nothing about a nonempty or inactive draft is returned, even to main. */
  getTarget(sessionId: string): string | null {
    const live = this.live();
    if (!live || live.draft.sessionId !== sessionId || !this.isEmpty(live.draft)) return null;
    return (this.revision ??= crypto.randomUUID());
  }

  get(): ComposerSuggestion | null {
    return this.current;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  offer(offer: ComposerSuggestionOffer): ComposerSuggestionOutcome {
    const live = this.live();
    if (!live) return { shown: false, reason: "unsupported" };
    if (live.draft.sessionId !== offer.sessionId) return { shown: false, reason: "session-not-visible" };
    if (!this.isEmpty(live.draft)) return { shown: false, reason: "draft-not-empty" };
    const now = Date.now();
    if (offer.expiresAt <= now || ("revision" in offer && (
      offer.revision !== this.revision || offer.validUntil <= now
    ))) return { shown: false, reason: "stale-turn" };
    const candidates = "candidates" in offer ? [...offer.candidates] : [offer.text];
    this.set({
      pluginId: offer.pluginId,
      sessionId: offer.sessionId,
      ...(offer.turnId ? { turnId: offer.turnId } : {}),
      text: candidates[0]!,
      candidates,
      index: 0,
      expiresAt: offer.expiresAt,
      ...("revision" in offer ? { revision: offer.revision } : {}),
    });
    return { shown: true };
  }

  cycle(delta: -1 | 1, expected = this.current): boolean {
    const live = this.live();
    const current = this.current;
    if (!live || !current || current !== expected || current.candidates.length < 2) return false;
    if (current.expiresAt <= Date.now()) {
      this.dismiss();
      return false;
    }
    const count = current.candidates.length;
    const index = (current.index + count + delta) % count;
    this.set({ ...current, index, text: current.candidates[index]! });
    return true;
  }

  /** Take only the current line. This is a draft write, never a send. */
  accept(expected = this.current): boolean {
    const suggestion = this.current;
    if (!suggestion || suggestion !== expected) return false;
    const handle = this.handles.at(-1);
    // Preserve legacy behavior if an attachment arrives before its draft publish.
    // Revision-bound groups, in contrast, must still own the same empty draft.
    const live = suggestion.revision ? this.live() : null;
    const draft = suggestion.revision ? live?.draft : handle?.read();
    if (
      !draft || draft.text.length > 0 || draft.sessionId !== suggestion.sessionId ||
      this.current !== suggestion || suggestion.expiresAt <= Date.now() ||
      (this.selectedSession !== undefined && draft.sessionId !== this.selectedSession)
    ) {
      this.dismiss(expected);
      return false;
    }
    this.invalidateRevision();
    handle?.write(suggestion.text, [...draft.references], suggestion.text.length, true);
    return true;
  }

  dismiss(expected = this.current): void {
    if (this.current === expected) this.set(null);
  }

  clear(filter: ComposerSuggestionFilter = {}): void {
    if (!filter.pluginId && (!filter.sessionId || filter.sessionId === this.liveStamp?.sessionId)) {
      this.invalidateRevision();
      return;
    }
    const suggestion = this.current;
    if (!suggestion) return;
    if (filter.pluginId && filter.pluginId !== suggestion.pluginId) return;
    if (filter.sessionId && filter.sessionId !== suggestion.sessionId) return;
    this.dismiss();
  }

  private set(next: ComposerSuggestion | null): void {
    if (this.current === next) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.current = next;
    this.timer = next ? setTimeout(() => this.dismiss(next), Math.max(0, next.expiresAt - Date.now())) : null;
    // Node-based tests do not need this renderer timer to keep their process alive.
    (this.timer as { unref?: () => void } | null)?.unref?.();
    for (const listener of [...this.listeners]) listener();
  }

  private invalidateRevision(): void {
    this.revision = null;
    this.liveStamp = null;
    this.dismiss();
  }

  private isEmpty(draft: Draft): boolean {
    return draft.text.length === 0 && draft.references.length === 0;
  }

  /** Reconcile version, availability and ownership before doing anything with a suggestion. */
  private live(): { draft: Draft } | null {
    const handle = this.handles.at(-1);
    const draft = handle?.read();
    if (
      !handle || !draft || handle.canSuggest?.() === false ||
      (this.selectedSession !== undefined && draft.sessionId !== this.selectedSession)
    ) {
      this.invalidateRevision();
      return null;
    }
    const version = handle.draftRevision();
    const previous = this.liveStamp;
    if (previous?.handle !== handle || previous.draftKey !== draft.draftKey || previous.sessionId !== draft.sessionId) {
      this.invalidateRevision();
    } else if (previous.version !== version || !this.isEmpty(draft)) {
      this.revision = null;
      if (this.current?.revision || !this.isEmpty(draft)) this.dismiss();
    }
    this.liveStamp = { handle, draftKey: draft.draftKey, sessionId: draft.sessionId, version };
    return { draft };
  }
}

export const composerSuggestion = new ComposerSuggestionBridge();
