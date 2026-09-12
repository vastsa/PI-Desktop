import { IPC, ErrorCodes, isGlobalPermissionMode, type AgentEventEnvelope, type AgentPromptRequest, type AgentSteerRequest, type UiMessage, type AgentQueuePushRequest, type AgentStopRequest, type AskToolResolution, type GlobalPermissionMode, type MessageUsage, type PlanExecutionFinishStatus, type PlanResolutionResult, type PlanResolveRequest, type PromptEnhancementRequest, type SessionSummarizeTitleRequest } from "@pi-desktop/shared";
import { expandSlashInvocation, enhancePromptDraft, summarizeSessionTitle, visionFromModelConfig, type ComposerTemplate, type RuntimeProviderConfig } from "@pi-desktop/agent-runtime";
import { OAUTH_AUTH_KIND, type VendorOAuth } from "../oauth";
import { appendPromptFallbackPaths, durableUserMessageId, preparePromptAttachments, type PreparedPromptAttachment } from "../prompt-attachments";
import { executionFromResponse } from "../plan-execution";
import type { AgentExtensionBridge } from "../agent-extensions";
import type { AgentHostBridge } from "../agent-host-bridge";
import type { AgentSidecar } from "../agent-sidecar";
import type { HostProcess } from "../host-process";
import type { Logger } from "../logger";
import type { PersistenceOutbox } from "../persistence-outbox";
import type { ComposerCommandService } from "./composer-ipc";
import type { IpcRegistrar } from "./types";

export type AgentIpcDependencies = {
  registrar: IpcRegistrar;
  getHost: () => HostProcess | null;
  getSidecar: () => AgentSidecar | null;
  getAgentHostBridge: () => AgentHostBridge | null;
  logger: Pick<Logger, "app">;
  vendorOAuth: VendorOAuth;
  agentExtensions: AgentExtensionBridge;
  persistenceOutbox: PersistenceOutbox;
  dataDir: string;
  activeTurns: Map<string, string>;
  turnFinalizations: Map<string, Promise<void>>;
  activeTurnUsages: Map<string, MessageUsage>;
  approvedExecutionIdsBySession: Map<string, string>;
  claimedExecutionSessions: Map<string, string>;
  resolveAgentRuntimeLaunch: (...args: any[]) => Promise<any>;
  acquireSessionOperation: (sessionId: string) => Promise<() => void>;
  finishTurn: (sessionId: string, status: "completed" | "aborted" | "error", errorCode?: string, options?: { createNotification?: boolean; recoverInflight?: boolean }) => Promise<void>;
  finishApprovedExecution: (executionId: string, status: PlanExecutionFinishStatus, errorCode?: string) => Promise<void>;
  dispatchApprovedPlan: (execution: unknown) => Promise<void>;
  dispatchExecutionForProposal: (proposalId: string) => Promise<void>;
  emitAgentEvent: (envelope: AgentEventEnvelope) => void;
  setNotificationViewingSessionId: (sessionId: string | null) => void;
  optionalWorkspaceRoot: () => Promise<string | null>;
  composerCommandService: Pick<ComposerCommandService, "buildComposerCommands">;
  loadComposerTemplatesCached: (root: string | null) => Promise<ComposerTemplate[]>;
};

/** Register prompt, agent lifecycle, queue, approval and plan channels. */
export function registerAgentIpc({
  registrar,
  getHost,
  getSidecar,
  getAgentHostBridge,
  logger,
  vendorOAuth,
  agentExtensions,
  persistenceOutbox,
  dataDir,
  activeTurns,
  turnFinalizations,
  activeTurnUsages,
  approvedExecutionIdsBySession,
  claimedExecutionSessions,
  resolveAgentRuntimeLaunch,
  acquireSessionOperation,
  finishTurn,
  finishApprovedExecution,
  dispatchApprovedPlan,
  dispatchExecutionForProposal,
  emitAgentEvent,
  setNotificationViewingSessionId,
  optionalWorkspaceRoot,
  composerCommandService,
  loadComposerTemplatesCached,
}: AgentIpcDependencies): void {
  let host: HostProcess | null = null;
  let sidecar: AgentSidecar | null = null;
  let agentHostBridge: AgentHostBridge | null = null;
  const handle = (channel: string, fn: (...args: any[]) => Promise<any>) => {
    registrar.handle(channel, async (...args) => {
      host = getHost();
      sidecar = getSidecar();
      agentHostBridge = getAgentHostBridge();
      return fn(...args);
    });
  };
  handle(IPC.invoke.promptEnhance, async (req: PromptEnhancementRequest) => {
    if (!host) throw new Error("backend unavailable");
    const draft = typeof req?.draft === "string" ? req.draft : "";
    if (!draft.trim()) {
      throw Object.assign(new Error("Prompt draft must not be empty"), {
        errorCode: ErrorCodes.INVALID_ARGUMENT,
      });
    }
    if (draft.trim().startsWith("/")) {
      throw Object.assign(new Error("Slash command drafts cannot be enhanced"), {
        errorCode: ErrorCodes.INVALID_ARGUMENT,
      });
    }

    const sessionId =
      typeof req.sessionId === "string" ? req.sessionId.trim() : "";
    const session = sessionId
      ? (await host.call<{ session?: any }>("session.get", { id: sessionId })).session
      : {};
    if (sessionId && !session) {
      throw Object.assign(new Error("Session not found"), {
        errorCode: ErrorCodes.NOT_FOUND,
      });
    }
    const settings = await host.call<any>("settings.get");
    const launchSessionId = sessionId || `prompt-enhancement:${crypto.randomUUID()}`;
    const launch = await resolveAgentRuntimeLaunch(
      launchSessionId,
      session ?? {},
      settings,
      {
        mode: "agent",
        providerId:
          typeof req.providerId === "string" ? req.providerId.trim() : undefined,
        modelId: typeof req.modelId === "string" ? req.modelId.trim() : undefined,
        thinkingLevel: req.thinkingLevel,
      },
    );
    const runtimeProvider = {
      ...launch.sidecarParams.provider,
      ...(launch.sidecarParams.provider.authKind === OAUTH_AUTH_KIND
        ? { resolveAuth: () => vendorOAuth.resolveAuth(launch.providerId) }
        : {}),
    } as RuntimeProviderConfig;
    const enhancedDraft = await enhancePromptDraft(
      runtimeProvider,
      draft,
      launch.sidecarParams.thinkingLevel,
      { sessionId: launchSessionId },
    );
    logger.app("session", "info", "prompt enhanced", {
      sessionId: sessionId || undefined,
      data: { providerId: launch.providerId, modelId: launch.modelId },
    });
    return { enhancedDraft };
  });

  handle(IPC.invoke.sessionSummarizeTitle, async (req: SessionSummarizeTitleRequest) => {
    if (!host) throw new Error("backend unavailable");
    const sessionId = typeof req?.sessionId === "string" ? req.sessionId.trim() : "";
    const userPrompt = typeof req?.userPrompt === "string" ? req.userPrompt.trim() : "";
    if (!sessionId || !userPrompt) {
      throw Object.assign(new Error("sessionId and userPrompt required"), {
        errorCode: ErrorCodes.INVALID_ARGUMENT,
      });
    }
    const session = (await host.call<{ session?: any }>("session.get", { id: sessionId })).session;
    if (!session) {
      throw Object.assign(new Error("Session not found"), {
        errorCode: ErrorCodes.NOT_FOUND,
      });
    }
    const settings = await host.call<any>("settings.get");
    const launch = await resolveAgentRuntimeLaunch(
      `title-summary:${sessionId}`,
      session,
      settings,
      {
        mode: "agent",
        providerId: typeof req.providerId === "string" ? req.providerId.trim() : undefined,
        modelId: typeof req.modelId === "string" ? req.modelId.trim() : undefined,
        thinkingLevel: "off",
      },
    );
    const runtimeProvider = {
      ...launch.sidecarParams.provider,
      ...(launch.sidecarParams.provider.authKind === OAUTH_AUTH_KIND
        ? { resolveAuth: () => vendorOAuth.resolveAuth(launch.providerId) }
        : {}),
    } as RuntimeProviderConfig;

    const title = await summarizeSessionTitle(
      runtimeProvider,
      userPrompt,
      req.assistantReply,
      "off",
      { sessionId },
    );
    logger.app("session", "info", "session title summarized", {
      sessionId,
      data: { title, providerId: launch.providerId, modelId: launch.modelId },
    });
    return { title };
  });

  handle(IPC.invoke.agentSteer, async (req: AgentSteerRequest) => {
    if (!host || !sidecar) throw new Error("backend unavailable");
    if (
      !req?.sessionId || typeof req.content !== "string" || !req.expectedTurnId ||
      (!req.content.trim() && !req.attachments?.length)
    ) {
      throw Object.assign(new Error("Steering input and expectedTurnId required"), {
        errorCode: ErrorCodes.INVALID_ARGUMENT,
      });
    }
    if (activeTurns.get(req.sessionId) !== req.expectedTurnId || turnFinalizations.has(req.sessionId)) {
      throw Object.assign(new Error("The target turn has ended"), {
        errorCode: ErrorCodes.TURN_NOT_FOUND,
      });
    }
    const context = await sidecar.call<{ projectPath?: string; supportsVision: boolean }>(
      "agent.steeringContext", { sessionId: req.sessionId, expectedTurnId: req.expectedTurnId },
    );
    const prepared = await preparePromptAttachments(
      dataDir, req.sessionId, context.projectPath, req.attachments ?? [], context.supportsVision,
    );
    const session = await host.call<{ session?: { messages?: UiMessage[] } }>("session.get", {
      id: req.sessionId, messageLimit: 1,
    });
    const message: UiMessage = {
      id: durableUserMessageId(req.messageId, session.session?.messages ?? []),
      role: "user",
      content: req.content,
      status: "complete",
      createdAt: new Date().toISOString(),
      steering: true,
      ...(prepared.length ? { attachments: prepared.map((attachment) => attachment.message) } : {}),
    };
    // Revalidate inside the runtime after all file/host IO. A stale target must
    // never turn into a normal prompt or alter the next turn's configuration.
    return sidecar.call<{ accepted: boolean; turnId: string }>("agent.steer", {
      sessionId: req.sessionId, expectedTurnId: req.expectedTurnId, message,
      content: appendPromptFallbackPaths(req.content, prepared),
      attachments: prepared.filter((attachment) => attachment.inlineData).map((attachment) => ({
        path: attachment.message.ref, name: attachment.message.name, kind: attachment.message.kind,
        mimeType: attachment.message.mimeType, size: attachment.message.size, data: attachment.inlineData,
      })),
    });
  });

  handle(IPC.invoke.agentPrompt, async (req: AgentPromptRequest) => {
    if (!host || !sidecar) throw new Error("backend unavailable");
    const releaseSessionOperation = await acquireSessionOperation(req.sessionId);
    try {
    // Install the renderer's prompt-time snapshot before any asynchronous
    // setup. This closes the gap where a fast completion could beat the
    // effect that reports the active chat session. Missing or mismatched
    // context is deliberately fail-safe.
    const requestedViewingSessionId =
      typeof req.viewingSessionId === "string" ? req.viewingSessionId.trim() : "";
    setNotificationViewingSessionId(
      requestedViewingSessionId && requestedViewingSessionId === req.sessionId
        ? requestedViewingSessionId
        : null,
    );
    const settings = await host.call<any>("settings.get");
    const sessionResult = await host.call<{ session?: any }>("session.get", {
      id: req.sessionId,
      messageLimit: 1,
    });
    let session = sessionResult.session;
    if (!session) {
      throw Object.assign(new Error("Session not found"), {
        errorCode: ErrorCodes.NOT_FOUND,
      });
    }
    const truncateFromMessageId =
      typeof req.truncateFromMessageId === "string"
        ? req.truncateFromMessageId.trim()
        : "";
    const truncateBefore =
      typeof req.truncateBefore === "number" &&
      Number.isFinite(req.truncateBefore) &&
      req.truncateBefore >= 0
        ? Math.floor(req.truncateBefore)
        : undefined;
    if (truncateFromMessageId || truncateBefore !== undefined) {
      // Host-owned cut: the kept prefix never crosses the JSON-RPC pipe
      // (issue #211). Abort any leftover running turn first so beginTurn
      // cannot see AGENT_BUSY after a timed-out retry.
      if (sidecar) {
        await sidecar
          .call("agent.abort", { sessionId: req.sessionId })
          .catch(() => undefined);
      }
      await finishTurn(req.sessionId, "aborted", "TURN_ABORTED");

      try {
        await persistenceOutbox.flush(() => host);
        const truncated = await host.call<{
          revision?: {
            rootUserId?: string;
            revisionCount?: number;
            activeRevision?: number;
          } | null;
        }>("session.truncateFrom", {
          sessionId: req.sessionId,
          ...(truncateFromMessageId ? { fromMessageId: truncateFromMessageId } : {}),
          ...(truncateBefore !== undefined ? { truncateBefore } : {}),
        });
        const revision = truncated.revision;
        if (
          revision?.rootUserId &&
          typeof revision.revisionCount === "number" &&
          typeof revision.activeRevision === "number"
        ) {
          (req as any).__revisionMeta = {
            rootUserId: revision.rootUserId,
            revisionCount: revision.revisionCount,
            activeRevision: revision.activeRevision,
          };
        }
      } catch (error) {
        logger.app("persistence", "warn", "truncate regenerate transcript failed", {
          sessionId: req.sessionId,
          data: String(error),
        });
        throw error;
      }
      if (sidecar) {
        sidecar.clearProjectInstructionRoot(req.sessionId);
        sidecar.clearVendorAuthBindings(req.sessionId);
        await sidecar
          .call("agent.disposeSession", { sessionId: req.sessionId })
          .catch(() => undefined);
      }
      const refreshed = await host.call<{ session?: any }>("session.get", {
        id: req.sessionId,
        messageLimit: 1,
      });
      session = refreshed.session ?? session;
    }

    const launch = await resolveAgentRuntimeLaunch(
      req.sessionId,
      session,
      settings,
    );
    sidecar.setProjectInstructionRoot(req.sessionId, launch.projectPath);

    // Open a durable turn row, then persist the user message under it.
    const turn = await host.call<{ turnId?: string }>("session.beginTurn", {
      sessionId: req.sessionId,
      providerId: launch.providerId,
      modelId: launch.modelId,
    });
    const durableTurnId = String(turn?.turnId ?? "").trim();
    if (!durableTurnId) {
      throw new Error("session.beginTurn returned no turn");
    }
    activeTurns.set(req.sessionId, durableTurnId);
    activeTurnUsages.delete(req.sessionId);

    // Slash expansion (D123, ADR 0024): templates expand before persistence
    // so reseed replays exactly what the model saw; the typed form rides along
    // as `command` for transcript display. Skill aliases are converted into a
    // short model instruction that makes the existing Skill tool call
    // explicit, while the typed form remains the visible transcript chip.
    // Builtin/plugin slash aliases never reach this channel, and unknown
    // /names stay literal text.
    let promptContent = req.content;
    let slashCommand: string | undefined;
    if (req.content.startsWith("/")) {
      try {
        const root = await optionalWorkspaceRoot();
        const commandEnd = req.content.search(/\s/);
        const commandName = req.content.slice(
          1,
          commandEnd === -1 ? undefined : commandEnd,
        );
        const commands = await composerCommandService.buildComposerCommands(
          launch.projectPath ?? root,
        );
        const command = commands.find((item) => item.name === commandName);
        if (command?.kind === "skill" && command.skillId) {
          const body = commandEnd === -1 ? "" : req.content.slice(commandEnd).trim();
          promptContent = [
            `Call the \`Skill\` tool with id ${JSON.stringify(command.skillId)} before answering this request. Follow the loaded skill instructions.`,
            body,
          ]
            .filter(Boolean)
            .join("\n\n");
          slashCommand = req.content;
        } else {
          const templates = await loadComposerTemplatesCached(root);
          const expansion = expandSlashInvocation(req.content, templates);
          if (expansion) {
            promptContent = expansion.expanded;
            slashCommand = expansion.command;
          }
        }
      } catch (error) {
        logger.app("session", "warn", "slash expansion failed; sending literal text", {
          sessionId: req.sessionId,
          data: String(error),
        });
      }
    }

    // The binding's image override already shaped this modelConfig, so the
    // transport gate and the settings switch cannot disagree.
    const supportsVision = visionFromModelConfig(
      launch.sidecarParams.provider.modelConfig,
    );
    let preparedAttachments: PreparedPromptAttachment[];
    try {
      preparedAttachments = await preparePromptAttachments(
        dataDir,
        req.sessionId,
        typeof session.projectPath === "string" && session.projectPath.trim()
          ? session.projectPath.trim()
          : undefined,
        req.attachments ?? [],
        supportsVision,
      );
    } catch (error) {
      await finishTurn(req.sessionId, "error", (error as any)?.errorCode);
      throw error;
    }
    const modelContent = appendPromptFallbackPaths(
      promptContent,
      preparedAttachments,
    );

    // Persist user message
    const revisionMeta = (req as any).__revisionMeta as
      | {
          rootUserId?: string;
          revisionCount?: number;
          activeRevision?: number;
        }
      | undefined;
    // The renderer already shows this row under its own id (D288); persisting
    // and echoing under the same id lets the echo replace it in place.
    const userMessage = {
      id: durableUserMessageId(
        req.messageId,
        Array.isArray(session.messages) ? session.messages : [],
      ),

      role: "user" as const,
      content: promptContent,
      createdAt: new Date().toISOString(),
      status: "complete" as const,
      ...(preparedAttachments.length
        ? { attachments: preparedAttachments.map((attachment) => attachment.message) }
        : {}),
      ...(slashCommand ? { command: slashCommand } : {}),
      ...(revisionMeta?.revisionCount
        ? {
            revisionRootId: revisionMeta.rootUserId,
            revisionCount: revisionMeta.revisionCount,
            activeRevision: revisionMeta.activeRevision,
          }
        : {}),
    };
    try {
      await host.call("session.appendMessage", {
        sessionId: req.sessionId,
        message: userMessage,
        turnId: durableTurnId,
      });
    } catch (error) {
      await finishTurn(
        req.sessionId,
        "error",
        (error as { data?: { errorCode?: string }; errorCode?: string })?.data
          ?.errorCode ??
          (error as { errorCode?: string })?.errorCode,
      );
      throw error;
    }
    emitAgentEvent({
      sessionId: req.sessionId,
      ts: Date.now(),
      event: { type: "message_start", message: userMessage },
    } satisfies AgentEventEnvelope);
    emitAgentEvent({
      sessionId: req.sessionId,
      ts: Date.now(),
      event: { type: "message_end", message: userMessage },
    } satisfies AgentEventEnvelope);

    let result: { accepted: boolean; turnId: string };
    try {
      result = await sidecar.call<{ accepted: boolean; turnId: string }>(
        "agent.prompt",
        {
          ...launch.sidecarParams,
          // The host-created durable turn is the approval identity used by
          // Rust. The runtime must not replace it with a provider-local UUID.
          turnId: durableTurnId,
          content: modelContent,
          attachments: preparedAttachments
            .filter((attachment) => attachment.inlineData)
            .map((attachment) => ({
              path: attachment.message.ref,
              name: attachment.message.name,
              kind: attachment.message.kind,
              mimeType: attachment.message.mimeType,
              size: attachment.message.size,
              data: attachment.inlineData,
            })),
          userMessageId: userMessage.id,
        },
      );
    } catch (e) {
      await finishTurn(req.sessionId, "error", (e as any)?.errorCode);
      throw e;
    }
    logger.app("session", "info", "prompt accepted", {
      sessionId: req.sessionId,
      turnId: result.turnId,
      data: { providerId: launch.providerId, modelId: launch.modelId },
    });
    return result;
    } finally {
      releaseSessionOperation();
    }
  });

  handle(IPC.invoke.agentCompact, async (req: { sessionId: string }) => {
    if (!host || !sidecar) throw new Error("backend unavailable");
    if (activeTurns.has(req.sessionId)) {
      throw Object.assign(new Error("Session already has an active turn"), {
        errorCode: ErrorCodes.AGENT_BUSY,
      });
    }
    const settings = await host.call<any>("settings.get");
    const detail = await host.call<{ session?: any }>("session.get", {
      id: req.sessionId,
    });
    if (!detail.session) {
      throw Object.assign(new Error("Session not found"), {
        errorCode: ErrorCodes.NOT_FOUND,
      });
    }
    const launch = await resolveAgentRuntimeLaunch(
      req.sessionId,
      detail.session,
      settings,
    );
    sidecar.setProjectInstructionRoot(req.sessionId, launch.projectPath);
    const result = await sidecar.call("agent.compact", launch.sidecarParams);
    logger.app("session", "info", "context compacted manually", {
      sessionId: req.sessionId,
      data: { providerId: launch.providerId, modelId: launch.modelId },
    });
    return result;
  });

  handle(IPC.invoke.agentAbort, async (req: { sessionId: string }) => {
    if (!sidecar) throw new Error("sidecar unavailable");
    logger.app("session", "info", "prompt aborted", { sessionId: req.sessionId });
    agentHostBridge?.markAborting(req.sessionId);
    const executionId =
      approvedExecutionIdsBySession.get(req.sessionId) ??
      [...claimedExecutionSessions].find(
        ([, sessionId]) => sessionId === req.sessionId,
      )?.[0];
    let result: unknown;
    try {
      // An open extension prompt resolves with its abort value (spec 16 §9).
      agentExtensions.cancelPrompts(req.sessionId);
      result = await sidecar.call("agent.abort", req);
    } finally {
      await finishTurn(req.sessionId, "aborted", "TURN_ABORTED");
      if (executionId) {
        await finishApprovedExecution(
          executionId,
          "interrupted",
          "PLAN_EXECUTION_INTERRUPTED",
        );
      }
    }
    return result;
  });

  handle(IPC.invoke.agentStop, async (req: AgentStopRequest) => {
    if (!sidecar) throw new Error("sidecar unavailable");
    logger.app("session", "info", "prompt graceful stop requested", {
      sessionId: req.sessionId,
    });
    // The runtime owns the boundary decision. Do not close the durable turn
    // here: agent_end must arrive after the current reply/tool batch completes
    // and finish it as a normal completed turn.
    return sidecar.call("agent.stop", req);
  });

  handle(IPC.invoke.agentGetStatus, async (sessionId: string) => {
    if (!sidecar) throw new Error("sidecar unavailable");
    return sidecar.call("agent.getStatus", { sessionId });
  });

  // The Host-owned turn queue (D375 / D386). The renderer mirrors it; the
  // headless module admits, orders, and drains it.
  handle(IPC.invoke.agentQueuePush, async (req: AgentQueuePushRequest) => {
    if (!agentHostBridge) throw new Error("agent host unavailable");
    return agentHostBridge.queue.push(req);
  });
  handle(IPC.invoke.agentQueueList, async (req: { sessionId: string }) => {
    if (!agentHostBridge) throw new Error("agent host unavailable");
    return { entries: agentHostBridge.queue.list(req.sessionId) };
  });
  handle(IPC.invoke.agentQueueRemove, async (req: { turnId: string }) => {
    if (!agentHostBridge) throw new Error("agent host unavailable");
    await agentHostBridge.queue.remove(req.turnId);
    return { ok: true };
  });
  handle(IPC.invoke.agentQueuePrioritize, async (req: { turnId: string }) => {
    if (!agentHostBridge) throw new Error("agent host unavailable");
    await agentHostBridge.queue.prioritize(req.turnId);
    return { ok: true };
  });

  handle(IPC.invoke.toolResolvePermission, async (resolution: {
    requestId: string;
    decision: string;
  }) => {
    if (!host) throw new Error("host unavailable");
    logger.app("permission", "info", "permission resolved", {
      data: { requestId: resolution.requestId, decision: resolution.decision },
    });
    const resolved = await host.call("permissions.resolve", resolution);
    agentHostBridge?.settleApproval(resolution.requestId, {
      ...(resolution.decision === "allow-once" ||
      resolution.decision === "allow-session" ||
      resolution.decision === "deny"
        ? { decision: resolution.decision }
        : {}),
    });
    return resolved;
  });

  handle(IPC.invoke.askToolResolve, async (resolution: AskToolResolution) => {
    if (!sidecar) throw new Error("sidecar unavailable");
    const sessionId = String(resolution?.sessionId ?? "").trim();
    const requestId = String(resolution?.requestId ?? "").trim();
    if (!sessionId || !requestId) throw new Error("asktool resolution identity required");
    return sidecar.call("asktool.resolve", {
      ...resolution,
      sessionId,
      requestId,
    });
  });

  handle(IPC.invoke.plansPending, async (input: { sessionId?: string } = {}) => {
    if (!host) throw new Error("host unavailable");
    return host.call("plans.pending", {
      ...(typeof input.sessionId === "string" && input.sessionId.trim()
        ? { sessionId: input.sessionId.trim() }
        : {}),
    });
  });

  handle(IPC.invoke.plansResolve, async (resolution: PlanResolveRequest) => {
    if (!host) throw new Error("host unavailable");
    const proposalId = String(resolution?.proposalId ?? "").trim();
    if (!proposalId) throw new Error("proposalId required");
    const sessionId = String(resolution?.sessionId ?? "").trim();
    if (!sessionId) throw new Error("sessionId required");
    const turnId = String(resolution?.turnId ?? "").trim();
    if (!turnId) throw new Error("turnId required");
    const toolCallId = String(resolution?.toolCallId ?? "").trim();
    if (!toolCallId) throw new Error("toolCallId required");
    const action = resolution?.action;
    if (action !== "approve" && action !== "reject") {
      throw new Error("invalid plan approval action");
    }
    let targetPermissionMode: GlobalPermissionMode | undefined;
    if (action === "approve") {
      if (!isGlobalPermissionMode(resolution?.targetPermissionMode)) {
        throw Object.assign(new Error("targetPermissionMode is required for approval"), {
          errorCode: ErrorCodes.PLAN_PERMISSION_MODE_REQUIRED,
        });
      }
      targetPermissionMode = resolution.targetPermissionMode;
    }
    const version =
      typeof resolution?.version === "number" &&
      Number.isSafeInteger(resolution.version) &&
      resolution.version > 0
        ? resolution.version
        : undefined;
    const result = await host.call<PlanResolutionResult>("plans.resolve", {
      proposalId,
      sessionId,
      turnId,
      toolCallId,
      action,
      ...(version !== undefined ? { version } : {}),
      ...(targetPermissionMode ? { targetPermissionMode } : {}),
    });
    agentHostBridge?.settleApproval(proposalId, {
      decision: action,
      ...(targetPermissionMode ? { permissionMode: targetPermissionMode } : {}),
    });
    if (action === "approve") {
      const execution = executionFromResponse(result);
      if (execution) {
        void dispatchApprovedPlan(execution);
      } else {
        void dispatchExecutionForProposal(proposalId);
      }
    }
    return result;
  });

}
