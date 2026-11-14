import type { AgentEventEnvelope } from "@pi-desktop/shared";

/** Display metadata only; execution authority remains with the Host claim. */
export function withTranscriptTurnId(envelope: AgentEventEnvelope): AgentEventEnvelope {
  const { event, turnId } = envelope;
  if (turnId && (event.type === "message_start" || event.type === "message_update" ||
    event.type === "message_end" || event.type === "user_message_persisted")) {
    return { ...envelope, event: { ...event, message: { ...event.message, turnId } } };
  }
  return envelope;
}
