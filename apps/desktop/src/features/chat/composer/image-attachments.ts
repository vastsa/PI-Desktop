import type { ComposerFileReference } from "./model";

export function isImageReference(reference: ComposerFileReference): boolean {
  return reference.kind === "image" || Boolean(reference.mimeType?.toLowerCase().startsWith("image/"));
}

/**
 * Keep images visible as inline chips when a draft enters the editor. A draft
 * cached before images became chips, a restored queue entry, or a prefill can
 * name an image without a token, so every image gets one and the text carries
 * it; appending in reference order keeps the attachment next to the draft.
 */
export function attachImageTokens(
  text: string,
  references: ComposerFileReference[],
  nextToken: () => string,
): { text: string; references: ComposerFileReference[] } {
  let nextText = text;
  const nextReferences = references.map((reference) => {
    if (!isImageReference(reference)) return reference;
    const token = reference.token ?? nextToken();
    if (!nextText.includes(token)) nextText += token;
    return reference.token ? reference : { ...reference, token };
  });
  return { text: nextText, references: nextReferences };
}
