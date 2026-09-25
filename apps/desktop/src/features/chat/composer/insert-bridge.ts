/**
 * Renderer-internal bridge for the `composer.insertText` outbound action.
 *
 * The composer is renderer-local, so the dispatch relay routes that action
 * here instead of through the main process. The composer registers its
 * insertion implementation on mount and clears it on unmount; with no
 * composer mounted the relay answers `PLUGIN_ACTION_NO_COMPOSER`.
 */

type ComposerInsert = (text: string) => void;

let handler: ComposerInsert | null = null;

/** Called by the composer when it can accept draft insertions. */
export function registerComposerInsert(fn: ComposerInsert | null): void {
  handler = fn;
}

/** Returns false when no composer is mounted to receive the text. */
export function insertComposerText(text: string): boolean {
  if (!handler) return false;
  handler(text);
  return true;
}

/** Test seam. */
export function resetComposerInsertBridge(): void {
  handler = null;
}
