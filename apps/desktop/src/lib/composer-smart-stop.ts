export type ComposerDraftFileReference = {
  path: string;
  name: string;
  kind?: "image" | "file";
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
  thinking?: string;
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
  if ((lastUserIndex < 0 && !submitted) || replyStarted) {
    return { kind: "settle" };
  }

  return {
    kind: "restore",
    kept: lastUserIndex >= 0 ? messages.slice(0, lastUserIndex) : [...messages],
    draft: submitted?.draft ?? {
      text: lastUserIndex >= 0 ? messages[lastUserIndex].content : "",
      fileReferences: [],
    },
  };
}
