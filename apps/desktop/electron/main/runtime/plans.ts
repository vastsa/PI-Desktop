import { ErrorCodes, IPC, type AgentEventEnvelope, type AppNotification, type PlanExecution, type PlanExecutionFinishStatus, type UiMessage } from "@pi-desktop/shared";
import { executionFromResponse, executionListFromResponse, planExecutionFromUnknown } from "../plan-execution";
import type { RuntimeState } from "./context";

export type PlanRuntimeState = {
  approvedExecutionDrain: Promise<void> | null;
};

export type PlanRuntimeDependencies = {
  runtimeState: RuntimeState;
  planState: PlanRuntimeState;
  logger: { app: (...args: any[]) => void };
  sendToRenderer: (channel: string, payload: unknown) => void;
  activeTurns: Map<string, string>;
  activeTurnUsages: Map<string, any>;
  scheduledRunsBySession: Map<string, string>;
  activeToolCalls: Map<string, any>;
  turnFinalizations: Map<string, Promise<void>>;
  turnSettlements: Map<string, Set<() => void>>;
  planSubmissionTurnIds: Set<string>;
  approvedExecutionIdsBySession: Map<string, string>;
  claimedExecutionSessions: Map<string, string>;
  approvedExecutionTurns: Map<string, any>;
  startedApprovedExecutions: Set<string>;
  finishedApprovedExecutions: Set<string>;
  dispatchingApprovedExecutions: Set<string>;
  inFlightExecutionFinishes: Set<string>;
  pendingExecutionFinishes: Map<string, any>;
  waitForTurnSettlement: (sessionId: string, turnId: string) => Promise<void>;
  planSubmissionTurnKey: (sessionId: string, turnId: string) => string;
  shouldCreateTaskNotification: (sessionId: string) => boolean;
  emitAgentEvent: (envelope: AgentEventEnvelope) => void;
  acquireSessionOperation: (sessionId: string) => Promise<() => void>;
  resolveAgentRuntimeLaunch: (...args: any[]) => Promise<any>;
  isQuitting: () => boolean;
};

export function createPlanRuntime({
  runtimeState,
  planState,
  logger,
  sendToRenderer,
  activeTurns,
  activeTurnUsages,
  scheduledRunsBySession,
  activeToolCalls,
  turnFinalizations,
  turnSettlements,
  planSubmissionTurnIds,
  approvedExecutionIdsBySession,
  claimedExecutionSessions,
  approvedExecutionTurns,
  startedApprovedExecutions,
  finishedApprovedExecutions,
  dispatchingApprovedExecutions,
  inFlightExecutionFinishes,
  pendingExecutionFinishes,
  waitForTurnSettlement,
  planSubmissionTurnKey,
  shouldCreateTaskNotification,
  emitAgentEvent,
  acquireSessionOperation,
  resolveAgentRuntimeLaunch,
  isQuitting,
}: PlanRuntimeDependencies): {
  finishTurn: PlanRuntimeDependencies["activeTurns"] extends any ? (...args: any[]) => Promise<void> : never;
  finishApprovedExecution: (...args: any[]) => Promise<void>;
  dispatchApprovedPlan: (rawExecution: unknown) => Promise<void>;
  drainApprovedPlanExecutions: () => Promise<void>;
  dispatchExecutionForProposal: (proposalId: string) => Promise<void>;
} {
function finishTurn(
  sessionId: string,
  status: "completed" | "aborted" | "error",
  errorCode?: string,
  options: { createNotification?: boolean; recoverInflight?: boolean } = {},
): Promise<void> {
  const existing = turnFinalizations.get(sessionId);
  if (existing) return existing;

  const finalization = (async () => {
    const turnId = activeTurns.get(sessionId);
    const turnKey = turnId
      ? planSubmissionTurnKey(sessionId, turnId)
      : undefined;
    const wasPlanSubmission = turnKey
      ? planSubmissionTurnIds.has(turnKey)
      : false;

    try {
      if (runtimeState.host && turnId) {
        const createNotification =
          options.createNotification ??
          (!wasPlanSubmission && shouldCreateTaskNotification(sessionId));
        const turnUsage = activeTurnUsages.get(sessionId);
        activeTurnUsages.delete(sessionId);
        try {
          const result = await runtimeState.host.call<{
            ok: boolean;
            notification?: AppNotification;
            recovered?: UiMessage;
          }>("session.endTurn", {
            turnId,
            status,
            errorCode,
            createNotification,
            ...(turnUsage ? { usage: turnUsage } : {}),
            // The reply can no longer finish on its own: promote its last
            // checkpoint instead of waiting for a final row that never comes.
            ...(options.recoverInflight ? { recoverInflight: true } : {}),
          });
          if (result.notification) {
            sendToRenderer(IPC.event.notificationChanged, {
              notification: result.notification,
            });
          }
          if (result.recovered) {
            // Settle the renderer's streaming row the same way a final
            // message_end would have, so it does not stay "streaming" forever.
            emitAgentEvent({
              sessionId,
              turnId,
              ts: Date.now(),
              event: { type: "message_end", message: result.recovered },
            } satisfies AgentEventEnvelope);
          }
        } catch (e) {
          logger.app("persistence", "warn", "endTurn failed", {
            sessionId,
            data: String(e),
          });
        }
      }

      const runId = scheduledRunsBySession.get(sessionId);
      if (runId) {
        scheduledRunsBySession.delete(sessionId);
        if (runtimeState.host) {
          await runtimeState.host
            .call("scheduled.finishRun", { runId, status, errorCode })
            .catch((e) =>
              logger.app("persistence", "warn", "finishRun failed", {
                sessionId,
                data: String(e),
              }),
            );
        }
      }
    } finally {
      // Do not release local ownership or wake a queued approved execution
      // until the durable endTurn request has settled above.
      if (turnId && activeTurns.get(sessionId) === turnId) {
        activeTurns.delete(sessionId);
      }
      if (turnKey) {
        planSubmissionTurnIds.delete(turnKey);
        const waiters = turnSettlements.get(turnKey);
        if (waiters) {
          turnSettlements.delete(turnKey);
          for (const resolve of waiters) resolve();
        }
      }
    }

    if (turnId) {
      const toolPrefix = `${sessionId}:`;
      // A host tool can finish shortly after the turn is aborted. Keep metadata
      // long enough for a late tool_end to persist a readable historical row,
      // but never clear a newer turn's long-running tools (TaskWait may span
      // this window).
      setTimeout(() => {
        for (const [key, call] of activeToolCalls) {
          if (key.startsWith(toolPrefix) && call.turnId === turnId) {
            activeToolCalls.delete(key);
          }
        }
      }, 5 * 60 * 1000).unref();
    }
  })();

  turnFinalizations.set(sessionId, finalization);
  const releaseFinalization = () => {
    if (turnFinalizations.get(sessionId) === finalization) {
      turnFinalizations.delete(sessionId);
      // The terminal event reaches Agent Host while activeTurns still owns
      // this session. Retry its deferred queue drain once settlement releases
      // both busy guards, unless the application is shutting down.
      if (!isQuitting()) runtimeState.agentHostBridge?.agentHost.kick(sessionId);
    }
  };
  void finalization.then(releaseFinalization, releaseFinalization);
  return finalization;
}

async function finishApprovedExecution(
  executionId: string,
  status: PlanExecutionFinishStatus,
  errorCode?: string,
): Promise<void> {
  if (finishedApprovedExecutions.has(executionId)) return;
  if (inFlightExecutionFinishes.has(executionId)) return;
  if (!pendingExecutionFinishes.has(executionId)) {
    pendingExecutionFinishes.set(executionId, { status, errorCode });
  }
  inFlightExecutionFinishes.add(executionId);
  if (!runtimeState.host) {
    inFlightExecutionFinishes.delete(executionId);
    return;
  }
  try {
    const pending = pendingExecutionFinishes.get(executionId) ?? {
      status,
      errorCode,
    };
    await runtimeState.host.call("plans.finishExecution", {
      executionId,
      status: pending.status,
      ...(pending.errorCode ? { errorCode: pending.errorCode } : {}),
    });
    finishedApprovedExecutions.add(executionId);
    startedApprovedExecutions.delete(executionId);
    pendingExecutionFinishes.delete(executionId);
    const turn = approvedExecutionTurns.get(executionId);
    const sessionId = turn?.sessionId ?? claimedExecutionSessions.get(executionId);
    if (sessionId && approvedExecutionIdsBySession.get(sessionId) === executionId) {
      approvedExecutionIdsBySession.delete(sessionId);
    }
    approvedExecutionTurns.delete(executionId);
    claimedExecutionSessions.delete(executionId);
  } catch (error) {
    logger.app("runtime", "warn", "approved plan execution finalization failed", {
      data: { executionId, error: String(error) },
    });
  } finally {
    inFlightExecutionFinishes.delete(executionId);
  }
}

async function dispatchApprovedPlan(rawExecution: unknown): Promise<void> {
  const initial = planExecutionFromUnknown(rawExecution);
  if (!initial) {
    logger.app("runtime", "warn", "approved plan execution descriptor was invalid");
    return;
  }
  const releaseSessionOperation = await acquireSessionOperation(initial.sessionId);
  try {
  if (
    initial.state === "running" ||
    initial.state === "interrupted" ||
    initial.state === "completed" ||
    startedApprovedExecutions.has(initial.id) ||
    finishedApprovedExecutions.has(initial.id) ||
    dispatchingApprovedExecutions.has(initial.id)
  ) {
    return;
  }
  if (!runtimeState.host || !runtimeState.sidecar) return;
  dispatchingApprovedExecutions.add(initial.id);
  let claimed = false;
  let turnId: string | undefined;
  try {
    const activeTurnId = activeTurns.get(initial.sessionId);
    if (
      activeTurnId &&
      planSubmissionTurnIds.has(
        planSubmissionTurnKey(initial.sessionId, activeTurnId),
      )
    ) {
      await waitForTurnSettlement(initial.sessionId, activeTurnId);
    }
    if (activeTurns.has(initial.sessionId)) {
      const retry = setTimeout(() => {
        void dispatchApprovedPlan(initial);
      }, 250);
      retry.unref();
      return;
    }
    const claimResponse = await runtimeState.host.call("plans.claimExecution", {
      executionId: initial.id,
    });
    const claimedExecution = executionFromResponse(claimResponse);
    if (
      claimedExecution?.state === "interrupted" ||
      claimedExecution?.state === "completed" ||
      claimedExecution?.state === "running"
    ) {
      // A running descriptor is the host's durable ownership signal. It may
      // belong to a previous process and must never be replayed here.
      if (claimedExecution.state !== "running") return;
    }
    const execution: PlanExecution = {
      ...(claimedExecution ?? initial),
      state: "running",
    };
    claimed = true;
    claimedExecutionSessions.set(execution.id, execution.sessionId);

    const [settings, sessionResult] = await Promise.all([
      runtimeState.host.call("settings.get"),
      runtimeState.host.call<{ session?: any }>("session.get", { id: execution.sessionId }),
    ]);
    if (!sessionResult.session) {
      throw Object.assign(new Error("Session not found"), {
        errorCode: ErrorCodes.NOT_FOUND,
      });
    }
    const launch = await resolveAgentRuntimeLaunch(
      execution.sessionId,
      sessionResult.session,
      settings,
      { mode: "agent" },
    );
    const turn = await runtimeState.host.call<{ turnId: string }>("session.beginTurn", {
      sessionId: execution.sessionId,
      providerId: launch.providerId,
      modelId: launch.modelId,
    });
    turnId = String(turn.turnId || "").trim();
    if (!turnId) throw new Error("execution turn was not created");
    activeTurns.set(execution.sessionId, turnId);
    activeTurnUsages.delete(execution.sessionId);
    approvedExecutionIdsBySession.set(execution.sessionId, execution.id);
    approvedExecutionTurns.set(execution.id, {
      sessionId: execution.sessionId,
      turnId,
    });
    startedApprovedExecutions.add(execution.id);
    const accepted = await runtimeState.sidecar.call<{ accepted: boolean }>(
      "agent.executeApprovedPlan",
      {
        ...launch.sidecarParams,
        mode: "agent",
        turnId,
        execution,
      },
    );
    if (accepted?.accepted !== true) {
      throw new Error("approved plan execution was not accepted");
    }
    logger.app("runtime", "info", "approved plan execution started", {
      sessionId: execution.sessionId,
      data: { executionId: execution.id, turnId },
    });
  } catch (error: any) {
    const errorCode =
      error?.data?.errorCode || error?.errorCode || ErrorCodes.PLAN_EXECUTION_INTERRUPTED;
    if (turnId && activeTurns.get(initial.sessionId) === turnId) {
      await finishTurn(initial.sessionId, "error", errorCode);
    }
    if (claimed) {
      await finishApprovedExecution(initial.id, "interrupted", errorCode);
    }
    logger.app("runtime", "warn", "approved plan execution failed to start", {
      sessionId: initial.sessionId,
      data: { executionId: initial.id, error: String(error) },
    });
  } finally {
      dispatchingApprovedExecutions.delete(initial.id);
    }  } finally {
    releaseSessionOperation();
  }

}

async function drainApprovedPlanExecutions(): Promise<void> {
  if (planState.approvedExecutionDrain) return planState.approvedExecutionDrain;
  planState.approvedExecutionDrain = (async () => {
    if (!runtimeState.host || !runtimeState.sidecar) return;
    for (const [executionId, finish] of pendingExecutionFinishes) {
      await finishApprovedExecution(executionId, finish.status, finish.errorCode);
    }
    const response = await runtimeState.host.call("plans.queuedExecutions");
    for (const execution of executionListFromResponse(response)) {
      // Only queued rows are dispatchable. Running/interrupted rows are durable
      // recovery outcomes and must remain untouched on startup.
      if (execution.state !== "queued") continue;
      await dispatchApprovedPlan(execution);
    }
  })();
  try {
    await planState.approvedExecutionDrain;
  } finally {
    planState.approvedExecutionDrain = null;
  }
}

async function dispatchExecutionForProposal(proposalId: string): Promise<void> {
  if (!runtimeState.host) return;
  try {
    const response = await runtimeState.host.call("plans.queuedExecutions");
    const execution = executionListFromResponse(response).find(
      (candidate) => candidate.proposalId === proposalId,
    );
    if (execution?.state === "queued") {
      await dispatchApprovedPlan(execution);
    }
  } catch (error) {
    logger.app("runtime", "warn", "approved plan lookup after resolution failed", {
      data: String(error),
    });
  }
}
  return {
    finishTurn,
    finishApprovedExecution,
    dispatchApprovedPlan,
    drainApprovedPlanExecutions,
    dispatchExecutionForProposal,
  };
}

