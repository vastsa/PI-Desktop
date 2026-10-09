import { randomUUID } from "node:crypto";
import type { AgentPromptRequest } from "@pi-desktop/shared";

export type ManagedSessionDependencies = {
  owner: (sessionId: string) => Promise<string | null>;
  submit: (pluginId: string, input: { sessionId: string; messageId: string; content: string }) => Promise<void>;
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
      if (request.attachments?.length || request.voiceOrigin) {
        throw Object.assign(new Error("Managed sessions currently accept text only"), { errorCode: "UNSUPPORTED" });
      }
      if (pending.has(request.sessionId)) {
        throw Object.assign(new Error("A managed session submission is already pending"), { errorCode: "BUSY" });
      }
      const messageId = request.messageId ?? randomUUID();
      pending.add(request.sessionId);
      try {
        await dependencies.submit(pluginId, { sessionId: request.sessionId, messageId, content: request.content });
        return { accepted: true, turnId: messageId, managed: true };
      } finally {
        pending.delete(request.sessionId);
      }
    },
  };
}
