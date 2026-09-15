/**
 * Message references ("quotes").
 *
 * A quote is plain draft text: the excerpt the user picked plus one attribution
 * line, inserted into the composer of the conversation they are looking at.
 * Quoting never sends, never creates a session, and writes nothing to the
 * transcript, so per-session draft retention and the smart-Stop restore path
 * keep working unchanged (ADR message-quotes-and-side-chats / D-LOCAL-message-quotes).
 */

/** Longest excerpt a quote carries; longer text is cut and marked with an ellipsis. */
export const MAX_QUOTE_CHARS = 2000;

/**
 * The text a quote carries. A non-empty selection wins over the whole message,
 * so quoting a paragraph of a long answer stays a reference to that paragraph.
 */
export function quoteExcerpt(
  messageText: string,
  selection = "",
  limit = MAX_QUOTE_CHARS,
): string {
  const source = selection.trim() ? selection : messageText;
  const normalized = source.replace(/\r\n?/g, "\n").trim();
  if (normalized.length <= limit) return normalized;
  const cut = normalized.slice(0, limit);
  // Never cut between a surrogate pair: the tail would render as a lone glyph.
  const whole = /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
  return `${whole.trimEnd()}…`;
}

/**
 * A Markdown blockquote of the excerpt followed by its attribution. The
 * attribution arrives already translated, which keeps this module free of i18n
 * and directly testable.
 */
export function buildQuoteText(excerpt: string, attribution: string): string {
  const body = quoteExcerpt(excerpt)
    .split("\n")
    .map((line) => (line.trim() ? `> ${line}` : ">"))
    .join("\n");
  return `${body}\n\n${attribution}`;
}

/**
 * Put a quote into an existing draft without discarding what the user already
 * typed: quoting is an addition to the prompt, never a replacement of it.
 */
export function appendQuoteToDraft(draftText: string, quote: string): string {
  const existing = draftText.replace(/\s+$/, "");
  return existing ? `${existing}\n\n${quote}` : quote;
}
