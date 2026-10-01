import type { AgentEvent, SessionSource } from "@pi-desktop/shared";
import type { AgentSidecar } from "../agent-sidecar";
import type { RemoteHostsBoot } from "../bootstrap/remote-hosts";

type SidecarPort = Pick<AgentSidecar, "onNotification">;
type RemoteEventPort = Pick<RemoteHostsBoot, "subscribeSession">;

export type LiveSessionWorkEvent =
  | { kind: "started"; sessionId: string; turnId: string; idempotencyKey?: string }
  | { kind: "waiting"; sessionId: string; turnId: string; state: "waiting-permission" | "waiting-input"; idempotencyKey?: string }
  | { kind: "terminal"; sessionId: string; turnId: string; status: "completed" | "failed" | "interrupted" | "canceled"; idempotencyKey?: string; resultText?: string; resultMessageId?: string };

export function subscribeLiveSessionEvents(input: {
  sessionId: string;
  source: SessionSource;
  sidecar: SidecarPort | null;
  remoteHosts: RemoteEventPort | null;
  isInterrupted: (sessionId: string, turnId: string) => boolean;
  onEvent: (event: LiveSessionWorkEvent) => void;
}): (() => void) | null {
  if (input.source === "desktop") return null;
  const results = new Map<string, { text: string; messageId?: string }>();
  const onAgentEvent = (sessionId: string, turnId: string | undefined, event: AgentEvent, idempotencyKey?: string, parentToolCallId?: string, agentName?: string) => {
    if (sessionId !== input.sessionId || !turnId) return;
    if (event.type === "agent_start" || event.type === "turn_start") {
      input.onEvent({ kind: "started", sessionId, turnId, ...(idempotencyKey ? { idempotencyKey } : {}) });
      return;
    }
    if (event.type === "message_end" && event.message.role === "assistant" && !parentToolCallId && !agentName) {
      results.set(turnId, {
        text: typeof event.message.content === "string" ? event.message.content : "",
        messageId: event.message.id,
      });
      return;
    }
    if (event.type === "error") {
      const status = input.isInterrupted(sessionId, turnId) ? "interrupted" : "failed";
      const result = results.get(turnId);
      input.onEvent({ kind: "terminal", sessionId, turnId, status, ...(idempotencyKey ? { idempotencyKey } : {}), ...(result?.text ? { resultText: result.text } : {}), ...(result?.messageId ? { resultMessageId: result.messageId } : {}) });
      results.delete(turnId);
      return;
    }
    if (event.type === "agent_end") {
      const status = input.isInterrupted(sessionId, turnId) ? "interrupted" : "completed";
      const result = results.get(turnId);
      input.onEvent({ kind: "terminal", sessionId, turnId, status, ...(idempotencyKey ? { idempotencyKey } : {}), ...(result?.text ? { resultText: result.text } : {}), ...(result?.messageId ? { resultMessageId: result.messageId } : {}) });
      results.delete(turnId);
    }
  };

  if (input.source === "pi-native") {
    if (!input.sidecar) return null;
    return input.sidecar.onNotification((method, params) => {
      if (method !== "native.agent.event" || !isRecord(params) || params.sessionId !== input.sessionId || typeof params.turnId !== "string") return;
      const event = params.event;
      if (!isRecord(event) || typeof event.type !== "string") return;
      onAgentEvent(input.sessionId, params.turnId, event as unknown as AgentEvent);
    });
  }

  if (!input.remoteHosts) return null;
  return input.remoteHosts.subscribeSession(input.sessionId, (envelope) => {
    if (envelope.sessionId !== input.sessionId || typeof envelope.turnId !== "string") return;
    const turn = record(envelope.payload)?.turn;
    const idempotencyKey = typeof record(turn)?.idempotencyKey === "string" ? record(turn)?.idempotencyKey as string : undefined;
    const event = record(envelope.payload)?.event;
    // Remote terminal events have an authoritative RACP kind. Only consume
    // completed message items from the embedded AgentEvent to avoid reporting
    // `agent_end` and `turn.completed` twice for the same turn.
    if (isRecord(event) && event.type === "message_end") {
      onAgentEvent(input.sessionId, envelope.turnId, event as unknown as AgentEvent, idempotencyKey, envelope.parentToolCallId, envelope.agentName);
    }
    if (envelope.kind === "turn.started") {
      input.onEvent({ kind: "started", sessionId: input.sessionId, turnId: envelope.turnId, ...(idempotencyKey ? { idempotencyKey } : {}) });
    } else if (envelope.kind === "approval.requested") {
      input.onEvent({ kind: "waiting", sessionId: input.sessionId, turnId: envelope.turnId, state: "waiting-permission", ...(idempotencyKey ? { idempotencyKey } : {}) });
    } else if (envelope.kind === "input.requested") {
      input.onEvent({ kind: "waiting", sessionId: input.sessionId, turnId: envelope.turnId, state: "waiting-input", ...(idempotencyKey ? { idempotencyKey } : {}) });
    } else if (envelope.kind === "approval.resolved" || envelope.kind === "input.resolved") {
      input.onEvent({ kind: "started", sessionId: input.sessionId, turnId: envelope.turnId, ...(idempotencyKey ? { idempotencyKey } : {}) });
    } else if (envelope.kind === "turn.completed" || envelope.kind === "turn.failed" || envelope.kind === "turn.interrupted" || envelope.kind === "turn.canceled") {
      const status = envelope.kind === "turn.completed"
        ? "completed"
        : envelope.kind === "turn.failed"
          ? "failed"
          : envelope.kind === "turn.interrupted"
            ? "interrupted"
            : "canceled";
      const result = results.get(envelope.turnId);
      input.onEvent({ kind: "terminal", sessionId: input.sessionId, turnId: envelope.turnId, status, ...(idempotencyKey ? { idempotencyKey } : {}), ...(result?.text ? { resultText: result.text } : {}), ...(result?.messageId ? { resultMessageId: result.messageId } : {}) });
      results.delete(envelope.turnId);
    }
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}
