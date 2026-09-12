import type {
  AgentPromptAttachment,
  AgentPromptResponse,
  AgentSteerRequest,
  UiMessage,
} from "@pi-desktop/shared";
import type { ComposerDraftSnapshot } from "./composer-smart-stop.ts";
import { optimisticUserMessage } from "./session-transcript.ts";

export function promptAttachmentsFromDraft(
  references: ComposerDraftSnapshot["fileReferences"],
): AgentPromptAttachment[] {
  return references.flatMap((reference) => {
    const kind =
      reference.kind ??
      (/\.(avif|bmp|gif|heic|jpe?g|png|tiff?|webp)$/i.test(reference.path)
        ? "image"
        : "file");
    // Inline chips use tokens for both files and images. Ordinary file chips
    // already serialize to @path text (the model can Read them); only image
    // chips need the structured transport for vision/fallback handling.
    if (reference.token && kind !== "image") return [];
    return [
      {
        path: reference.path,
        name: reference.name,
        kind,
        ...(reference.mimeType ? { mimeType: reference.mimeType } : {}),
      },
    ];
  });
}

type SteeringTarget = {
  sessionId?: string | null;
  turnId?: string;
  running: boolean;
  approvalPending: boolean;
};

type SteeringPorts = {
  request: (request: AgentSteerRequest) => Promise<AgentPromptResponse>;
  insert: (sessionId: string, message: UiMessage) => void;
  retract: (sessionId: string, message: UiMessage) => void;
  reportError: (error?: unknown) => void;
};

/** Own admission, optimistic rows and Stop protection for steering submissions. */
export class SteeringSubmissions {
  private readonly ids = new Map<string, Set<string>>();
  private readonly ports: SteeringPorts;

  constructor(ports: SteeringPorts) {
    this.ports = ports;
  }

  hasInput(sessionId: string): boolean {
    return Boolean(this.ids.get(sessionId)?.size);
  }

  settle(sessionId: string): void {
    this.ids.delete(sessionId);
  }

  async submit(
    content: string,
    draft: ComposerDraftSnapshot | undefined,
    target: SteeringTarget,
  ): Promise<boolean> {
    const { sessionId, turnId: expectedTurnId } = target;
    if (!sessionId || !expectedTurnId || !target.running || target.approvalPending) {
      this.ports.reportError();
      return false;
    }
    const message = optimisticUserMessage(crypto.randomUUID(), content, draft?.fileReferences ?? []);
    this.ports.insert(sessionId, message);
    const ids = this.ids.get(sessionId) ?? new Set<string>();
    ids.add(message.id);
    this.ids.set(sessionId, ids);
    try {
      await this.ports.request({
        sessionId, expectedTurnId, content, messageId: message.id,
        attachments: draft ? promptAttachmentsFromDraft(draft.fileReferences) : [],
      });
      return true;
    } catch (error) {
      this.ports.retract(sessionId, message);
      ids.delete(message.id);
      if (!ids.size && this.ids.get(sessionId) === ids) this.ids.delete(sessionId);
      this.ports.reportError(error);
      return false;
    }
  }
}
