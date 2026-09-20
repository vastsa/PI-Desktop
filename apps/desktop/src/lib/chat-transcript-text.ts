/**
 * Text readings of a transcript, for the right-click menu's clipboard actions.
 *
 * A conversation is not one string: the transcript holds user turns, assistant
 * turns, and the tool/system rows that carry their own state. "Copy
 * conversation" means what a user would paste into a document — the readable
 * dialogue — so tool and system rows are skipped rather than dumped as raw
 * payloads. Each block keeps its turn text exactly as stored, so code fences and
 * quoting survive the copy.
 */

/** The part of a transcript message this module reads. */
export type TranscriptTextMessage = {
  role: string;
  content?: string;
};

export type TranscriptSpeakerLabels = {
  user: string;
  assistant: string;
};

/**
 * One labelled block per speaking turn, separated by a blank line. Returns an
 * empty string when the conversation holds no user or assistant text, which
 * callers use to disable the action instead of copying nothing.
 */
export function conversationPlainText(
  messages: readonly TranscriptTextMessage[],
  labels: TranscriptSpeakerLabels,
): string {
  const blocks: string[] = [];
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    const text = (message.content ?? "").trim();
    if (!text) continue;
    const speaker =
      message.role === "user" ? labels.user : labels.assistant;
    blocks.push(`${speaker}:\n${text}`);
  }
  return blocks.join("\n\n");
}

/**
 * Copy prefers a live selection over the whole turn. A collapsed caret is not
 * a selection, so it falls through to the fallback rather than writing "".
 * The excerpt is copied as selected, including surrounding whitespace.
 */
export function copySelectionOrFallback(
  selection: string | undefined,
  fallback: string,
): string {
  return selection ? selection : fallback;
}
