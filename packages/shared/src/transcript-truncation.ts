/**
 * Where a regenerate / edit-resend cuts the durable transcript.
 *
 * The renderer holds a bounded, deduplicated, display-filtered view of a
 * session, so an index into that array is not a position in the host's
 * transcript. Resolving the boundary by message identity keeps the two honest:
 * the caller names the message it pointed at and the host finds it in the
 * transcript it owns.
 */
export type TranscriptTruncation =
  | { kind: "none" }
  | { kind: "cut"; index: number }
  | { kind: "unknown-message"; messageId: string };

export function resolveTranscriptTruncation(
  messages: ReadonlyArray<{ id?: string }>,
  request: { truncateFromMessageId?: string; truncateBefore?: number },
): TranscriptTruncation {
  const messageId =
    typeof request.truncateFromMessageId === "string"
      ? request.truncateFromMessageId.trim()
      : "";
  if (messageId) {
    const index = messages.findIndex((message) => message?.id === messageId);
    // A boundary the host cannot find must fail loudly: silently falling back to
    // a count would truncate at an arbitrary point and archive the wrong tail.
    return index >= 0 ? { kind: "cut", index } : { kind: "unknown-message", messageId };
  }
  const count = request.truncateBefore;
  if (typeof count === "number" && Number.isFinite(count) && count >= 0) {
    return { kind: "cut", index: Math.min(Math.floor(count), messages.length) };
  }
  return { kind: "none" };
}
