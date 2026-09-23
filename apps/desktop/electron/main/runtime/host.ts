import { ErrorCodes, IPC, type AgentEventEnvelope, type PlanExecutionFinishStatus, type Risk } from "@pi-desktop/shared";
import { assertLinuxGlibcSupported } from "../linux-glibc";
import { HostProcess } from "../host-process";
import { PermissionReviewCoordinator, type ReviewAction, type PermissionReviewResult } from "@pi-desktop/host-runtime";
import type { Logger } from "../logger";
import type { PersistenceOutbox } from "../persistence-outbox";
import type { PluginRuntime } from "../plugin-runtime";
import type { UserMcpRuntime } from "../user-mcp";
import type { RuntimeState } from "./context";
import type { FinishTurn } from "./plans";

export type HostRuntimeDependencies = {
  runtimeState: RuntimeState;
  dataDir: string;
  logger: Logger;
  persistenceOutbox: PersistenceOutbox;
  activeToolCalls: Map<string, any>;
  activeToolCallKey: (sessionId: string, toolCallId: string) => string;
  sessionProjects: Map<string, string | null>;
  plugins: PluginRuntime;
  userMcp: UserMcpRuntime;
  pluginActiveInProject: (pluginId: string, projectPath: string | null | undefined) => boolean;
  sendToRenderer: (channel: string, payload: unknown) => void;
  emitAgentEvent: (envelope: AgentEventEnvelope) => void;
  togglePluginLauncher: () => Promise<void>;
  finishTurn: FinishTurn;
  finishApprovedExecution: (
    executionId: string,
    status: PlanExecutionFinishStatus,
    errorCode?: string,
  ) => Promise<void>;
  /**
   * Last synchronous gate before a plugin side effect. A turn that was cancelled
   * or started finalizing while this handler awaited the session read must not
   * dispatch.
   */
  isTurnDispatchable: (sessionId: string, turnId: string | null | undefined) => boolean;
  /** Identity of the turn a host crash interrupted, captured before teardown. */
  activeTurns: Map<string, string>;
  approvedExecutionIdsBySession: Map<string, string>;
  claimedExecutionSessions: Map<string, string>;
  importLegacyScheduled: () => Promise<unknown>;
  superviseRestart: (kind: "host" | "sidecar") => Promise<void>;
  isQuitting: () => boolean;
  reviewPermission: (action: ReviewAction, signal: AbortSignal, sessionId: string) => Promise<PermissionReviewResult>;
  settleExternalApproval: (requestId: string, decision: "allow-once" | "deny") => void;
};

export function createHostRuntime({
  runtimeState,
  dataDir,
  logger,
  persistenceOutbox,
  activeToolCalls,
  activeToolCallKey,
  sessionProjects,
  plugins,
  userMcp,
  pluginActiveInProject,
  sendToRenderer,
  emitAgentEvent,
  togglePluginLauncher,
  finishTurn,
  isTurnDispatchable,
  finishApprovedExecution,
  activeTurns,
  approvedExecutionIdsBySession,
  claimedExecutionSessions,
  importLegacyScheduled,
  superviseRestart,
  isQuitting,
  reviewPermission,
  settleExternalApproval,
}: HostRuntimeDependencies): {
  wireHost: (host: HostProcess) => void;
  startHost: () => Promise<void>;
  cancelReviewForEvent: (event: AgentEventEnvelope) => void;
  cancelReviewForSession: (sessionId: string) => void;
  takeOverSessionReviews: (sessionId: string) => Promise<void>;
} {
  let activeReviewCoordinator: PermissionReviewCoordinator | undefined;
  const reviewRequests = new Map<string, {
    sessionId: string;
    toolCallId: string;
    toolName: string;
    argsPreview: unknown;
    risk: Risk;
    reason: string;
    reviewState?: "user" | "awaiting_review" | "reviewing";
    scopeLabel?: string;
    createdAt?: string;
    expiresAt?: string;
  }>();
  const wireHost = (h: HostProcess) => {
  reviewRequests.clear();
  const reviewCoordinator = new PermissionReviewCoordinator({
    claim: async (requestId) => {
      const claimed = await h.call<{ token: string; fingerprint: string; action: ReviewAction }>(
        "permissions.claimReview", { requestId },
      );
      const previous = reviewRequests.get(requestId);
      if (previous) {
        const next = { ...previous, reviewState: "reviewing" as const };
        reviewRequests.set(requestId, next);
        emitAgentEvent({ sessionId: previous.sessionId, ts: Date.now(), event: {
          type: "tool_permission_request", request: { ...next, requestId },
        } });
      }
      return claimed;
    },
    settle: async (requestId, token, fingerprint, result) => {
      const settled = await h.call<{ decision: "allow_once" | "deny" | "needs_user" }>(
        "permissions.resolveReview", { requestId, token, fingerprint, result },
      );
      // Host owns the final decision. It may downgrade a model approval to a
      // manual request if the turn or evidence became stale while reviewing.
      if (settled.decision === "needs_user") return;
      reviewRequests.delete(requestId);
      settleExternalApproval(requestId, settled.decision === "allow_once" ? "allow-once" : "deny");
    },
    fallback: (requestId, token, fingerprint, result) =>
      h.call("permissions.resolveReview", { requestId, token, fingerprint, result }).then(() => undefined),
  }, reviewPermission, Date.now, (code) => {
    logger.app("permission", "warn", "review could not complete", { data: { code } });
  });
  activeReviewCoordinator = reviewCoordinator;
  h.onNotification((method, params) => {
    // Notifications from a previous host generation must never reach the
    // current plugin/renderer bridge after a restart.
    if (runtimeState.host !== h) return;
    // An install reports itself, so the dialog that shows it can follow the
    // phases, the mirror being tried and the bytes that have arrived. Nothing
    // here decides anything: the request's own answer is still the outcome.
    if (method === "plugin.installProgress") {
      sendToRenderer(IPC.event.pluginInstallProgress, params);
      return;
    }
    if (method === "permissions.reviewUpdated") {
      const update = params as { requestId: string; reviewState: "user" | "awaiting_review" | "reviewing"; reason?: string };
      const previous = reviewRequests.get(update.requestId);
      if (previous) {
        if (update.reviewState === "user") reviewCoordinator.cancel(update.requestId);
        const next = { ...previous, reviewState: update.reviewState, reason: update.reason ?? previous.reason };
        reviewRequests.set(update.requestId, next);
        emitAgentEvent({ sessionId: previous.sessionId, ts: Date.now(), event: {
          type: "tool_permission_request", request: { ...next, requestId: update.requestId },
        } });
        if (update.reviewState === "user") reviewRequests.delete(update.requestId);
      }
      return;
    }
    if (method === "permissions.request") {
      const permission = params as {
        requestId: string;
        sessionId: string;
        toolCallId: string;
        toolName: string;
        argsPreview: string;
        risk: Risk;
        reason: string;
        reviewState?: "user" | "awaiting_review" | "reviewing";
        scopeLabel?: string;
        createdAt?: string;
        expiresAt?: string;
      };
      reviewRequests.set(permission.requestId, permission);
      if (permission.reviewState === "awaiting_review") {
        const hostCreatedAt = permission.createdAt ? Date.parse(permission.createdAt) : NaN;
        reviewCoordinator.enqueue({
          requestId: permission.requestId, sessionId: permission.sessionId, toolCallId: permission.toolCallId,
          requestedAt: Number.isFinite(hostCreatedAt) ? hostCreatedAt : Date.now(),
        });
      }
      // A delegate's call is already in `activeToolCalls` by the time the host
      // asks: the sidecar forwards `tool_start` before it executes the tool.
      // Without this the dialog would attribute a delegate's write to the main
      // agent, which is the one thing the user must not be confused about.
      const asking = activeToolCalls.get(
        activeToolCallKey(
          permission.sessionId,
          permission.toolCallId,
        ),
      );
      logger.app("permission", "info", "permission requested", {
        requestId: permission.requestId,
        sessionId: permission.sessionId,
        turnId: asking?.turnId,
        toolCallId: permission.toolCallId,
        parentToolCallId: asking?.parentToolCallId,
        agentName: asking?.agentName,
        data: {
          toolName: permission.toolName,
          risk: permission.risk,
          reason: permission.reason,
        },
      });
      const envelope: AgentEventEnvelope = {
        sessionId: permission.sessionId,
        ts: Date.now(),
        event: {
          type: "tool_permission_request",
          request: {
            requestId: permission.requestId,
            sessionId: permission.sessionId,
            toolCallId: permission.toolCallId,
            toolName: permission.toolName,
            argsPreview: permission.argsPreview,
            risk: permission.risk,
            reason: permission.reason,
            ...(permission.reviewState ? { reviewState: permission.reviewState } : {}),
            ...(permission.scopeLabel ? { scopeLabel: permission.scopeLabel } : {}),
            ...(permission.createdAt ? { createdAt: permission.createdAt } : {}),
            ...(permission.expiresAt ? { expiresAt: permission.expiresAt } : {}),
            ...(asking?.agentName ? { agentName: asking.agentName } : {}),
            ...(asking?.parentToolCallId
              ? { parentToolCallId: asking.parentToolCallId }
              : {}),
          },
        },
      };
      emitAgentEvent(envelope);
    } else if (method === "plugins.execute") {
      void (async () => {
        const q = params as {
          executionId: string;
          permitToken?: string;
          sessionId?: string;
          /**
           * Runtime turn identity of the tool call, forwarded unchanged from the
           * host so a plugin receives the same identity `session:turnEnded`
           * carries. Absent for callers that predate turn tracking.
           */
          turnId?: string;
          toolCallId?: string;
          toolName: string;
          args: unknown;
          mode?: string;
        };
        const projectPath = q.sessionId
          ? (sessionProjects.get(q.sessionId) ?? null)
          : null;
        const tool = plugins.getTools().find((t) => t.fullName === q.toolName);
        const consumePermit = async () => {
          if (!q.permitToken || !q.sessionId || !q.turnId || !q.toolCallId ||
            !isTurnDispatchable(q.sessionId, q.turnId)) {
            throw new Error("plugin execution permit or active turn missing");
          }
          await h.call("permissions.consumeExecutionPermit", {
            executionId: q.executionId, permitToken: q.permitToken,
            sessionId: q.sessionId, turnId: q.turnId,
            toolCallId: q.toolCallId, toolName: q.toolName, args: q.args,
          });
          if (!isTurnDispatchable(q.sessionId, q.turnId)) {
            throw new Error("plugin turn ended before dispatch");
          }
        };
        let payload: Record<string, unknown>;
        if (q.toolName.startsWith("mcp_")) {
          try {
            await consumePermit();
            const result = await userMcp.callTool(q.toolName, q.args, projectPath);
            payload = { executionId: q.executionId, ok: true, content: result ?? null };
          } catch (e) {
            payload = {
              executionId: q.executionId,
              ok: false,
              errorCode:
                (e as { errorCode?: string })?.errorCode ?? "TOOL_FAILED",
              content: { error: e instanceof Error ? e.message : String(e) },
            };
          }
        } else if (!tool) {
          payload = {
            executionId: q.executionId,
            ok: false,
            errorCode: "TOOL_NOT_FOUND",
            content: { error: `plugin tool not loaded: ${q.toolName}` },
          };
        } else if (!pluginActiveInProject(tool.pluginId, projectPath)) {
          // The catalog already hid it, but a session assembled before the
          // scope changed can still ask.
          payload = {
            executionId: q.executionId,
            ok: false,
            errorCode: "TOOL_NOT_FOUND",
            content: {
              error: `plugin tool ${q.toolName} is not enabled for this project`,
            },
          };
        } else {
          try {
            let modelKey: string | undefined;
            let thinkingLevel: string | undefined;
            // Host-core sends the session mode; fall back to a session.get
            // call when it is missing (legacy callers). The plugin-runtime
            // uses the mode to enforce plan-safe action restrictions
            // (ADR 0211).
            let sessionMode: "agent" | "plan" | "goal" | undefined;
            const normalizedMode = typeof q.mode === "string" ? q.mode : undefined;
            if (normalizedMode === "agent" || normalizedMode === "plan" || normalizedMode === "goal") {
              sessionMode = normalizedMode;
            } else if (q.sessionId && runtimeState.host) {
              try {
                const detail = await runtimeState.host.call<{
                  session?: {
                    mode?: string;
                    providerId?: string;
                    modelId?: string;
                    thinkingLevel?: string;
                  };
                }>("session.get", { id: q.sessionId });
                const session = detail?.session;
                if (session?.mode === "agent" || session?.mode === "plan" || session?.mode === "goal") {
                  sessionMode = session.mode;
                }
                if (session?.providerId && session?.modelId) {
                  modelKey = `${session.providerId}/${session.modelId}`;
                }
                thinkingLevel = session?.thinkingLevel;
              } catch {
                // Executor identity is best-effort; the tool can still run.
              }
            }
            // Last synchronous gate before dispatch: a turn that was cancelled or
            // began finalizing while the session read above was awaited must not
            // start a plugin side effect. No await may sit between this check and
            // the dispatch, and the rejection is answered on the original
            // execution id rather than dropped.
            //
            // The gate is closed rather than best-effort: a payload that names no
            // turn cannot be attributed to one this process knows about, so it is
            // indistinguishable from a call belonging to a turn that already ended
            // (its cancel lock may be gone, its `session:turnEnded` already sent)
            // and any resource it started could never be related to that event.
            // The runtime always stamps both halves of the identity on
            // `tools.execute`, so a call without one is not a supported shape; a
            // standalone caller that ever needs the channel must be distinguished
            // by an explicit origin instead of by an absent identity.
            if (!isTurnDispatchable(q.sessionId ?? "", q.turnId)) {
              payload = {
                executionId: q.executionId,
                ok: false,
                errorCode: "TOOL_TURN_CANCELLED",
                content: {
                  error: `turn ${q.turnId ?? "(none)"} is no longer dispatchable`,
                },
              };
            } else {
              await consumePermit();
              const result = await tool.execute(q.args, {
                sessionId: q.sessionId,
                turnId: q.turnId,
                mode: sessionMode,
                modelKey,
                thinkingLevel,
              });
              payload = {
                executionId: q.executionId,
                ok: true,
                content: result ?? null,
              };
            }
          } catch (e) {
            const code =
              e && typeof e === "object" && "code" in e && typeof e.code === "string"
                ? e.code
                : "TOOL_FAILED";
            payload = {
              executionId: q.executionId,
              ok: false,
              errorCode: code === "PERMISSION_DENIED" ? "PERMISSION_DENIED" : "TOOL_FAILED",
              content: { error: e instanceof Error ? e.message : String(e) },
            };
          }
        }
        logger.app("plugin", "info", "plugin tool executed", {
          toolCallId: q.toolCallId,
          pluginId: tool?.pluginId,
          data: { toolName: q.toolName, ok: payload.ok === true },
        });
        try {
          await h.call("plugins.resolveExecution", payload);
        } catch (e) {
          logger.app("plugin", "warn", "plugin execution resolve failed", {
            data: String(e),
          });
        }
        for (const toast of plugins.drainToasts()) {
          sendToRenderer(IPC.event.toast, { message: toast });
        }
      })();
    } else if (
      method === "keyboard.shortcut" &&
      process.platform === "win32" &&
      (params as { binding?: unknown })?.binding === "Alt+Space"
    ) {
      void togglePluginLauncher().catch((error) =>
        logger.app("diagnostics", "error", "Windows global shortcut failed", {
          data: String(error),
        }),
      );
    } else if (method === "plans.changed") {
      sendToRenderer(IPC.event.plansChanged, params);
    } else if (method === "configSync.changed") {
      sendToRenderer(IPC.event.configSyncChanged, params);
    } else if (method === "configSync.progress") {
      // A sync is one request that answers only when it is over, so these
      // reports are the only thing the page has to show while it runs. The
      // request's own answer is still the outcome.
      sendToRenderer(IPC.event.configSyncProgress, params);
    }
  });
  h.onExit(({ code, signal, intentional }) => {
    reviewCoordinator.dispose();
    if (runtimeState.host !== h) return;
    logger.flushChild("host");
    runtimeState.host = null;
    if (intentional || isQuitting()) return;
    for (const [executionId, sessionId] of claimedExecutionSessions) {
      if (approvedExecutionIdsBySession.get(sessionId) === executionId) {
        // Captured before the teardown awaits: the turn this interrupted is the
        // one running now, and it must not be inferred later.
        const interruptedTurnId = activeTurns.get(sessionId);
        if (interruptedTurnId) {
          void finishTurn(sessionId, "aborted", "PLAN_EXECUTION_INTERRUPTED", {
            turnId: interruptedTurnId,
          }).catch((error: unknown) => {
            // Nothing above can await this: the host is already gone. Log it
            // rather than let the rejection surface as an unhandled one.
            logger.app("runtime", "warn", "turn finalization failed after host exit", {
              sessionId,
              data: String(error),
            });
          });
        }
      }
      void finishApprovedExecution(
        executionId,
        "interrupted",
        "PLAN_EXECUTION_INTERRUPTED",
      );
    }
    logger.app("runtime", "error", "host-core exited unexpectedly", {
      code: ErrorCodes.HOST_UNAVAILABLE,
      data: { exitCode: code, signal },
    });
    sendToRenderer(IPC.event.hostStatus, {
      ok: false,
      component: "host",
      restarting: true,
    });
    void superviseRestart("host");
  });
  };
  const startHost = async (): Promise<void> => {

  assertLinuxGlibcSupported();
  const h = new HostProcess(dataDir, (text) => logger.child("host", text));
  wireHost(h);
  runtimeState.host = h;
  try {
    await h.handshake();
    // A headless/older host defaults to manual approval until an actual
    // reviewer executor registers on this host generation.
    await h.call("permissions.setReviewCapability", { available: true });
    logger.app("runtime", "info", "host-core handshake ok", {
      data: { generation: h.generation },
    });
    void importLegacyScheduled();
    // Drain before the renderer can session.get. Assistant/tool rows live in
    // this outbox until host-core appends them; a cold start that raced the
    // flush showed only user prompts (issue #42 / D327). Boot leaves
    // completed checkpoints in place so this drain can land the finished
    // row first; leftovers are then promoted as complete.
    await persistenceOutbox.flush(() => runtimeState.host);
    try {
      await h.call("session.recoverInflightMessages");
    } catch (error) {
      logger.app("persistence", "warn", "in-flight reply recovery after outbox drain failed", {
        data: String(error),
      });
    }
  } catch (error) {
    if (runtimeState.host === h) runtimeState.host = null;
    logger.flushChild("host");
    await h.dispose();
    throw error;
  }
  };
  return {
    wireHost, startHost,
    cancelReviewForEvent: (envelope) => {
      if (envelope.event.type === "tool_end") {
        activeReviewCoordinator?.cancelForTool(envelope.sessionId, envelope.event.toolCallId);
        for (const [id, request] of reviewRequests) {
          if (request.sessionId === envelope.sessionId && request.toolCallId === envelope.event.toolCallId) {
            reviewRequests.delete(id);
          }
        }
      } else if (envelope.event.type === "turn_end" || envelope.event.type === "agent_end") {
        activeReviewCoordinator?.cancelForSession(envelope.sessionId);
        for (const [id, request] of reviewRequests) {
          if (request.sessionId === envelope.sessionId) reviewRequests.delete(id);
        }
      }
    },
    cancelReviewForSession: (sessionId) => {
      activeReviewCoordinator?.cancelForSession(sessionId);
      for (const [id, request] of reviewRequests) {
        if (request.sessionId === sessionId) reviewRequests.delete(id);
      }
    },
    takeOverSessionReviews: async (sessionId) => {
      activeReviewCoordinator?.cancelForSession(sessionId);
      const host = runtimeState.host;
      if (!host) return;
      // A graceful stop cannot finish while this tool awaits approval. Move
      // only active auto reviews to the manual state, then deny that pending
      // tool via Host before the sidecar receives agent.stop.
      const requests = [...reviewRequests].filter(([, item]) => item.sessionId === sessionId &&
        (item.reviewState === "awaiting_review" || item.reviewState === "reviewing"));
      await Promise.all(requests.map(async ([id]) => {
        try {
          await host.call("permissions.takeoverReview", { requestId: id });
          await host.call("permissions.resolve", { requestId: id, decision: "deny" });
          reviewRequests.delete(id);
          settleExternalApproval(id, "deny");
        } catch (error) {
          const code = (error as { errorCode?: string; data?: { errorCode?: string } })?.data?.errorCode ??
            (error as { errorCode?: string })?.errorCode;
          if (code === "NOT_FOUND" || code === "PERMISSION_TIMEOUT") {
            reviewRequests.delete(id);
            return;
          }
          logger.app("permission", "warn", "review stop denial failed", {
            sessionId, data: { requestId: id, error: String(error) },
          });
          throw error;
        }
      }));
    },
  };
}
