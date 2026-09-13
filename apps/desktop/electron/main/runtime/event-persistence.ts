import { IPC, type AgentEventEnvelope, type UiMessage } from "@pi-desktop/shared";
import type { InflightCheckpointer } from "../inflight-checkpoint";
import type { Logger } from "../logger";
import type { PersistenceOutbox } from "../persistence-outbox";
import type { RuntimeState } from "./context";

export type EventPersistenceDependencies = {
  runtimeState: RuntimeState;
  activeTurns: Map<string, string>;
  activeToolCalls: Map<string, any>;
  activeToolCallKey: (sessionId: string, toolCallId: string) => string;
  approvedExecutionIdsBySession: Map<string, string>;
  approvedExecutionTurns: Map<string, any>;
  pendingExecutionFinishes: Map<string, any>;
  planSubmissionTurnIds: Set<string>;
  planSubmissionTurnKey: (sessionId: string, turnId: string) => string;
  inflightCheckpointer: InflightCheckpointer;
  persistenceOutbox: PersistenceOutbox;
  addActiveTurnUsage: (sessionId: string, usage: any) => void;
  logger: Logger;
  finishTurn: (...args: any[]) => Promise<void>;
  finishApprovedExecution: (...args: any[]) => Promise<void>;
  emitAgentEvent: (envelope: AgentEventEnvelope) => void;
};

export function createEventPersistence({
  runtimeState,
  activeTurns,
  activeToolCalls,
  activeToolCallKey,
  approvedExecutionIdsBySession,
  approvedExecutionTurns,
  pendingExecutionFinishes,
  planSubmissionTurnIds,
  planSubmissionTurnKey,
  inflightCheckpointer,
  persistenceOutbox,
  addActiveTurnUsage,
  logger,
  finishTurn,
  finishApprovedExecution,
  emitAgentEvent,
}: EventPersistenceDependencies): {
  subagentTagged: (message: UiMessage, envelope: AgentEventEnvelope) => UiMessage;
  persistAgentEvent: (envelope: AgentEventEnvelope) => UiMessage | undefined;
} {
function subagentTagged(message: UiMessage, envelope: AgentEventEnvelope): UiMessage {
  if (!envelope.parentToolCallId) return message;
  return {
    ...message,
    parentToolCallId: envelope.parentToolCallId,
    ...(envelope.agentName ? { agentName: envelope.agentName } : {}),
  };
}


function persistAgentEvent(envelope: AgentEventEnvelope): UiMessage | undefined {
  const event = envelope.event;
  const turnId = activeTurns.get(envelope.sessionId);
  const executionId = (() => {
    const candidate = approvedExecutionIdsBySession.get(envelope.sessionId);
    if (!candidate) return undefined;
    if (pendingExecutionFinishes.get(candidate)?.status === "interrupted") {
      return undefined;
    }
    const executionTurn = approvedExecutionTurns.get(candidate);
    return executionTurn?.turnId === (envelope.turnId || turnId)
      ? candidate
      : undefined;
  })();
  if (
    event.type === "planning_state" &&
    event.state === "awaiting_approval" &&
    (envelope.turnId || turnId)
  ) {
    planSubmissionTurnIds.add(
      planSubmissionTurnKey(envelope.sessionId, envelope.turnId || turnId!),
    );
  }
  if (event.type === "message_update" && event.message.role === "assistant") {
    // Checkpoint only the session's own reply (D299). Delegate rows stream in
    // parallel with the parent's and would thrash a per-session checkpoint;
    // their loss on a crash is bounded to the Task call's activity.
    if (!envelope.parentToolCallId) {
      inflightCheckpointer.observe({
        sessionId: envelope.sessionId,
        turnId: envelope.turnId ?? turnId,
        message: event.message,
      });
    }
    return;
  }
  if (event.type === "tool_start") {
    activeToolCalls.set(activeToolCallKey(envelope.sessionId, event.toolCallId), {
      toolName: event.toolName,
      args: event.args,
      createdAt: new Date(envelope.ts).toISOString(),
      turnId: envelope.turnId ?? turnId,
      ...(envelope.parentToolCallId
        ? { parentToolCallId: envelope.parentToolCallId }
        : {}),
      ...(envelope.agentName ? { agentName: envelope.agentName } : {}),
    });
    if (
      (event.toolName === "SubmitPlan" || event.toolName === "SubmitGoal") &&
      (envelope.turnId || turnId)
    ) {
      planSubmissionTurnIds.add(
        planSubmissionTurnKey(envelope.sessionId, envelope.turnId || turnId!),
      );
    }
  }
  if (event.type === "error") {
    // Async provider failures must close the durable turn / scheduled run the
    // same way agent_end does; otherwise they stay 'running' in the DB.
    logger.app("session", "error", "agent turn failed", {
      sessionId: envelope.sessionId,
      code: event.error.code,
      data: {
        message: event.error.message,
        retriable: event.error.retriable,
        details: event.error.details,
      },
    });
    const turnFinalization = finishTurn(
      envelope.sessionId,
      event.error.code === "TURN_ABORTED" ? "aborted" : "error",
      event.error.code,
    );
    if (executionId) {
      void turnFinalization.then(() =>
        finishApprovedExecution(
          executionId,
          "interrupted",
          event.error.code,
        ),
      );
    }
    return;
  }
  if (event.type === "agent_end") {
    const turnFinalization = finishTurn(envelope.sessionId, "completed");
    if (executionId) {
      void turnFinalization.then(() =>
        finishApprovedExecution(executionId, "completed"),
      );
    }
    // Persist the completed branch as the active regenerate revision when the
    // latest user turn carries revision metadata (ChatGPT-style history).
    void (async () => {
      try {
        if (!runtimeState.host) return;
        // The turn's final assistant message may still be in the outbox. Archive
        // a branch that is missing it and the answer is missing from the restored
        // branch forever, so drain first and skip the archive if the host cannot
        // take the writes right now. The yield lets a message_end enqueued in
        // this same event-loop turn reach the queue before it is measured.
        await new Promise<void>((resolve) => setImmediate(resolve));
        for (let attempt = 0; attempt < 3 && persistenceOutbox.size() > 0; attempt += 1) {
          await persistenceOutbox.flush(() => runtimeState.host);
        }
        if (persistenceOutbox.size() > 0) {
          logger.app("persistence", "warn", "skipped regenerate branch archive", {
            sessionId: envelope.sessionId,
            data: { pending: persistenceOutbox.size() },
          });
          return;
        }
        // One host call does the read, the archive and the pager stamp under the
        // RPC lock. The read-modify-write this replaced raced the append above
        // and wrote a stale transcript back over the final message.
        const saved = await runtimeState.host.call<{
          saved?: { root?: any } | null
        }>("session.saveActiveRevision", { sessionId: envelope.sessionId });
        const root = saved.saved?.root;
        if (!root) return;
        emitAgentEvent({
          sessionId: envelope.sessionId,
          ts: Date.now(),
          event: { type: "message_end", message: root },
        } satisfies AgentEventEnvelope);
      } catch (error) {
        logger.app("persistence", "warn", "save active regenerate branch failed", {
          sessionId: envelope.sessionId,
          data: String(error),
        });
      }
    })();
    return;
  }
  if (event.type === "turn_end" && !envelope.parentToolCallId) {
    addActiveTurnUsage(envelope.sessionId, event.subagentUsage);
  }
  if (event.type === "message_end" && event.message.role === "assistant") {
    if (!envelope.parentToolCallId && event.message.usage) {
      addActiveTurnUsage(envelope.sessionId, event.message.usage);
    }
    // Checkpoint the finished snapshot before the outbox append (D327).
    // Settling first dropped the last interval of text, and endTurn used to
    // delete the host file while the final row was still queued.
    if (!envelope.parentToolCallId) {
      const sessionId = envelope.sessionId;
      const finalId = event.message.id;
      inflightCheckpointer.observe({
        sessionId,
        turnId: envelope.turnId ?? turnId,
        message: event.message,
      });
      void inflightCheckpointer.flush(sessionId).finally(() => {
        inflightCheckpointer.settleIf(sessionId, finalId);
      });
    }
    // Empty aborted bubbles are not useful transcript rows. Structured
    // provider failures remain durable assistant messages so their details
    // stay attached to the failed turn after reload.
    const failed =
      event.message.status === "error" || event.message.status === "aborted";
    const empty =
      !(event.message.content || "").trim() &&
      !(event.message.thinking || "").trim();
    if (failed && empty && !event.message.error) return;
    void persistenceOutbox
      .enqueue(
        {
          key: `message:${envelope.sessionId}:${event.message.id}`,
          sessionId: envelope.sessionId,
          message: subagentTagged(event.message, envelope),
          turnId,
        },
        () => runtimeState.host,
      )
      .catch((e) =>
        logger.app("persistence", "warn", "assistant message persistence enqueue failed", {
          sessionId: envelope.sessionId,
          data: String(e),
        }),
      );
  }
  // Runtime settlement refreshes the original Task row through the existing
  // full-message event; persist it as well as updating the live renderer.
  if (event.type === "message_end" && event.message.role === "tool") {
    void persistenceOutbox
      .enqueue(
        {
          key: `message:${envelope.sessionId}:${event.message.id}`,
          sessionId: envelope.sessionId,
          message: subagentTagged(event.message, envelope),
          turnId: envelope.turnId ?? turnId,
        },
        () => runtimeState.host,
      )
      .catch((error) =>
        logger.app("persistence", "warn", "tool snapshot persistence enqueue failed", {
          sessionId: envelope.sessionId,
          data: String(error),
        }),
      );
  }
  if (event.type === "tool_end") {
    const key = activeToolCallKey(envelope.sessionId, event.toolCallId);
    const started = activeToolCalls.get(key);
    activeToolCalls.delete(key);
    const message: UiMessage = {
      id: event.toolCallId,
      role: "tool",
      content:
        typeof event.result === "string"
          ? event.result
          : JSON.stringify(event.result),
      createdAt: started?.createdAt ?? new Date(envelope.ts).toISOString(),
      toolCallId: event.toolCallId,
      toolName: started?.toolName,
      toolArgs: started?.args,
      toolStatus: event.isError ? "error" : "success",
      toolResult: event.result,
      ...(event.toolUsage ? { toolUsage: event.toolUsage } : {}),
      toolCompletedAt: new Date(envelope.ts).toISOString(),
      toolDurationMs: started
        ? Math.max(0, envelope.ts - Date.parse(started.createdAt))
        : undefined,
      isError: event.isError,
      status: "complete",
      ...(started?.parentToolCallId
        ? { parentToolCallId: started.parentToolCallId }
        : {}),
      ...(started?.agentName ? { agentName: started.agentName } : {}),
    };
    void persistenceOutbox
      .enqueue(
        {
          key: `message:${envelope.sessionId}:${event.toolCallId}`,
          sessionId: envelope.sessionId,
          message,
          // A late tool_end belongs to the turn that started the tool, even if
          // another prompt has already opened a newer turn for this session.
          turnId: started?.turnId ?? envelope.turnId ?? turnId,
        },
        () => runtimeState.host,
      )
      .catch((e) =>
        logger.app("persistence", "warn", "tool message persistence enqueue failed", {
          sessionId: envelope.sessionId,
          toolCallId: (event as any).toolCallId,
          data: String(e),
        }),
      );
    return message;
  }
}
  return { subagentTagged, persistAgentEvent };
}
