import type { ComposerDraftSnapshot } from "./composer-smart-stop";
import type { ComposerExcerpt } from "./composer-excerpts";

type CachedComposerDraft = ComposerDraftSnapshot & {
  /** Workspace that owned relative file references when the draft was captured. */
  workspacePath?: string;
};

/**
 * Renderer-memory composer drafts (D301).
 *
 * The cache is module-scoped rather than a Composer `useRef` so a remount —
 * empty-home ↔ docked, chat ↔ Settings/Plugins, or the window hiding and
 * showing — restores the same session slot instead of starting empty.
 * Nothing here is written to disk; a full renderer reload still starts blank,
 * matching the in-memory contract in the component spec.
 */
export const HOME_DRAFT_KEY = "__home__";

export type ComposerDraftFileInput = {
  sessionId?: string;
  path: string;
  name: string;
  kind?: "image" | "file";
  mimeType?: string;
  token?: string;
};

const cache = new Map<string, CachedComposerDraft>();
const revisions = new Map<string, number>();
let revisionCounter = 0;

export function draftKeyForSession(sessionId: string | null | undefined): string {
  return sessionId ?? HOME_DRAFT_KEY;
}

/** Session id stored on file-reference rows for this cache key. */
export function draftOwnerSessionId(key: string): string {
  return key === HOME_DRAFT_KEY ? "" : key;
}

export function snapshotComposerDraft(
  text: string,
  fileReferences: readonly ComposerDraftFileInput[],
  key: string,
  workspacePath?: string,
  excerpts: readonly ComposerExcerpt[] = [],
): CachedComposerDraft {
  const owner = draftOwnerSessionId(key);
  const snapshot: CachedComposerDraft = {
    text,
    fileReferences: fileReferences
      .filter((fileReference) => (fileReference.sessionId ?? "") === owner)
      .map(({ path, name, kind, mimeType, token }) => ({
        path,
        name,
        kind,
        ...(mimeType ? { mimeType } : {}),
        ...(token ? { token } : {}),
      })),
    excerpts: excerpts.map((excerpt) => ({ ...excerpt })),
  };
  if (workspacePath !== undefined) snapshot.workspacePath = workspacePath;
  return snapshot;
}

export function readComposerDraft(key: string): CachedComposerDraft | undefined {
  return cache.get(key);
}

/** Read a stable per-key version, assigning a unique baseline when first seen. */
export function readComposerDraftRevision(key: string): number {
  let revision = revisions.get(key);
  if (revision === undefined) {
    revision = ++revisionCounter;
    revisions.set(key, revision);
  }
  return revision;
}

/** Mark a real draft edit with a globally unique, monotonically increasing version. */
export function markComposerDraftEdited(key: string): number {
  const revision = ++revisionCounter;
  revisions.set(key, revision);
  return revision;
}

export function writeComposerDraft(
  key: string,
  snapshot: ComposerDraftSnapshot,
  workspacePath?: string,
): void {
  const existing = cache.get(key);
  const next: CachedComposerDraft = {
    ...snapshot,
    fileReferences: snapshot.fileReferences.map((reference) => ({ ...reference })),
    excerpts: snapshot.excerpts?.map((excerpt) => ({ ...excerpt })) ?? [],
  };
  if (workspacePath !== undefined) {
    next.workspacePath = workspacePath;
  } else if (existing?.workspacePath !== undefined && next.workspacePath === undefined) {
    next.workspacePath = existing.workspacePath;
  }
  cache.set(key, next);
}

export function captureComposerDraft(
  key: string,
  text: string,
  fileReferences: readonly ComposerDraftFileInput[],
  workspacePath?: string,
  excerpts: readonly ComposerExcerpt[] = [],
): CachedComposerDraft {
  const snapshot = snapshotComposerDraft(text, fileReferences, key, workspacePath, excerpts);
  cache.set(key, snapshot);
  return snapshot;
}

/** Append to the session's in-memory draft even when its Composer is unmounted. */
export function appendComposerDraftExcerpt(key: string, text: string): ComposerExcerpt | null {
  const source = text.trim();
  if (!source) return null;
  const excerpt = { id: crypto.randomUUID(), text: source };
  const current = cache.get(key) ?? { text: "", fileReferences: [] };
  writeComposerDraft(key, {
    ...current,
    excerpts: [...(current.excerpts ?? []), excerpt],
  });
  markComposerDraftEdited(key);
  return excerpt;
}

export function deleteComposerDraft(key: string): void {
  cache.delete(key);
}

/**
 * Session that should receive the home draft after New Task / materialize.
 *
 * The Composer persists the outgoing `__home__` slot on every key change, which
 * would otherwise put the typed text back after the store has already moved it.
 * `flushScheduledHomeDraftAdopt` runs after that persist so the live snapshot
 * lands on the new session and the home slot stays empty.
 */
let scheduledHomeAdoptSessionId: string | null = null;

/**
 * Move typed home-composer content onto a session that was just created.
 *
 * New Task reveals the empty home before `session.create` returns, so any
 * keystrokes in that interval land in the home slot. They belong to the new
 * session, not to a later startup draft. A non-empty home snapshot wins over
 * an earlier copy of the same slot.
 */
export function adoptHomeDraftForSession(sessionId: string): void {
  if (!sessionId) return;
  const home = cache.get(HOME_DRAFT_KEY);
  cache.delete(HOME_DRAFT_KEY);
  if (!home) return;
  if (!home.text && home.fileReferences.length === 0 && !home.excerpts?.length) return;
  writeComposerDraft(sessionId, home);
}

export function scheduleHomeDraftAdopt(sessionId: string): void {
  if (!sessionId) return;
  scheduledHomeAdoptSessionId = sessionId;
  adoptHomeDraftForSession(sessionId);
}

export function flushScheduledHomeDraftAdopt(sessionId: string): void {
  if (!sessionId || scheduledHomeAdoptSessionId !== sessionId) return;
  scheduledHomeAdoptSessionId = null;
  adoptHomeDraftForSession(sessionId);
}

export function pruneComposerDrafts(keep: Iterable<string>): void {
  const retain = new Set(keep);
  for (const key of cache.keys()) {
    if (!retain.has(key)) cache.delete(key);
  }
  for (const key of revisions.keys()) {
    if (!retain.has(key)) revisions.delete(key);
  }
}

/** Test-only: drop every slot so cases cannot leak into one another. */
export function resetComposerDraftCache(): void {
  cache.clear();
  revisions.clear();
  scheduledHomeAdoptSessionId = null;
}
