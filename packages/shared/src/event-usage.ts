import type { AgentEventEnvelope } from "./types/agent.js";
import type { MessageUsage } from "./types/messages.js";
import { addUsage, withUsageIdentity } from "./message-usage.js";

/** Physical identities, not tool ancestry, determine accounting ownership. */
export function usageForEvent(envelope: AgentEventEnvelope): MessageUsage | undefined {
  const event = envelope.event;
  if (event.type === "usage") return event.usage;
  if (event.type === "tool_end") {
    const result = event.result;
    if (!result || typeof result !== "object" || !("details" in result)) return undefined;
    const details = result.details;
    if (!details || typeof details !== "object" || !("operations" in details) || !Array.isArray(details.operations)) return undefined;
    let total: MessageUsage | undefined;
    for (const operation of details.operations) {
      const usage: unknown = operation?.usage;
      if (!usage || typeof usage !== "object" || !("operationId" in usage) || typeof usage.operationId !== "string" || !usage.operationId) continue;
      if (!["inputTokens", "outputTokens", "totalTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens"].every(key => {
        const count = (usage as Record<string, unknown>)[key];
        if (count === undefined && !["inputTokens", "outputTokens", "totalTokens"].includes(key)) return true;
        return typeof count === "number" && Number.isSafeInteger(count) && count >= 0;
      })) continue;
      total = addUsage(total, usage as MessageUsage);
    }
    return total;
  }
  if (event.type === "turn_end") return event.subagentUsage;
  if (event.type !== "message_end" || event.message.role !== "assistant") return undefined;
  return withUsageIdentity(event.message.usage, {
    operationId: `message:${envelope.sessionId}:${event.message.id}`,
    usageOrigin: "legacy",
    providerId: event.message.providerId,
    modelId: event.message.modelId,
  });
}

export function ownsUsageTurn(envelope: AgentEventEnvelope, activeTurnId: string | undefined): boolean {
  return activeTurnId !== undefined && (envelope.turnId === undefined || envelope.turnId === activeTurnId);
}
