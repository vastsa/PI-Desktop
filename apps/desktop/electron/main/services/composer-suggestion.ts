/** Main owns selection/turn checks and plugin-owned targets; the renderer owns the draft. */
import { randomUUID } from "node:crypto";
import {
  PLUGIN_COMPOSER_SUGGESTION_MAX_CHARS,
  PLUGIN_COMPOSER_SUGGESTION_TTL_MAX_MS,
  PLUGIN_COMPOSER_SUGGESTION_TTL_MIN_MS,
  PLUGIN_COMPOSER_SUGGESTION_TTL_MS,
  type PluginComposerSuggestionRefusal,
} from "@pi-desktop/plugin-sdk";
import {
  IPC,
  type ComposerSuggestionAnswer,
  type ComposerSuggestionMessage,
} from "@pi-desktop/shared";

export type { ComposerSuggestionAnswer, ComposerSuggestionMessage } from "@pi-desktop/shared";

/** The legacy single text offer, already normalized by the caller. */
export type ComposerSuggestionOffer = {
  pluginId: string;
  sessionId: string;
  turnId?: string;
  text: string;
  ttlMs: number;
};

export type ComposerSuggestionOutcome =
  | { shown: true }
  | { shown: false; reason: PluginComposerSuggestionRefusal };

export type ComposerSuggestionRelayDependencies = {
  sendToRenderer: (channel: string, payload: unknown) => void;
  getActiveSession: () => {
    sessionId: string;
    projectPath?: string | null;
    activeTurn?: { turnId: string } | null;
  } | null;
  answerTimeoutMs?: number;
  now?: () => number;
  log?: (message: string, data?: Record<string, unknown>) => void;
};

const DEFAULT_ANSWER_TIMEOUT_MS = 2_000;
const TARGET_TTL_MS = 60_000;
const MAX_TARGETS = 64;
const MAX_PENDING_PROBES = 32;
const MAX_TRACKED_SESSIONS = 64;
const MAX_ID_CHARS = 128;
const MAX_CANDIDATES = 3;

const UNSHOWN: ComposerSuggestionOutcome = { shown: false, reason: "unsupported" };
type Owner = { pluginId: string; sessionId: string };
type Target = Owner & { turnId: string; revision: string; expiresAt: number };
type PendingReply<T> = Owner & {
  settle: (result: T) => void;
  timer: ReturnType<typeof setTimeout>;
};
type PendingOffer = PendingReply<ComposerSuggestionOutcome> & { requestId: string };
type OfferFields = Omit<Extract<ComposerSuggestionMessage, { kind: "offer" }>, "kind" | "requestId" | "expiresAt"> & (
  | { text: string }
  | { candidates: readonly string[]; revision: string; validUntil: number }
) & { expiresAt: number };

function enforceBound<K, V>(map: Map<K, V>, limit: number): void {
  while (map.size > limit) {
    const oldest = map.keys().next();
    if (oldest.done) return;
    map.delete(oldest.value);
  }
}

function invalid(message: string): never {
  throw Object.assign(new Error(message), { code: "INVALID_PARAMS" });
}

function record(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" ? (input as Record<string, unknown>) : {};
}

function normalizeCandidates(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_CANDIDATES) {
    return invalid(`candidates must contain between 1 and ${MAX_CANDIDATES} strings`);
  }
  const normalized = new Set<string>();
  for (const candidate of value) {
    if (typeof candidate !== "string") return invalid("each candidate must be a string");
    const line = candidate.replace(/\s+/g, " ").trim();
    const points: string[] = [];
    for (const point of line) {
      if (points.length === PLUGIN_COMPOSER_SUGGESTION_MAX_CHARS) break;
      points.push(point);
    }
    const text = points.join("").trimEnd();
    if (!text) continue;
    normalized.add(text);
  }
  if (normalized.size === 0) return invalid("candidates must contain at least one visible line");
  return [...normalized];
}

function normalizeTtl(value: unknown): number {
  if (value === undefined || value === null) return PLUGIN_COMPOSER_SUGGESTION_TTL_MS;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return invalid("ttlMs must be a number of milliseconds");
  }
  return Math.min(
    Math.max(Math.round(value), PLUGIN_COMPOSER_SUGGESTION_TTL_MIN_MS),
    PLUGIN_COMPOSER_SUGGESTION_TTL_MAX_MS,
  );
}

export type ComposerSuggestionRelay = ReturnType<typeof createComposerSuggestionRelay>;

export function createComposerSuggestionRelay({
  sendToRenderer,
  getActiveSession,
  answerTimeoutMs = DEFAULT_ANSWER_TIMEOUT_MS,
  now = Date.now,
  log,
}: ComposerSuggestionRelayDependencies) {
  const pending = new Map<string, PendingOffer>(); // one in-flight offer per session
  const probes = new Map<string, PendingReply<string | null>>();
  const targets = new Map<string, Target>();
  const latestTurns = new Map<string, string>();
  let activeSessionId: string | null = null;
  let activeProjectPath: string | null = null;

  const send = (message: ComposerSuggestionMessage): void => {
    try {
      sendToRenderer(IPC.event.pluginComposerSuggestion, message);
    } catch (error) {
      log?.("composer suggestion send failed", { kind: message.kind, data: String(error) });
    }
  };

  function finish<T>(map: Map<string, PendingReply<T>>, key: string, result: T): void {
    const entry = map.get(key);
    if (!entry) return;
    map.delete(key);
    clearTimeout(entry.timer);
    entry.settle(result);
  }

  function invalidateTargets(matches: (owner: Owner) => boolean): void {
    for (const [token, target] of targets) {
      if (matches(target)) targets.delete(token);
    }
    for (const [id, probe] of probes) {
      if (matches(probe)) finish(probes, id, null);
    }
  }

  const noteActiveSessionChanged = () => {
    const active = getActiveSession();
    const nextSession = active?.sessionId ?? null;
    const nextProject = active?.projectPath ?? null;
    if (nextSession === activeSessionId && nextProject === activeProjectPath) return;
    const previousSession = activeSessionId;
    activeSessionId = nextSession;
    activeProjectPath = nextProject;
    invalidateTargets(() => true);
    if (previousSession) {
      finish(pending, previousSession, { shown: false, reason: "session-not-visible" });
      send({ kind: "clear", sessionId: previousSession });
    }
  };

  function turnFor(sessionId: string): string | undefined {
    const active = getActiveSession();
    return (active?.sessionId === sessionId ? active.activeTurn?.turnId : undefined) ?? latestTurns.get(sessionId);
  }

  function offerToRenderer(offer: OfferFields): Promise<ComposerSuggestionOutcome> {
    const { pluginId, sessionId } = offer;
    finish(pending, sessionId, { shown: false, reason: "replaced" });
    const requestId = randomUUID();
    return new Promise((settle) => {
      const timer = setTimeout(() => finish(pending, sessionId, UNSHOWN), answerTimeoutMs);
      (timer as { unref?: () => void }).unref?.();
      pending.set(sessionId, { requestId, pluginId, sessionId, settle, timer });
      send({ kind: "offer", requestId, ...offer });
    });
  }

  function clear(pluginId: string, sessionId?: string): void {
    const id = pluginId.trim();
    if (!id) return;
    const session = sessionId?.trim();
    const matches = (owner: Owner) => owner.pluginId === id && (!session || owner.sessionId === session);
    invalidateTargets(matches);
    for (const [key, offer] of pending) {
      if (matches(offer)) finish(pending, key, UNSHOWN);
    }
    send({ kind: "clear", pluginId: id, ...(session ? { sessionId: session } : {}) });
  }

  return {
    noteActiveSessionChanged,

    /** Legacy calls still accept an optional turn with no known turn history. */
    offer(offer: ComposerSuggestionOffer): Promise<ComposerSuggestionOutcome> {
      noteActiveSessionChanged();
      if (activeSessionId !== offer.sessionId) {
        return Promise.resolve({ shown: false, reason: "session-not-visible" });
      }
      const newestTurn = latestTurns.get(offer.sessionId);
      if (offer.turnId && newestTurn && newestTurn !== offer.turnId) {
        return Promise.resolve({ shown: false, reason: "stale-turn" });
      }
      const { ttlMs, ...fields } = offer;
      return offerToRenderer({ ...fields, expiresAt: now() + ttlMs });
    },

    /** Probe the current empty composer; return only an opaque plugin-owned token. */
    async getTarget(pluginId: string, input: unknown): Promise<string | null> {
      const raw = record(input);
      const sessionId = typeof raw.sessionId === "string" ? raw.sessionId.trim() : "";
      if (!sessionId || sessionId.length > MAX_ID_CHARS) {
        return invalid("sessionId must be a non-empty string of at most 128 characters");
      }
      const requestedTurn = typeof raw.turnId === "string" ? raw.turnId.trim() : undefined;
      if (!requestedTurn || requestedTurn.length > MAX_ID_CHARS) {
        return invalid("turnId must be a non-empty string of at most 128 characters");
      }
      noteActiveSessionChanged();
      if (activeSessionId !== sessionId || probes.size >= MAX_PENDING_PROBES) return null;
      const turnId = turnFor(sessionId);
      if (turnId !== requestedTurn) return null;
      const requestId = randomUUID();
      // Finish inside the probe's reply callback so a clear/unload cannot land
      // between removing the probe and storing its issued token.
      return new Promise((resolve) => {
        const settle = (revision: string | null) => {
          if (!revision || activeSessionId !== sessionId || turnFor(sessionId) !== turnId) {
            resolve(null);
            return;
          }
          const issuedAt = now();
          for (const [token, target] of targets) {
            if (target.expiresAt <= issuedAt) targets.delete(token);
          }
          const token = randomUUID();
          targets.set(token, { pluginId, sessionId, turnId, revision, expiresAt: issuedAt + TARGET_TTL_MS });
          enforceBound(targets, MAX_TARGETS);
          resolve(token);
        };
        const timer = setTimeout(() => finish(probes, requestId, null), answerTimeoutMs);
        (timer as { unref?: () => void }).unref?.();
        probes.set(requestId, { pluginId, sessionId, settle, timer });
        send({ kind: "target", requestId, sessionId });
      });
    },

    /** Revalidate the target here and against the renderer's live revision at delivery. */
    async offerCandidates(pluginId: string, input: unknown): Promise<ComposerSuggestionOutcome> {
      const raw = record(input);
      if (typeof raw.target !== "string" || !raw.target.trim() || raw.target.length > MAX_ID_CHARS) {
        return invalid("target must be a non-empty suggestion target");
      }
      const candidates = normalizeCandidates(raw.candidates);
      const ttlMs = normalizeTtl(raw.ttlMs);
      noteActiveSessionChanged();
      const target = targets.get(raw.target);
      if (!target || target.pluginId !== pluginId) return UNSHOWN;
      const { sessionId, turnId, revision, expiresAt } = target;
      const offeredAt = now();
      if (expiresAt <= offeredAt || turnFor(sessionId) !== turnId) {
        targets.delete(raw.target);
        return { shown: false, reason: "stale-turn" };
      }
      if (activeSessionId !== sessionId) return { shown: false, reason: "session-not-visible" };
      return offerToRenderer({
        pluginId, sessionId, turnId, candidates, revision,
        expiresAt: Math.min(expiresAt, offeredAt + ttlMs),
        validUntil: Math.min(expiresAt, offeredAt + answerTimeoutMs),
      });
    },

    settle(reply: ComposerSuggestionAnswer): boolean {
      noteActiveSessionChanged();
      if (probes.has(reply.requestId)) {
        finish(probes, reply.requestId, reply.shown ? reply.revision || null : null);
        return true;
      }
      const offer = [...pending.values()].find((entry) => entry.requestId === reply.requestId);
      if (!offer) return false;
      finish(pending, offer.sessionId, reply.shown ? { shown: true } : {
        shown: false, reason: reply.reason ?? "unsupported",
      });
      return true;
    },

    noteTurnStarted(sessionId: string, turnId: string): void {
      const id = sessionId.trim();
      const turn = turnId.trim();
      if (!id || !turn) return;
      // Refresh insertion order so recent sessions retain their known turn.
      latestTurns.delete(id);
      latestTurns.set(id, turn);
      enforceBound(latestTurns, MAX_TRACKED_SESSIONS);
      invalidateTargets((owner) => owner.sessionId === id);
      finish(pending, id, { shown: false, reason: "stale-turn" });
      send({ kind: "clear", sessionId: id });
    },

    clearPlugin(pluginId: string): void {
      clear(pluginId);
    },

    clearSuggestion: clear,

    dispose(): void {
      for (const sessionId of pending.keys()) finish(pending, sessionId, UNSHOWN);
      invalidateTargets(() => true);
      latestTurns.clear();
      activeSessionId = null;
      activeProjectPath = null;
    },
  };
}
