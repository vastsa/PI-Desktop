import { modelWireIdsEqual } from "@pi-desktop/shared";
import type {
  NativeContextSnapshot,
  TrustedExtensionStatusEvent,
} from "@pi-desktop/shared";

/**
 * The context snapshot a trusted agent extension reported for a session.
 *
 * A snapshot is a read-only observation (spec §9): PI's own calibrated input
 * token estimate against the model's hard input budget. It is never a billing
 * record, so nothing here is merged into provider usage, cache or cost — those
 * keep coming from the provider's own report.
 *
 * The store is renderer memory only. It is bounded so a long-lived window
 * cannot keep one snapshot per closed session, and it is keyed by session: a
 * `null` clears the reporting extension's own source and never touches another
 * conversation, which is what lets several sessions report at once.
 */

/** Beyond these, the least recently reported entries are dropped. */
const MAX_SESSIONS = 24;
const MAX_SOURCES_PER_SESSION = 4;

const UNKNOWN_SOURCE = "unknown";

/** sessionId → reporting extensionId → newest snapshot for that source. */
const sourcesBySession = new Map<string, Map<string, NativeContextSnapshot>>();
const listeners = new Set<() => void>();

function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

/** A budget of zero describes no model, so it is never a usable ceiling. */
function budget(value: unknown): number | undefined {
  const count = tokenCount(value);
  return count !== undefined && count > 0 ? count : undefined;
}

function identifier(value: unknown): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  return text || undefined;
}

/**
 * Normalise what the sidecar sent. Anything the renderer cannot show — a
 * missing model identity or an invalid count or budget — is dropped rather than
 * guessed at, so the composer keeps its own figures.
 */
function readSnapshot(raw: unknown): NativeContextSnapshot | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const source = raw as Record<string, unknown>;
  const providerId = identifier(source.providerId);
  const modelId = identifier(source.modelId);
  const tokens = tokenCount(source.tokens);
  const hardLimit = budget(source.hardLimit);
  if (!providerId || !modelId || tokens === undefined || hardLimit === undefined) {
    return undefined;
  }
  return { providerId, modelId, tokens, hardLimit };
}

function notify(): void {
  for (const listener of [...listeners]) listener();
}

/** Insertion order is recency, so a re-report moves its key to the back. */
function remember<T>(map: Map<string, T>, key: string, value: T): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > MAX_SOURCES_PER_SESSION) {
    const oldest = map.keys().next().value;
    if (oldest === undefined || oldest === key) break;
    map.delete(oldest);
  }
}

function removeSource(sessionId: string, source: string): void {
  const sources = sourcesBySession.get(sessionId);
  if (!sources) return;
  sources.delete(source);
  if (sources.size === 0) sourcesBySession.delete(sessionId);
}

/**
 * Feed one extension status event in. Returns `true` when the event carried the
 * `contextSnapshot` field — such an event is data for the context inspector and
 * must never be shown as a floating status line.
 */
export function recordExtensionStatus(event: TrustedExtensionStatusEvent): boolean {
  if (!event || event.contextSnapshot === undefined) return false;
  const sessionId = identifier(event.sessionId);
  if (!sessionId) return true;
  const source = identifier(event.extensionId) ?? UNKNOWN_SOURCE;
  const snapshot =
    event.contextSnapshot === null ? undefined : readSnapshot(event.contextSnapshot);
  if (!snapshot) {
    removeSource(sessionId, source);
  } else {
    const sources = sourcesBySession.get(sessionId) ?? new Map<string, NativeContextSnapshot>();
    sourcesBySession.delete(sessionId);
    sourcesBySession.set(sessionId, sources);
    remember(sources, source, snapshot);
    while (sourcesBySession.size > MAX_SESSIONS) {
      const oldest = sourcesBySession.keys().next().value;
      if (oldest === undefined || oldest === sessionId) break;
      sourcesBySession.delete(oldest);
    }
  }
  notify();
  return true;
}

/**
 * The snapshot for exactly this session, provider and model. A different model
 * — a switched provider, or another deployment with a similar model id —
 * matches nothing, and the caller keeps its previous behaviour.
 */
export function selectNativeContextSnapshot(match: {
  sessionId?: string | null;
  providerId?: string | null;
  modelId?: string | null;
}): NativeContextSnapshot | undefined {
  const sessionId = identifier(match.sessionId);
  const providerId = identifier(match.providerId);
  const modelId = identifier(match.modelId);
  if (!sessionId || !providerId || !modelId) return undefined;
  const sources = sourcesBySession.get(sessionId);
  if (!sources) return undefined;
  // Map order is oldest to newest, so the last match is the newest report.
  let found: NativeContextSnapshot | undefined;
  for (const snapshot of sources.values()) {
    if (
      snapshot.providerId.toLowerCase() === providerId.toLowerCase() &&
      modelWireIdsEqual(snapshot.modelId, modelId)
    ) {
      found = snapshot;
    }
  }
  return found;
}

/** Subscribes to snapshot changes; the selected object itself is stable. */
export function subscribeNativeContext(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Everything the store holds; used by tests and diagnostics. */
export function nativeContextSize(): { sessions: number; sources: number } {
  let count = 0;
  for (const sources of sourcesBySession.values()) count += sources.size;
  return { sessions: sourcesBySession.size, sources: count };
}

export function clearNativeContextStore(): void {
  sourcesBySession.clear();
  notify();
}
