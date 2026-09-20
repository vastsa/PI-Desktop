import type { ComposerFileReference } from "./model";

export function isImageReference(reference: ComposerFileReference): boolean {
  return reference.kind === "image" || Boolean(reference.mimeType?.toLowerCase().startsWith("image/"));
}

/** Keep images outside editable text, including restored inline-image drafts. */
export function detachImageTokens(text: string, references: ComposerFileReference[], caret: number) {
  let nextText = text;
  let nextCaret = caret;
  const nextReferences = references.map((reference) => {
    if (!isImageReference(reference) || !reference.token) return reference;
    const { token, ...attachment } = reference;
    let index = nextText.indexOf(token);
    while (index !== -1) {
      if (index < nextCaret) nextCaret -= Math.min(token.length, nextCaret - index);
      nextText = nextText.slice(0, index) + nextText.slice(index + token.length);
      index = nextText.indexOf(token);
    }
    return attachment;
  });
  return { text: nextText, references: nextReferences, caret: nextCaret };
}
