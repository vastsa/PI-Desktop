import {
  addUsage,
  applyMessageUpdate,
  type AgentEventEnvelope,
  type MessageUsage,
  type UiMessage,
} from "@pi-desktop/shared";

import { InflightCheckpointer } from "./inflight-checkpoint.js";
import { TurnPersistence } from "./turn-persistence.js";

export type TurnEventLogger = (
  level: "info" | "warn" | "error",
  message: string,
  data?: Record<string, unknown>,
) => void;

export type ActiveToolCall = {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  args: unknown;
  createdAt: string;
  startedAtMs: number;
  turnId?: string;
  parentToolCallId?: string;
  agentName?: string;
};

/** What the pipeline needs to know about turn ownership; the runtime service owns it. */
export type TurnOwnership = {
  activeTurnId(sessionId: string): string | undefined;
  /** A root terminal event naming a turn that no longer owns its session. */
  isStaleTerminalEvent(envelope: AgentEventEnvelope): boolean;
  finishTurn(
    sessionId: string,
    status: "completed" | "aborted" | "error",
    errorCode: string | undefined,
    options: { turnId: string },
  ): Promise<void>;
};

export type TurnEventPipelineOptions = {
  getHost: () => { call<T = unknown>(method: string, params?: unknown): Promise<T>; isAvailable?(): boolean } | null;
  ownership: TurnOwnership;
  /** Fan-out of every live event, after the stale-terminal guard. */
  emit: (envelope: AgentEventEnvelope) => void;
  log: TurnEventLogger;
  now?: () => number;
  checkpointIntervalMs?: number;
};

/**
 * The per-event pass of a headless Host: track tool calls, checkpoint the
 * streaming reply (D299), close the turn on its terminal event, and persist
 * every completed row through host-core. The desktop runs the same pass in
 * Electron Main against its file-backed outbox; here the outbox is process
 * memory with a bounded retry, because a `pi-host` ends only with its
 * supervisor.
 */
export class TurnEventPipeline {
  private readonly activeToolCalls = new Map<string, ActiveToolCall>();
  private readonly steeringReplies = new Set<string>();
  private readonly inflightSnapshots = new Map<string, UiMessage>();
  private readonly activeTurnUsages = new Map<string, MessageUsage>();
  private readonly persistence: TurnPersistence;
  private readonly checkpointer: InflightCheckpointer;
  private readonly now: () => number;

  constructor(private readonly options: TurnEventPipelineOptions) {
    this.now = options.now ?? (() => Date.now());
    this.persistence = new TurnPersistence({
      getHost: () => options.getHost(),
      log: (level, message, data) => options.log(level, message, data),
    });
    this.checkpointer = new InflightCheckpointer(
      async (checkpoint) => {
        const host = options.getHost();
        if (!host) return;
        await host.call("session.saveInflightMessage", {
          sessionId: checkpoint.sessionId,
          ...(checkpoint.turnId ? { turnId: checkpoint.turnId } : {}),
          message: checkpoint.message,
        });
      },
      options.checkpointIntervalMs,
      this.now,
    );
  }

  /** The tool call a permission request refers to, if the sidecar announced it. */
  toolCall(sessionId: string, toolCallId: string): ActiveToolCall | undefined {
    return this.activeToolCalls.get(toolKey(sessionId, toolCallId));
  }

  /** Usage accumulated by the session's current turn, then forget it. */
  takeTurnUsage(sessionId: string): MessageUsage | undefined {
    const usage = this.activeTurnUsages.get(sessionId);
    this.activeTurnUsages.delete(sessionId);
    return usage;
  }

  resetTurnUsage(sessionId: string): void {
    this.activeTurnUsages.delete(sessionId);
  }

  /** Write the session's pending reply checkpoint now; the last text before a crash. */
  flushCheckpoint(sessionId: string): Promise<void> {
    return this.checkpointer.flush(sessionId);
  }

  settleCheckpoint(sessionId: string): void {
    this.checkpointer.settle(sessionId);
  }

  /**
   * A host tool can finish shortly after its turn was aborted. Keep the
   * metadata long enough for a late tool_end to persist a readable row, then
   * drop only the calls of that turn.
   */
  scheduleToolCallCleanup(sessionId: string, turnId: string, delayMs = 5 * 60 * 1000): void {
    const prefix = `${sessionId}:`;
    const timer = setTimeout(() => {
      for (const [key, call] of this.activeToolCalls) {
        if (key.startsWith(prefix) && call.turnId === turnId) this.activeToolCalls.delete(key);
      }
    }, delayMs);
    timer.unref?.();
  }

  /** The sidecar died: every open tool call is interrupted and no reply will finish. */
  onSidecarExit(): ActiveToolCall[] {
    const interrupted = [...this.activeToolCalls.values()];
    this.activeToolCalls.clear();
    this.steeringReplies.clear();
    return interrupted;
  }

  pendingWrites(): number {
    return this.persistence.size();
  }

  async dispose(): Promise<void> {
    await this.checkpointer.flushAll();
    this.checkpointer.dispose();
    await this.persistence.flush();
    this.persistence.dispose();
  }

  /** One event from the sidecar: fan it out, then apply its persistence effects. */
  handle(envelope: AgentEventEnvelope): void {
    const event = envelope.event;
    if (event.type === "tool_start") {
      this.activeToolCalls.set(toolKey(envelope.sessionId, event.toolCallId), {
        sessionId: envelope.sessionId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.args,
        createdAt: new Date(envelope.ts).toISOString(),
        startedAtMs: envelope.ts,
        turnId: envelope.turnId ?? this.options.ownership.activeTurnId(envelope.sessionId),
        ...(envelope.parentToolCallId ? { parentToolCallId: envelope.parentToolCallId } : {}),
        ...(envelope.agentName ? { agentName: envelope.agentName } : {}),
      });
    }
    // A terminal event for a turn that no longer owns its session must not
    // clear the current turn's state. Persistence is a separate pass, so the
    // event is still archived as history.
    if (!this.options.ownership.isStaleTerminalEvent(envelope)) this.options.emit(envelope);
    const persisted = this.persist(envelope);
    if (persisted) {
      // Replay the completed tool row through the message_end contract, so a
      // subscriber that missed the original tool_start still gets the row.
      this.options.emit({ ...envelope, event: { type: "message_end", message: persisted } });
    }
  }

  private persist(envelope: AgentEventEnvelope): UiMessage | undefined {
    const event = envelope.event;
    const sessionId = envelope.sessionId;
    const turnId = this.options.ownership.activeTurnId(sessionId);
    const finish = (status: "completed" | "aborted" | "error", errorCode: string | undefined) =>
      this.options.ownership
        .finishTurn(sessionId, status, errorCode, { turnId: envelope.turnId ?? "" })
        .catch((error: unknown) => {
          this.options.log("warn", "turn finalization failed", { sessionId, error: String(error) });
        });
    switch (event.type) {
      case "message_start":
        if (event.message.role === "assistant" && !envelope.parentToolCallId) {
          this.inflightSnapshots.set(sessionId, event.message);
        }
        return;
      case "message_update":
        if (event.message.role === "assistant" && !envelope.parentToolCallId) {
          const message = applyMessageUpdate(this.inflightSnapshots.get(sessionId), event);
          this.inflightSnapshots.set(sessionId, message);
          this.checkpointer.observe({ sessionId, turnId: envelope.turnId ?? turnId, message });
        }
        return;
      case "error":
        this.options.log("error", "agent turn failed", {
          sessionId,
          code: event.error.code,
          message: event.error.message,
          retriable: event.error.retriable,
        });
        if (this.options.ownership.isStaleTerminalEvent(envelope)) return;
        void finish(event.error.code === "TURN_ABORTED" ? "aborted" : "error", event.error.code);
        return;
      case "agent_end":
        if (this.options.ownership.isStaleTerminalEvent(envelope)) return;
        void finish("completed", undefined);
        return;
      case "turn_end":
        if (!envelope.parentToolCallId) this.addTurnUsage(sessionId, event.subagentUsage);
        return;
      case "message_end":
        return this.persistMessageEnd(envelope, event.message, event.precedingAssistant, turnId);
      case "tool_end": {
        const key = toolKey(sessionId, event.toolCallId);
        const started = this.activeToolCalls.get(key);
        this.activeToolCalls.delete(key);
        this.options.log(
          event.isError ? "error" : "info",
          event.isError ? "tool execution failed" : "tool execution completed",
          {
            sessionId,
            turnId: envelope.turnId ?? started?.turnId,
            toolCallId: event.toolCallId,
            toolName: started?.toolName ?? "unknown",
            durationMs: started ? Math.max(0, envelope.ts - started.startedAtMs) : undefined,
          },
        );
        const message: UiMessage = {
          id: event.toolCallId,
          role: "tool",
          content: typeof event.result === "string" ? event.result : JSON.stringify(event.result),
          createdAt: started?.createdAt ?? new Date(envelope.ts).toISOString(),
          toolCallId: event.toolCallId,
          toolName: started?.toolName,
          toolArgs: started?.args,
          toolStatus: event.isError ? "error" : "success",
          toolResult: event.result,
          ...(event.toolUsage ? { toolUsage: event.toolUsage } : {}),
          toolCompletedAt: new Date(envelope.ts).toISOString(),
          toolDurationMs: started ? Math.max(0, envelope.ts - Date.parse(started.createdAt)) : undefined,
          isError: event.isError,
          status: "complete",
          ...(started?.parentToolCallId ? { parentToolCallId: started.parentToolCallId } : {}),
          ...(started?.agentName ? { agentName: started.agentName } : {}),
        };
        void this.persistence.append({
          sessionId,
          message,
          // A late tool_end belongs to the turn that started the tool, even if
          // another prompt has already opened a newer turn for this session.
          turnId: started?.turnId ?? envelope.turnId ?? turnId,
        });
        return message;
      }
      default:
        return;
    }
  }

  private persistMessageEnd(
    envelope: AgentEventEnvelope,
    message: UiMessage,
    precedingAssistant: UiMessage | undefined,
    turnId: string | undefined,
  ): undefined {
    const sessionId = envelope.sessionId;
    if (message.role === "user" && !envelope.parentToolCallId) {
      // Steering input accepted during a stream: reserve the current reply
      // before persisting it, then the user row.
      const preceding = precedingAssistant?.role === "assistant" ? precedingAssistant : undefined;
      if (preceding) this.steeringReplies.add(preceding.id);
      for (const row of [preceding, message]) {
        if (!row) continue;
        void this.persistence.append({ sessionId, message: row, turnId: envelope.turnId ?? turnId });
      }
      return;
    }
    if (message.role === "assistant") {
      if (!envelope.parentToolCallId) {
        if (message.usage) this.addTurnUsage(sessionId, message.usage);
        this.inflightSnapshots.delete(sessionId);
        const finalId = message.id;
        this.checkpointer.observe({ sessionId, turnId: envelope.turnId ?? turnId, message });
        void this.checkpointer.flush(sessionId).finally(() => this.checkpointer.settleIf(sessionId, finalId));
      }
      // Empty aborted bubbles are not useful transcript rows. Structured
      // provider failures remain durable so their details survive a reload.
      const failed = message.status === "error" || message.status === "aborted";
      const empty = !(message.content || "").trim() && !(message.thinking || "").trim();
      const reservedForSteering = this.steeringReplies.delete(message.id);
      if (failed && empty && !message.error && !reservedForSteering) return;
      void this.persistence.append({ sessionId, message: subagentTagged(message, envelope), turnId });
      return;
    }
    if (message.role === "tool") {
      void this.persistence.append({
        sessionId,
        message: subagentTagged(message, envelope),
        turnId: envelope.turnId ?? turnId,
      });
    }
    return;
  }

  private addTurnUsage(sessionId: string, usage: MessageUsage | undefined): void {
    if (!usage) return;
    const next = addUsage(this.activeTurnUsages.get(sessionId), usage);
    if (next) this.activeTurnUsages.set(sessionId, next);
  }
}

function toolKey(sessionId: string, toolCallId: string): string {
  return `${sessionId}:${toolCallId}`;
}

function subagentTagged(message: UiMessage, envelope: AgentEventEnvelope): UiMessage {
  if (!envelope.parentToolCallId) return message;
  return {
    ...message,
    parentToolCallId: envelope.parentToolCallId,
    ...(envelope.agentName ? { agentName: envelope.agentName } : {}),
  };
}
