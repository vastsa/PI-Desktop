export type ComposerDraftFileReference = {
  path: string;
  name: string;
  /** `agent` is a delegate mention, not a file (see ComposerFileReference). */
  kind?: "image" | "file" | "agent";
  /** Delegate description carried through a draft restore. */
  description?: string;
  mimeType?: string;
  /** Visible inline token for a generated large-text paste reference. */
  token?: string;
};

export type ComposerDraftSnapshot = {
  text: string;
  fileReferences: ComposerDraftFileReference[];
};

export type ComposerPrefill = ComposerDraftSnapshot & {
  sessionId: string;
};

type AbortMessage = {
  role: string;
  content: string;
  /** The text the user typed, when a rewrite expanded `content` (ADR 0024). */
  command?: string;
  thinking?: string;
  steering?: boolean;
};

type SubmittedDraft = {
  messageCountBeforeSend: number;
  draft: ComposerDraftSnapshot;
};

export function resolveComposerSmartStop<T extends AbortMessage>(
  messages: readonly T[],
  submitted?: SubmittedDraft,
):
  | { kind: "restore"; kept: T[]; draft: ComposerDraftSnapshot }
  | { kind: "settle" } {
  let lastUserIndex = -1;
  const userSearchFloor = submitted?.messageCountBeforeSend ?? 0;
  for (let index = messages.length - 1; index >= userSearchFloor; index -= 1) {
    if (messages[index].role === "user") {
      lastUserIndex = index;
      break;
    }
  }

  const tail = lastUserIndex >= 0 ? messages.slice(lastUserIndex + 1) : [];
  const replyStarted = tail.some(
    (message) =>
      message.role === "tool" ||
      (message.role === "assistant" &&
        Boolean(message.content.trim() || message.thinking?.trim())),
  );
  if (
    (lastUserIndex < 0 && !submitted) ||
    replyStarted ||
    messages[lastUserIndex]?.steering
  ) {
    return { kind: "settle" };
  }

  // Without a local snapshot — the turn was started by a path that records
  // none, such as an edit-and-resend — recover the text from the transcript.
  // A rewritten turn keeps the words the user typed in `command` and the
  // expanded prompt in `content` (ADR 0024, ADR 0308), so only `command`
  // belongs back in the composer. An ordinary prompt has no `command`, and its
  // `content` is the text itself.
  const lastUser = lastUserIndex >= 0 ? messages[lastUserIndex] : undefined;
  return {
    kind: "restore",
    kept: lastUserIndex >= 0 ? messages.slice(0, lastUserIndex) : [...messages],
    draft: submitted?.draft ?? {
      text: lastUser ? (lastUser.command ?? lastUser.content) : "",
      fileReferences: [],
    },
  };
}
