/** Renderer-only conversation excerpts attached to a composer draft. */
export type ComposerExcerpt = { id: string; text: string };

/** Keep the visible prompt first; the selected source follows as quoted context. */
export function serializeComposerExcerpts(
  prompt: string,
  excerpts: readonly ComposerExcerpt[],
): string {
  if (!excerpts.length) return prompt;
  const blocks = excerpts.map(({ text }, index) => {
    const quoted = text.trim().split(/\r?\n/).map((line) => line ? `> ${line}` : ">").join("\n");
    return excerpts.length > 1 ? `${index + 1}.\n${quoted}` : quoted;
  });
  const context = `Selected conversation ${excerpts.length === 1 ? "excerpt" : "excerpts"}:\n${blocks.join("\n\n")}`;
  return prompt.trim() ? `${prompt}\n\n${context}` : context;
}
