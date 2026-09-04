import type { ComposerDraftSnapshot } from "./composer-smart-stop";

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

const cache = new Map<string, ComposerDraftSnapshot>();

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
): ComposerDraftSnapshot {
  const owner = draftOwnerSessionId(key);
  return {
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
  };
}

export function readComposerDraft(key: string): ComposerDraftSnapshot | undefined {
  return cache.get(key);
}

export function writeComposerDraft(
  key: string,
  snapshot: ComposerDraftSnapshot,
): void {
  cache.set(key, snapshot);
}

export function captureComposerDraft(
  key: string,
  text: string,
  fileReferences: readonly ComposerDraftFileInput[],
): ComposerDraftSnapshot {
  const snapshot = snapshotComposerDraft(text, fileReferences, key);
  cache.set(key, snapshot);
  return snapshot;
}

export function deleteComposerDraft(key: string): void {
  cache.delete(key);
}

export function pruneComposerDrafts(keep: Iterable<string>): void {
  const retain = new Set(keep);
  for (const key of cache.keys()) {
    if (!retain.has(key)) cache.delete(key);
  }
}

/** Test-only: drop every slot so cases cannot leak into one another. */
export function resetComposerDraftCache(): void {
  cache.clear();
}
