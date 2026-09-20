import { parseComposerPromptDisplay } from "@pi-desktop/shared";
import { randomUUID } from "node:crypto";

import type { RuntimePort, TurnStartRequest, TurnSteerRequest } from "@pi-desktop/agent-host";
import {
  ErrorCodes,
  type AgentEventEnvelope,
  type AgentStatus,
  type AskToolResolution,
  type Risk,
  type UiMessage,
} from "@pi-desktop/shared";

import type { LaunchResolver } from "./launch-resolver.js";
import { resolveSessionMessageInput } from "./session-message-input.js";
import { TurnEventPipeline } from "./turn-events.js";

/** host-core as the turn lifecycle drives it. `HostProcess` satisfies it. */
export type RuntimeHostLink = {
  call<T = unknown>(method: string, params?: unknown): Promise<T>;
  isAvailable(): boolean;
  onNotification(handler: (method: string, params: unknown) => void): () => void;
  onExit(handler: (info: { intentional: boolean }) => void): () => void;
};

/** The agent sidecar as the turn lifecycle drives it. `AgentSidecar` satisfies it. */
export type RuntimeSidecarLink = {
  call<T = unknown>(method: string, params?: unknown): Promise<T>;
  onNotification(handler: (method: string, params: unknown) => void): () => void;
  onExit(handler: (info: { intentional: boolean; code: number | null; signal: NodeJS.Signals | null }) => void): () => void;
  setProjectInstructionRoot(sessionId: string, projectPath?: string): void;
  clearProjectInstructionRoot(sessionId: string): void;
  clearVendorAuthBindings(sessionId: string): void;
};

/**
 * Terminal state of one host turn. `aborted` is reserved for a turn the host
 * cancelled; a graceful stop still ends as `completed` (the runtime owns that
 * boundary decision), and `error` covers a failed turn.
 */
export type TurnEndReason = "completed" | "aborted" | "error";

export type TurnEndedInfo = {
  sessionId: string;
  turnId: string;
  reason: TurnEndReason;
  errorCode?: string;
  /** Whether host-core acknowledged the durable end of this turn. */
  settled: boolean;
};

export type RuntimeLogger = (
  level: "info" | "warn" | "error",
  message: string,
  data?: Record<string, unknown>,
) => void;

export type RuntimeServiceOptions = {
  getHost: () => RuntimeHostLink | null;
  getSidecar: () => RuntimeSidecarLink | null;
  launch: LaunchResolver;
  log: RuntimeLogger;
  now?: () => number;
  /**
   * Rewrite the prompt text before it is persisted and sent, e.g. slash
   * command expansion. Returns `null` to keep the text as typed.
   */
  expandPrompt?: (input: {
    sessionId: string;
    content: string;
    projectPath?: string;
  }) => Promise<{ content: string; command?: string } | null>;
  checkpointIntervalMs?: number;
};

type FinishTurnOptions = { turnId: string; recoverInflight?: boolean };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Keep the renderer-chosen id when it is a UUID the session does not hold (D288). */
export function durableUserMessageId(
  requested: unknown,
  existing: ReadonlyArray<{ id?: unknown }>,
): string {
  if (typeof requested === "string" && UUID_PATTERN.test(requested) && !existing.some((message) => message?.id === requested)) {
    return requested;
  }
  return randomUUID();
}

function typedError(message: string, errorCode: string): Error {
  return Object.assign(new Error(message), { errorCode });
}

function errorCodeOf(error: unknown): string | undefined {
  const candidate = error as { data?: { errorCode?: unknown }; errorCode?: unknown } | null;
  const nested = candidate?.data?.errorCode;
  if (typeof nested === "string") return nested;
  return typeof candidate?.errorCode === "string" ? candidate.errorCode : undefined;
}

/**
 * The turn lifecycle of a headless Host: prompt admission, the durable turn
 * row, turn ownership and finalization, and the runtime control calls the
 * Agent Host module needs (`RuntimePort`). It knows host-core and the sidecar
 * only through their stdio links, so it runs wherever those two processes
 * run; the per-event persistence pass lives in `TurnEventPipeline`.
 */
export class RuntimeService implements RuntimePort {
  private readonly activeTurns = new Map<string, string>();
  private readonly turnFinalizations = new Map<string, Promise<void>>();
  private readonly pendingAbortReasons = new Map<string, TurnEndReason>();
  private readonly sessionOperations = new Map<string, Promise<void>>();
  private readonly listeners = new Set<(envelope: AgentEventEnvelope) => void>();
  private readonly turnEndListeners = new Set<(info: TurnEndedInfo) => void>();
  private readonly events: TurnEventPipeline;
  private readonly detachers: Array<() => void> = [];
  private readonly now: () => number;
  private disposed = false;

  constructor(private readonly options: RuntimeServiceOptions) {
    this.now = options.now ?? (() => Date.now());
    this.events = new TurnEventPipeline({
      getHost: () => options.getHost(),
      ownership: {
        activeTurnId: (sessionId) => this.activeTurns.get(sessionId),
        isStaleTerminalEvent: (envelope) => this.isStaleTerminalEvent(envelope),
        finishTurn: (sessionId, status, errorCode, finishOptions) =>
          this.finishTurn(sessionId, status, errorCode, finishOptions),
      },
      emit: (envelope) => this.emit(envelope),
      log: options.log,
      now: this.now,
      checkpointIntervalMs: options.checkpointIntervalMs,
    });
  }

  // -------------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------------

  /** Observe a (re)started host-core: permission requests become agent events. */
  attachHost(host: RuntimeHostLink): void {
    const off = host.onNotification((method, params) => {
      if (this.options.getHost() !== host) return;
      if (method !== "permissions.request") return;
      const permission = params as {
        requestId: string;
        sessionId: string;
        toolCallId: string;
        toolName: string;
        argsPreview: string;
        risk: Risk;
        reason: string;
      };
      // A delegate's call is already tracked by the time the host asks: the
      // sidecar forwards tool_start before it executes the tool.
      const asking = this.events.toolCall(permission.sessionId, permission.toolCallId);
      const turnId = asking?.turnId ?? this.activeTurns.get(permission.sessionId);
      this.options.log("info", "permission requested", {
        requestId: permission.requestId,
        sessionId: permission.sessionId,
        turnId,
        toolCallId: permission.toolCallId,
        toolName: permission.toolName,
        risk: permission.risk,
      });
      this.emit({
        sessionId: permission.sessionId,
        ...(turnId ? { turnId } : {}),
        ts: this.now(),
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
            ...(asking?.agentName ? { agentName: asking.agentName } : {}),
            ...(asking?.parentToolCallId ? { parentToolCallId: asking.parentToolCallId } : {}),
          },
        },
      });
    });
    this.detachers.push(off);
  }

  /** Observe a (re)started sidecar: its agent events feed the lifecycle. */
  attachSidecar(sidecar: RuntimeSidecarLink): void {
    const offEvents = sidecar.onNotification((method, params) => {
      if (this.options.getSidecar() !== sidecar) return;
      if (method !== "agent.event") return;
      this.events.handle(params as AgentEventEnvelope);
    });
    const offExit = sidecar.onExit(({ intentional, code, signal }) => {
      if (this.options.getSidecar() !== sidecar) return;
      const interrupted = this.events.onSidecarExit();
      if (intentional || this.disposed) return;
      for (const tool of interrupted) {
        this.options.log("error", "tool execution interrupted", {
          sessionId: tool.sessionId,
          turnId: tool.turnId,
          toolCallId: tool.toolCallId,
          toolName: tool.toolName,
          reason: "agent_sidecar_exit",
          exitCode: code,
          signal,
        });
      }
      for (const sessionId of [...this.activeTurns.keys()]) {
        const crashedTurnId = this.activeTurns.get(sessionId);
        if (!crashedTurnId) continue;
        void this.settleCrashedSession(sessionId, crashedTurnId).catch((error: unknown) => {
          this.options.log("warn", "crashed-turn settlement failed", { sessionId, error: String(error) });
        });
      }
    });
    this.detachers.push(offEvents, offExit);
  }

  onEvent(listener: (envelope: AgentEventEnvelope) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onTurnEnded(listener: (info: TurnEndedInfo) => void): () => void {
    this.turnEndListeners.add(listener);
    return () => this.turnEndListeners.delete(listener);
  }

  /** Transcript rows still waiting for host-core. */
  pendingWrites(): number {
    return this.events.pendingWrites();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const detach of this.detachers.splice(0)) detach();
    await this.events.dispose();
    this.listeners.clear();
    this.turnEndListeners.clear();
  }

  // -------------------------------------------------------------------------
  // RuntimePort
  // -------------------------------------------------------------------------

  async prompt(request: TurnStartRequest): Promise<{ turnId: string }> {
    const sessionId = request.sessionId.trim();
    if (!sessionId) throw typedError("sessionId required", ErrorCodes.INVALID_ARGUMENT);
    if (sessionId.startsWith("native-pi:")) {
      throw typedError("Native Pi sessions are not available on a headless host", "NATIVE_PI_UNSUPPORTED");
    }
    if (request.attachments?.length) {
      throw typedError("Prompt attachments are not supported by the headless runtime yet", ErrorCodes.INVALID_ARGUMENT);
    }
    try {
      return await this.withSessionOperation(sessionId, () => this.startTurn(sessionId, request));
    } catch (error) {
      if (request.sessionMessageId) {
        const host = this.options.getHost();
        await host
          ?.call("session.collaboration.fail", {
            messageId: request.sessionMessageId,
            error: error instanceof Error ? error.message : String(error),
          })
          .catch((persistenceError: unknown) => {
            this.options.log("warn", "collaboration dispatch failure persistence failed", {
              sessionId,
              messageId: request.sessionMessageId,
              error: String(persistenceError),
            });
          });
      }
      throw error;
    }
  }

  /** True when the effective per-turn mode narrows or otherwise differs from
   * the session's stored `permissionMode`; used to decide whether to forward a
   * per-turn override to the sidecar. A widening request has already been
   * refused by the agent-host bridge before reaching here. */
  private sessionModeDiffers(
    session: Record<string, unknown> | null | undefined,
    effective: string,
  ): boolean {
    const stored = session && typeof session.permissionMode === "string" ? session.permissionMode : undefined;
    return stored !== undefined && stored !== effective;
  }

  private async startTurn(sessionId: string, request: TurnStartRequest): Promise<{ turnId: string }> {
    const host = this.requireHost();
    const sidecar = this.requireSidecar();
    const sessionMessage = await resolveSessionMessageInput(host, {
      sessionId,
      ...(request.sessionMessageId !== undefined ? { sessionMessageId: request.sessionMessageId } : {}),
    });
    const settings = await host.call<Record<string, unknown>>("settings.get");
    const detail = await host.call<{ session?: Record<string, unknown> | null }>("session.get", {
      id: sessionId,
      messageLimit: 1,
    });
    const session = detail.session;
    if (!session) throw typedError("Session not found", ErrorCodes.NOT_FOUND);
    if (this.activeTurns.has(sessionId)) {
      throw typedError("Session already has an active turn", ErrorCodes.AGENT_BUSY);
    }
    const launch = await this.options.launch.resolve(sessionId, session, settings ?? {});
    sidecar.setProjectInstructionRoot(sessionId, launch.projectPath);

    const turnId = await this.beginTurn(sessionId, launch.providerId, launch.modelId, sessionMessage?.origin.messageId);

    let content = sessionMessage?.content ?? request.content;
    let command: string | undefined;
    if (!sessionMessage && this.options.expandPrompt && content.startsWith("/")) {
      try {
        const expanded = await this.options.expandPrompt({ sessionId, content, projectPath: launch.projectPath });
        if (expanded) {
          content = expanded.content;
          command = expanded.command;
        }
      } catch (error) {
        this.options.log("warn", "slash expansion failed; sending literal text", { sessionId, error: String(error) });
      }
    }
    const existing = Array.isArray(session.messages) ? (session.messages as Array<{ id?: unknown }>) : [];
    const userMessage: UiMessage = {
      id: durableUserMessageId(request.userMessageId, existing),
      role: "user",
      content,
      ...(sessionMessage ? { sessionMessage: sessionMessage.origin } : {}),
      composerDisplay: parseComposerPromptDisplay(request.composerDisplay),
      createdAt: new Date(this.now()).toISOString(),
      status: "complete",
      ...(command ? { command } : {}),
    };
    try {
      await host.call("session.appendMessage", { sessionId, message: userMessage, turnId });
    } catch (error) {
      await this.finishTurn(sessionId, "error", errorCodeOf(error), { turnId });
      // A turn whose user message could not be appended must not be started:
      // running it would execute a prompt the transcript does not contain.
      throw error;
    }
    this.emit({ sessionId, turnId, ts: this.now(), event: { type: "message_start", message: userMessage } });
    this.emit({ sessionId, turnId, ts: this.now(), event: { type: "message_end", message: userMessage } });

    let result: { accepted: boolean; turnId: string };
    try {
      result = await sidecar.call<{ accepted: boolean; turnId: string }>("agent.prompt", {
        ...launch.sidecarParams,
        // The host-created durable turn is the approval identity used by
        // Rust. The runtime must not replace it with a provider-local UUID.
        turnId,
        content,
        ...(sessionMessage ? { sessionMessage: sessionMessage.origin } : {}),
        attachments: [],
        userMessageId: userMessage.id,
        // Per-turn permission ceiling override (R1 leftover; spec §7.3). Only
        // forwarded when the effective mode differs from the session's stored
        // mode — a widening request has already been refused upstream so any
        // override that reaches here is narrower than or equal to session.
        ...(request.effectivePermissionMode && this.sessionModeDiffers(session, request.effectivePermissionMode)
          ? { permissionMode: request.effectivePermissionMode }
          : {}),
      });
    } catch (error) {
      await this.finishTurn(sessionId, "error", errorCodeOf(error), { turnId });
      throw error;
    }
    this.options.log("info", "prompt accepted", {
      sessionId,
      turnId: result.turnId,
      providerId: launch.providerId,
      modelId: launch.modelId,
    });
    return { turnId };
  }

  async steer(request: TurnSteerRequest): Promise<{ accepted: boolean }> {
    const sessionId = request.sessionId.trim();
    if (!this.isTurnDispatchable(sessionId, request.turnId)) return { accepted: false };
    try {
      const host = this.requireHost();
      const sidecar = this.requireSidecar();
      await sidecar.call("agent.steeringContext", { sessionId, expectedTurnId: request.turnId });
      const detail = await host.call<{ session?: { messages?: UiMessage[] } }>("session.get", {
        id: sessionId,
        messageLimit: 1,
      });
      const message: UiMessage = {
        id: durableUserMessageId(request.sessionMessageId, detail.session?.messages ?? []),
        role: "user",
        content: request.content,
        composerDisplay: parseComposerPromptDisplay(request.composerDisplay),
        status: "complete",
        createdAt: new Date(this.now()).toISOString(),
        steering: true,
      };
      const result = await sidecar.call<{ accepted?: boolean }>("agent.steer", {
        sessionId,
        expectedTurnId: request.turnId,
        message,
        content: request.content,
        attachments: [],
      });
      return { accepted: result?.accepted !== false };
    } catch (error) {
      this.options.log("warn", "steer failed", { sessionId, turnId: request.turnId, error: String(error) });
      return { accepted: false };
    }
  }

  async stop(sessionId: string): Promise<{ requested: boolean }> {
    const sidecar = this.requireSidecar();
    this.options.log("info", "prompt graceful stop requested", { sessionId });
    // The runtime owns the boundary decision: agent_end arrives after the
    // current reply/tool batch completes and finishes it as a completed turn.
    const result = await sidecar.call<{ requested?: boolean }>("agent.stop", { sessionId });
    return { requested: result?.requested ?? false };
  }

  async abort(sessionId: string, turnId?: string): Promise<void> {
    const sidecar = this.requireSidecar();
    const abortedTurnId = this.activeTurns.get(sessionId);
    if (turnId && abortedTurnId !== turnId) return;
    this.options.log("info", "prompt aborted", { sessionId });
    // Lock the abort reason before the first await: the cancel RPC can take a
    // while, and a terminal event arriving in that window must not settle the
    // turn as completed.
    this.lockAbortReason(sessionId, abortedTurnId);
    try {
      await sidecar.call("agent.abort", { sessionId, ...(turnId ? { turnId } : {}) });
    } finally {
      if (abortedTurnId) {
        await this.finishTurn(sessionId, "aborted", "TURN_ABORTED", { turnId: abortedTurnId });
      }
    }
  }

  async respondInput(resolution: AskToolResolution): Promise<void> {
    const sessionId = String(resolution.sessionId ?? "").trim();
    const requestId = String(resolution.requestId ?? "").trim();
    if (!sessionId || !requestId) throw typedError("asktool resolution identity required", ErrorCodes.INVALID_ARGUMENT);
    await this.requireSidecar().call("asktool.resolve", { ...resolution, sessionId, requestId });
  }

  /** Manual context checkpoint on an idle session. */
  async compact(sessionId: string): Promise<{ accepted: boolean }> {
    if (this.activeTurns.has(sessionId)) throw typedError("Session already has an active turn", ErrorCodes.AGENT_BUSY);
    const host = this.requireHost();
    const sidecar = this.requireSidecar();
    const settings = await host.call<Record<string, unknown>>("settings.get");
    const detail = await host.call<{ session?: Record<string, unknown> | null }>("session.get", { id: sessionId });
    if (!detail.session) throw typedError("Session not found", ErrorCodes.NOT_FOUND);
    const launch = await this.options.launch.resolve(sessionId, detail.session, settings ?? {});
    sidecar.setProjectInstructionRoot(sessionId, launch.projectPath);
    const result = await sidecar.call<{ accepted?: boolean }>("agent.compact", launch.sidecarParams);
    return { accepted: result?.accepted !== false };
  }

  async getStatus(sessionId: string): Promise<AgentStatus> {
    const result = await this.requireSidecar().call<{ status?: AgentStatus }>("agent.getStatus", { sessionId });
    return result?.status ?? { sessionId, isRunning: false, pendingToolConfirmations: 0 };
  }

  isBusy(sessionId: string): boolean {
    const id = sessionId.trim();
    if (!id) return false;
    if (this.activeTurns.has(id)) return true;
    const prefix = `${id}:`;
    for (const key of this.turnFinalizations.keys()) {
      if (key.startsWith(prefix)) return true;
    }
    return false;
  }

  activeTurnId(sessionId: string): string | undefined {
    return this.activeTurns.get(sessionId);
  }

  // -------------------------------------------------------------------------
  // Turn ownership
  // -------------------------------------------------------------------------

  /** Serialize turn admission and abort per session. */
  async withSessionOperation<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const id = sessionId.trim();
    const previous = this.sessionOperations.get(id) ?? Promise.resolve();
    const result = previous.then(operation);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.sessionOperations.set(id, settled);
    try {
      return await result;
    } finally {
      if (this.sessionOperations.get(id) === settled) this.sessionOperations.delete(id);
    }
  }

  /** Open a durable turn row and take ownership of the session for it. */
  async beginTurn(sessionId: string, providerId: string, modelId: string, sessionMessageId?: string): Promise<string> {
    const turn = await this.requireHost().call<{ turnId?: string }>("session.beginTurn", {
      sessionId,
      providerId,
      modelId,
      ...(sessionMessageId ? { sessionMessageId } : {}),
    });
    const turnId = String(turn?.turnId ?? "").trim();
    if (!turnId) throw new Error("session.beginTurn returned no turn");
    this.activeTurns.set(sessionId, turnId);
    this.events.resetTurnUsage(sessionId);
    return turnId;
  }

  private isActiveTurn(sessionId: string, turnId: string | null | undefined): boolean {
    if (typeof turnId !== "string") return false;
    const id = sessionId.trim();
    const turn = turnId.trim();
    if (!id || !turn) return false;
    return this.activeTurns.get(id) === turn;
  }

  private isTurnDispatchable(sessionId: string, turnId: string | null | undefined): boolean {
    if (!this.isActiveTurn(sessionId, turnId)) return false;
    const key = turnKey(sessionId.trim(), String(turnId).trim());
    return !this.pendingAbortReasons.has(key) && !this.turnFinalizations.has(key);
  }

  private lockAbortReason(sessionId: string, turnId: string | null | undefined): void {
    if (!this.isActiveTurn(sessionId, turnId)) return;
    this.pendingAbortReasons.set(turnKey(sessionId.trim(), String(turnId).trim()), "aborted");
  }

  private isStaleTerminalEvent(envelope: AgentEventEnvelope): boolean {
    const type = envelope.event.type;
    if (type !== "agent_end" && type !== "error") return false;
    // A delegate's terminal event settles the delegate, never its parent's turn.
    if (envelope.parentToolCallId) return true;
    return !this.isActiveTurn(envelope.sessionId, envelope.turnId);
  }

  /**
   * Settle one host turn: attempt its durable end, release local ownership,
   * then announce it. Ownership is claimed and the terminal reason frozen
   * synchronously, before any await, so a concurrent terminal event joins this
   * finalization instead of starting a second one, and a cancellation recorded
   * earlier cannot be restated as a completion later.
   */
  finishTurn(
    sessionId: string,
    status: TurnEndReason,
    errorCode: string | undefined,
    options: FinishTurnOptions,
  ): Promise<void> {
    const id = sessionId.trim();
    const turnId = String(options.turnId ?? "").trim();
    if (!id || !turnId) return Promise.resolve();
    const key = turnKey(id, turnId);
    const existing = this.turnFinalizations.get(key);
    if (existing) return existing;
    if (!this.isActiveTurn(id, turnId)) {
      this.pendingAbortReasons.delete(key);
      return Promise.resolve();
    }
    const reason = this.pendingAbortReasons.get(key) ?? status;
    const turnUsage = this.events.takeTurnUsage(id);
    const recoverInflight = options.recoverInflight === true;
    let settled = false;

    const run = async (): Promise<void> => {
      try {
        const host = this.options.getHost();
        if (host) {
          try {
            const result = await host.call<{ ok: boolean; recovered?: UiMessage }>("session.endTurn", {
              turnId,
              status: reason,
              errorCode,
              createNotification: false,
              ...(turnUsage ? { usage: turnUsage } : {}),
              ...(recoverInflight ? { recoverInflight: true } : {}),
            });
            settled = true;
            if (result.recovered) {
              this.emit({ sessionId: id, turnId, ts: this.now(), event: { type: "message_end", message: result.recovered } });
            }
          } catch (error) {
            this.options.log("warn", "endTurn failed", { sessionId: id, turnId, error: String(error) });
          }
        }
      } finally {
        if (this.activeTurns.get(id) === turnId) this.activeTurns.delete(id);
        this.events.scheduleToolCallCleanup(id, turnId);
      }
    };
    const release = (): void => {
      if (this.turnFinalizations.get(key) !== record) return;
      this.turnFinalizations.delete(key);
      this.pendingAbortReasons.delete(key);
      const info: TurnEndedInfo = { sessionId: id, turnId, reason, ...(errorCode ? { errorCode } : {}), settled };
      for (const listener of this.turnEndListeners) {
        try {
          listener(info);
        } catch (error) {
          this.options.log("warn", "turn end listener failed", { sessionId: id, turnId, error: String(error) });
        }
      }
    };
    const record: Promise<void> = Promise.resolve().then(run).finally(release);
    this.turnFinalizations.set(key, record);
    return record;
  }

  private async settleCrashedSession(sessionId: string, crashedTurnId: string): Promise<void> {
    const host = this.options.getHost();
    if (host) await host.call("plans.abort", { sessionId }).catch(() => undefined);
    if (this.activeTurns.get(sessionId) !== crashedTurnId) return;
    // No final row is coming from a dead sidecar: keep whatever the reply had
    // streamed so far as an aborted transcript row (D299).
    await this.events.flushCheckpoint(sessionId);
    if (this.activeTurns.get(sessionId) !== crashedTurnId) return;
    this.events.settleCheckpoint(sessionId);
    await this.finishTurn(sessionId, "aborted", "PLAN_APPROVAL_INTERRUPTED", {
      turnId: crashedTurnId,
      recoverInflight: true,
    });
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  private emit(envelope: AgentEventEnvelope): void {
    for (const listener of this.listeners) {
      try {
        listener(envelope);
      } catch (error) {
        this.options.log("warn", "agent event listener failed", {
          sessionId: envelope.sessionId,
          type: envelope.event.type,
          error: String(error),
        });
      }
    }
  }

  private requireHost(): RuntimeHostLink {
    const host = this.options.getHost();
    if (!host) throw typedError("host unavailable", ErrorCodes.HOST_UNAVAILABLE);
    return host;
  }

  private requireSidecar(): RuntimeSidecarLink {
    const sidecar = this.options.getSidecar();
    if (!sidecar) throw typedError("sidecar unavailable", ErrorCodes.AGENT_UNAVAILABLE);
    return sidecar;
  }
}

function turnKey(sessionId: string, turnId: string): string {
  return `${sessionId}:${turnId}`;
}
