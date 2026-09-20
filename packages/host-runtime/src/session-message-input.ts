import {
  ErrorCodes,
  type AgentPromptRequest,
  type SessionCollaborationMessage,
  type SessionMessageOrigin,
} from "@pi-desktop/shared";

type CollaborationHost = {
  call<T>(method: string, params: Record<string, unknown>): Promise<T>;
};

export type SessionMessageInput = {
  content: string;
  origin: SessionMessageOrigin;
};

/** The subset of a prompt request the ledger lookup needs. */
export type SessionMessagePromptRequest = Pick<
  AgentPromptRequest,
  "sessionId" | "sessionMessageId" | "attachments" | "messageId" | "truncateBefore" | "truncateFromMessageId"
>;

/** Resolve provenance and content only from the host ledger, never a caller. */
export async function resolveSessionMessageInput(
  host: CollaborationHost,
  request: SessionMessagePromptRequest,
): Promise<SessionMessageInput | undefined> {
  if (request.sessionMessageId === undefined) return undefined;
  const messageId = typeof request.sessionMessageId === "string"
    ? request.sessionMessageId.trim()
    : "";
  if (!messageId) {
    throw Object.assign(new Error("A session collaboration message ID is required"), {
      errorCode: ErrorCodes.INVALID_ARGUMENT,
    });
  }
  if (
    request.attachments !== undefined ||
    request.messageId !== undefined ||
    request.truncateBefore !== undefined ||
    request.truncateFromMessageId !== undefined
  ) {
    throw Object.assign(new Error("Session collaboration messages cannot be edited or regenerated"), {
      errorCode: ErrorCodes.INVALID_ARGUMENT,
    });
  }
  const { message } = await host.call<{ message?: SessionCollaborationMessage }>(
    "session.collaboration.message",
    { messageId },
  );
  if (!message || message.id !== messageId) {
    throw Object.assign(new Error("Session collaboration message not found"), {
      errorCode: ErrorCodes.NOT_FOUND,
    });
  }
  if (message.targetSessionId !== request.sessionId) {
    throw Object.assign(new Error("Session collaboration message belongs to another session"), {
      errorCode: ErrorCodes.INVALID_ARGUMENT,
    });
  }
  if (message.status !== "queued") {
    throw Object.assign(new Error("Session collaboration message has already been dispatched or settled"), {
      errorCode: ErrorCodes.CONFLICT,
    });
  }
  return {
    content: message.content,
    origin: {
      messageId: message.id,
      sourceSessionId: message.sourceSessionId,
      sourceTitle: message.sourceTitle,
      targetSessionId: message.targetSessionId,
      kind: message.kind,
      ...(message.replyToMessageId ? { replyToMessageId: message.replyToMessageId } : {}),
    },
  };
}
