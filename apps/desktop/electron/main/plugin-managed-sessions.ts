import { randomUUID } from "node:crypto";
import type { AgentPromptRequest } from "@pi-desktop/shared";
import {
  prepareManagedPromptAttachments,
  type PreparedManagedAttachment,
} from "./prompt-attachments";

export type ManagedSessionDependencies = {
  owner: (sessionId: string) => Promise<string | null>;
  /**
   * The session's project path, used to resolve a project-relative attachment.
   * A managed room transcript binds no project, so this is normally undefined
   * and every attachment arrives from the session scratch root.
   */
  projectPath: (sessionId: string) => Promise<string | undefined>;
  submit: (
    pluginId: string,
    input: {
      sessionId: string;
      messageId: string;
      content: string;
      attachments: PreparedManagedAttachment[];
    },
  ) => Promise<void>;
  /** Root of the host data directory; attachments are stored under it. */
  dataDir: string;
};

/** Ownership is persisted by Rust; failure never falls back to local execution. */
export function createManagedSessionRouter(dependencies: ManagedSessionDependencies) {
  const pending = new Set<string>();
  return {
    async rejectAgentOperation(sessionId: string): Promise<void> {
      if (await dependencies.owner(sessionId)) {
        throw Object.assign(new Error("This session is managed by a plugin"), { errorCode: "PLUGIN_SESSION_MANAGED" });
      }
    },
    async prompt(request: AgentPromptRequest): Promise<{ accepted: true; turnId: string; managed: true } | null> {
      const pluginId = await dependencies.owner(request.sessionId);
      if (!pluginId) return null;
      // Voice input stays unsupported: a managed transcript has no turn to
      // attribute a transcription to. Attachments are supported — they are
      // stored content-addressed and handed to the owning plugin as descriptors.
      if (request.voiceOrigin) {
        throw Object.assign(new Error("Managed sessions do not accept voice input"), { errorCode: "UNSUPPORTED" });
      }
      if (pending.has(request.sessionId)) {
        throw Object.assign(new Error("A managed session submission is already pending"), { errorCode: "BUSY" });
      }
      const attachments = await prepareManagedPromptAttachments(
        dependencies.dataDir,
        request.sessionId,
        await dependencies.projectPath(request.sessionId),
        request.attachments ?? [],
        request.content,
      );
      const messageId = request.messageId ?? randomUUID();
      pending.add(request.sessionId);
      try {
        await dependencies.submit(pluginId, {
          sessionId: request.sessionId,
          messageId,
          content: request.content,
          attachments,
        });
        return { accepted: true, turnId: messageId, managed: true };
      } finally {
        pending.delete(request.sessionId);
      }
    },
  };
}
