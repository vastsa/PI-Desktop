/**
 * What a plugin put in the draft (`docs/plugin-plan/render/draft/`,
 * `docs/plugin-plan/render/attachments/`):
 * - `mark`: a chip showing the reference's `name` that sends `send`;
 * - `fold`: the one chip holding the marks past the per-draft limit, sending
 *   their `send` texts joined by spaces; `pluginId` is the first one's;
 * - `attachment`: a file the plugin staged, owned by it for `attachments.*`.
 * Parts are immutable; a change is a new object.
 */
export type ComposerPluginPart =
  | { readonly kind: "mark"; readonly pluginId: string; readonly send: string }
  | {
      readonly kind: "fold";
      readonly pluginId: string;
      readonly send: string;
      readonly count: number;
    }
  | {
      readonly kind: "attachment";
      readonly pluginId: string;
      readonly id: string;
      readonly size: number;
    };

export type ComposerDraftFileReference = {
  path: string;
  name: string;
  kind?: "image" | "file";
  mimeType?: string;
  /** Visible inline token for a generated large-text paste reference. */
  token?: string;
  plugin?: ComposerPluginPart;
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

  return {
    kind: "restore",
    kept: lastUserIndex >= 0 ? messages.slice(0, lastUserIndex) : [...messages],
    draft: submitted?.draft ?? {
      text: lastUserIndex >= 0 ? messages[lastUserIndex].content : "",
      fileReferences: [],
    },
  };
}
