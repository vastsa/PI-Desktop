/** Visible composer text alongside the model-facing content of a user message. */
export type ComposerPromptDisplay = {
  content: string;
  references: Array<{
    start: number;
    end: number;
    pluginId: string;
    providerId: string;
    refId: string;
    label: string;
  }>;
};

/** Reject malformed spans instead of hiding arbitrary parts of a transcript. */
export function parseComposerPromptDisplay(value: unknown): ComposerPromptDisplay | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<ComposerPromptDisplay>;
  if (typeof candidate.content !== "string" || candidate.content.length > 1_000_000 || !Array.isArray(candidate.references) || (!candidate.references.length || candidate.references.length > 64)) return undefined;
  let end = 0;
  for (const reference of candidate.references) {
    if (!reference || !Number.isInteger(reference.start) || !Number.isInteger(reference.end) || reference.start < end || reference.end <= reference.start || reference.end > candidate.content.length || typeof reference.pluginId !== "string" || typeof reference.providerId !== "string" || typeof reference.refId !== "string" || typeof reference.label !== "string" || candidate.content.slice(reference.start, reference.end) !== reference.label) return undefined;
    end = reference.end;
  }
  return { content: candidate.content, references: candidate.references };
}
