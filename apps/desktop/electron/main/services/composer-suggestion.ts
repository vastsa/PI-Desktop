/**
 * The main-process half of `pi.composer.suggest` (ADR 0333).
 *
 * A suggestion is produced by a plugin process, long after the turn it answers
 * ended, so by the time it arrives the user may have typed, switched session,
 * or started another turn. Two owners therefore decide together, and this module
 * is the seam between them:
 *
 * - The main process owns the facts it already has — which session is on screen
 *   (`pluginSession` snapshot) and which turn that session ran last — so a
 *   suggestion naming another session, or a turn that is no longer the newest,
 *   is refused here and never crosses to the window.
 * - The renderer owns the composer, so whether the draft is empty and whether a
 *   composer takes input at all is its answer, sent back over an invoke. The
 *   caller waits for that answer instead of being told a guess.
 *
 * Nothing here writes renderer state: the offer is a message, and the composer
 * decides. The relay also carries the two shell-side invalidations only the main
 * process sees — a new turn starting, and a plugin going away.
 */
import { randomUUID } from "node:crypto";
import type { PluginComposerSuggestionRefusal } from "@pi-desktop/plugin-sdk";
import { IPC } from "@pi-desktop/shared";

/** One suggestion a plugin asked the shell to show. */
export type ComposerSuggestionOffer = {
  pluginId: string;
  sessionId: string;
  turnId?: string;
  text: string;
  ttlMs: number;
};

/** What became of one offer: on screen, or why not. */
export type ComposerSuggestionOutcome =
  | { shown: true }
  | { shown: false; reason: PluginComposerSuggestionRefusal };

/**
 * What main sends the renderer. `offer` asks the shell to show one line; `clear`
 * orders it to drop what it shows — of one plugin, of one session, or of
 * whatever it holds when neither is named.
 */
export type ComposerSuggestionMessage =
  | {
      kind: "offer";
      requestId: string;
      pluginId: string;
      sessionId: string;
      turnId?: string;
      text: string;
      /** Epoch milliseconds; the shell drops the line at this moment. */
      expiresAt: number;
    }
  | { kind: "clear"; pluginId?: string; sessionId?: string };

/** The shell's answer to one `offer`, as it arrives over its own invoke. */
export type ComposerSuggestionAnswer = {
  requestId: string;
  shown: boolean;
  reason?: PluginComposerSuggestionRefusal;
};

export type ComposerSuggestionRelayDependencies = {
  sendToRenderer: (channel: string, payload: unknown) => void;
  /** The session the shell shows, read from the plugin session snapshot. */
  getActiveSession: () => { sessionId: string } | null;
  /** How long the shell has to answer an offer; a slow window is no window. */
  answerTimeoutMs?: number;
  now?: () => number;
  log?: (message: string, data?: Record<string, unknown>) => void;
};

/** Longest wait for the renderer's answer before the offer is given up on. */
const DEFAULT_ANSWER_TIMEOUT_MS = 2_000;
/**
 * Sessions whose last known turn is still remembered. Only the newest turn per
 * session matters and a stale entry is corrected by the next turn start, so the
 * map is capped rather than grown with every session the app ever ran.
 */
const MAX_TRACKED_SESSIONS = 64;

const UNSHOWN: ComposerSuggestionOutcome = { shown: false, reason: "unsupported" };

type PendingOffer = {
  requestId: string;
  pluginId: string;
  sessionId: string;
  settle: (outcome: ComposerSuggestionOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
};

function enforceBound<K, V>(map: Map<K, V>, limit: number): void {
  while (map.size > limit) {
    const oldest = map.keys().next();
    if (oldest.done) return;
    map.delete(oldest.value);
  }
}

export type ComposerSuggestionRelay = ReturnType<typeof createComposerSuggestionRelay>;

export function createComposerSuggestionRelay({
  sendToRenderer,
  getActiveSession,
  answerTimeoutMs = DEFAULT_ANSWER_TIMEOUT_MS,
  now = Date.now,
  log,
}: ComposerSuggestionRelayDependencies) {
  /** sessionId → the offer waiting for the shell's answer. One per session. */
  const pending = new Map<string, PendingOffer>();
  /** sessionId → the newest turn the main process heard of. */
  const latestTurns = new Map<string, string>();

  const send = (message: ComposerSuggestionMessage): void => {
    try {
      sendToRenderer(IPC.event.pluginComposerSuggestion, message);
    } catch (error) {
      // Delivery is best effort: a window that is gone must not turn a plugin's
      // suggestion call into a failure, and the offer's own timeout already
      // reports the miss.
      log?.("composer suggestion send failed", { kind: message.kind, data: String(error) });
    }
  };

  /** Forget one waiting offer and answer it with `reason`. */
  const drop = (offer: PendingOffer, reason: PluginComposerSuggestionRefusal): void => {
    if (pending.get(offer.sessionId)?.requestId === offer.requestId) {
      pending.delete(offer.sessionId);
    }
    clearTimeout(offer.timer);
    offer.settle({ shown: false, reason });
  };

  /** Exactly one offer can be in flight per session, so the loser learns it lost. */
  const preempt = (sessionId: string, reason: PluginComposerSuggestionRefusal): void => {
    const offer = pending.get(sessionId);
    if (offer) drop(offer, reason);
  };

  const answer = (offer: PendingOffer, result: ComposerSuggestionOutcome): void => {
    if (pending.get(offer.sessionId)?.requestId === offer.requestId) {
      pending.delete(offer.sessionId);
    }
    clearTimeout(offer.timer);
    offer.settle(result);
  };

  return {
    /**
     * Offer one line to the shell and wait for its answer.
     *
     * `turnId` is compared with the newest turn the main process saw for the
     * session: a suggestion about a turn that has since been overtaken names a
     * moment that is over, so it is refused here instead of arriving late in a
     * composer that belongs to the newer turn.
     */
    offer(offer: ComposerSuggestionOffer): Promise<ComposerSuggestionOutcome> {
      const active = getActiveSession();
      if (!active || active.sessionId !== offer.sessionId) {
        return Promise.resolve({ shown: false, reason: "session-not-visible" });
      }
      const newestTurn = latestTurns.get(offer.sessionId);
      if (offer.turnId && newestTurn && newestTurn !== offer.turnId) {
        return Promise.resolve({ shown: false, reason: "stale-turn" });
      }
      // The newer offer takes the session's single slot; the one still waiting
      // for an answer is told so instead of being left to time out.
      preempt(offer.sessionId, "replaced");
      const requestId = randomUUID();
      return new Promise<ComposerSuggestionOutcome>((resolve) => {
        let settled = false;
        const settle = (result: ComposerSuggestionOutcome): void => {
          if (settled) return;
          settled = true;
          resolve(result);
        };
        const timer = setTimeout(() => {
          const current = pending.get(offer.sessionId);
          if (current?.requestId === requestId) drop(current, "unsupported");
        }, answerTimeoutMs);
        // A window that closes mid-answer must not keep the timer alive.
        (timer as { unref?: () => void }).unref?.();
        pending.set(offer.sessionId, {
          requestId,
          pluginId: offer.pluginId,
          sessionId: offer.sessionId,
          settle,
          timer,
        });
        send({
          kind: "offer",
          requestId,
          pluginId: offer.pluginId,
          sessionId: offer.sessionId,
          ...(offer.turnId ? { turnId: offer.turnId } : {}),
          text: offer.text,
          expiresAt: now() + offer.ttlMs,
        });
      });
    },

    /**
     * The shell's word on one offer. Answers arrive asynchronously, so one that
     * lands after its offer was replaced, timed out or dropped is simply
     * ignored.
     */
    settle(reply: ComposerSuggestionAnswer): boolean {
      const offer = [...pending.values()].find((entry) => entry.requestId === reply.requestId);
      if (!offer) return false;
      answer(
        offer,
        reply.shown ? { shown: true } : { shown: false, reason: reply.reason ?? "unsupported" },
      );
      return true;
    },

    /**
     * A host turn opened for this session: the new turn owns the composer now,
     * and a suggestion about an earlier turn is over.
     */
    noteTurnStarted(sessionId: string, turnId: string): void {
      const id = sessionId.trim();
      const turn = turnId.trim();
      if (!id || !turn) return;
      latestTurns.set(id, turn);
      enforceBound(latestTurns, MAX_TRACKED_SESSIONS);
      preempt(id, "stale-turn");
      send({ kind: "clear", sessionId: id });
    },

    /** The plugin stopped (unloaded, disabled, crashed, revoked): its line goes. */
    clearPlugin(pluginId: string): void {
      const id = pluginId.trim();
      if (!id) return;
      for (const offer of [...pending.values()]) {
        if (offer.pluginId === id) drop(offer, "unsupported");
      }
      send({ kind: "clear", pluginId: id });
    },

    /** A plugin dropped its own suggestion; a session narrows it further. */
    clearSuggestion(pluginId: string, sessionId?: string): void {
      const id = pluginId.trim();
      if (!id) return;
      const session = sessionId?.trim() ?? "";
      for (const offer of [...pending.values()]) {
        if (offer.pluginId !== id) continue;
        if (session && offer.sessionId !== session) continue;
        drop(offer, "unsupported");
      }
      send({ kind: "clear", pluginId: id, ...(session ? { sessionId: session } : {}) });
    },

    /** The window is going away: nothing will show these offers. */
    dispose(): void {
      for (const offer of [...pending.values()]) drop(offer, "unsupported");
      pending.clear();
      latestTurns.clear();
    },
  };
}
