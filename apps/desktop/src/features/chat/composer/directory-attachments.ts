import type { ComposerFileReference } from "./model";

/** Restore older input-history and queued drafts with inline directory tokens. */
export function detachDirectoryTokens(
  text: string,
  references: ComposerFileReference[],
): { text: string; references: ComposerFileReference[] } {
  const nextReferences = references.flatMap((reference) => {
    if (reference.kind !== "directory" || !reference.token) return [reference];
    if (!text.includes(reference.token)) return [];
    text = text.replaceAll(reference.token, "");
    const { token: _token, ...directory } = reference;
    return [directory];
  });
  return { text, references: nextReferences };
}
