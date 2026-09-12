import {
  ErrorCodes,
  type AgentEventEnvelope,
  type AgentPromptResponse,
  type AgentSteerRequest,
  type UiMessage,
} from "@pi-desktop/shared";
import { appendPromptFallbackPaths, durableUserMessageId, preparePromptAttachments } from "./prompt-attachments.ts";
import type { HostProcess } from "./host-process.ts";
import type { PersistenceOutbox } from "./persistence-outbox.ts";

type Backend = {
  call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
};

type SteeringOptions = {
  host: Backend | null;
  sidecar: Backend | null;
  dataDir: string;
  activeTurn: (sessionId: string) => string | undefined;
  isFinalizing: (sessionId: string) => boolean;
};

/** Admit input to the existing runtime after validating the active turn's attachments. */
export async function steerActiveTurn(
  req: AgentSteerRequest,
  options: SteeringOptions,
): Promise<AgentPromptResponse> {
  const { host, sidecar, dataDir } = options;
  if (!host || !sidecar) throw new Error("backend unavailable");
  if (!req?.sessionId || typeof req.content !== "string" || !req.expectedTurnId ||
      (!req.content.trim() && !req.attachments?.length)) {
    throw Object.assign(new Error("Steering input and expectedTurnId required"), { errorCode: ErrorCodes.INVALID_ARGUMENT });
  }
  if (options.activeTurn(req.sessionId) !== req.expectedTurnId || options.isFinalizing(req.sessionId)) {
    throw Object.assign(new Error("The target turn has ended"), { errorCode: ErrorCodes.TURN_NOT_FOUND });
  }
  const context = await sidecar.call<{ projectPath?: string; supportsVision: boolean }>(
    "agent.steeringContext", { sessionId: req.sessionId, expectedTurnId: req.expectedTurnId },
  );
  const prepared = await preparePromptAttachments(
    dataDir, req.sessionId, context.projectPath, req.attachments ?? [], context.supportsVision,
  );
  const session = await host.call<{ session?: { messages?: UiMessage[] } }>("session.get", {
    id: req.sessionId, messageLimit: 1,
  });
  const message: UiMessage = {
    id: durableUserMessageId(req.messageId, session.session?.messages ?? []),
    role: "user", content: req.content, status: "complete", createdAt: new Date().toISOString(),
    ...(prepared.length ? { attachments: prepared.map((attachment) => attachment.message) } : {}),
  };
  // Revalidate inside the runtime after all file/host IO. A stale target must
  // never turn into a normal prompt or alter the next turn's configuration.
  return sidecar.call<{ accepted: boolean; turnId: string }>("agent.steer", {
    sessionId: req.sessionId, expectedTurnId: req.expectedTurnId, message,
    content: appendPromptFallbackPaths(req.content, prepared),
    attachments: prepared.filter((attachment) => attachment.inlineData).map((attachment) => ({
      path: attachment.message.ref, name: attachment.message.name, kind: attachment.message.kind,
      mimeType: attachment.message.mimeType, size: attachment.message.size, data: attachment.inlineData,
    })),
  });
}

/** Own provisional reply reservations and their persistence lifecycle. */
export class SteeringTranscript {
  private readonly reservedReplies = new Set<string>();
  private readonly outbox: Pick<PersistenceOutbox, "enqueue">;
  private readonly getHost: () => HostProcess | null;
  private readonly onError: (message: string, sessionId: string, error: unknown) => void;

  constructor(
    outbox: Pick<PersistenceOutbox, "enqueue">,
    getHost: () => HostProcess | null,
    onError: (message: string, sessionId: string, error: unknown) => void,
  ) {
    this.outbox = outbox;
    this.getHost = getHost;
    this.onError = onError;
  }

  persistInput(envelope: AgentEventEnvelope, fallbackTurnId?: string): void {
    const event = envelope.event;
    if (event.type !== "message_end" || event.message.role !== "user" || envelope.parentToolCallId) return;
    const persist = (message: UiMessage) => {
      void this.outbox.enqueue({
        key: `message:${envelope.sessionId}:${message.id}`,
        sessionId: envelope.sessionId, message, turnId: envelope.turnId ?? fallbackTurnId,
      }, this.getHost).catch((error) => this.onError("steering transcript enqueue failed", envelope.sessionId, error));
    };
    // Reserve the live reply's position; its final snapshot updates that row.
    if (event.precedingAssistant?.role === "assistant") {
      this.reservedReplies.add(event.precedingAssistant.id);
      persist(event.precedingAssistant);
    }
    persist(event.message);
  }

  settleReply(messageId: string): boolean {
    return this.reservedReplies.delete(messageId);
  }

  clear(): void {
    this.reservedReplies.clear();
  }
}
