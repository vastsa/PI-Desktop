import { randomUUID } from "node:crypto";
import type {
  AgentStatus,
  AppSettings,
  SessionCollaborationDelivery,
  SessionCollaborationMessage,
  SessionCollaborationSummary,
} from "@pi-desktop/shared";
import { DESKTOP_PRINCIPAL, type AgentHostBridge } from "../agent-host-bridge";
import { listReadyPluginModels, parsePluginModelKey } from "../plugin-agent-complete";
import type { McpControlInvokeInput } from "../mcp-control";

type Host = { call<T>(method: string, params?: Record<string, unknown>): Promise<T> };
type Sidecar = { call<T>(method: string, params: Record<string, unknown>): Promise<T> };

/** Shared by the plugin and the sidebar: durable outcomes plus live activity. */
export async function readSessionCollaboration(
  host: Host,
  sidecar: Sidecar | null,
  sessionId: string,
): Promise<SessionCollaborationSummary> {
  const [summary, live] = await Promise.all([
    host.call<SessionCollaborationSummary>("session.collaboration.status", { sessionId }),
    sidecar?.call<{ status: AgentStatus }>("agent.getStatus", { sessionId }),
  ]);
  if (live?.status.sessionId === sessionId && live.status.isRunning) {
    return {
      ...summary,
      status: live.status.pendingToolConfirmations > 0 ? "waiting_permission" : "running",
      observedAt: new Date().toISOString(),
    };
  }
  return summary;
}

export type SessionCollaborationDependencies = {
  getHost: () => Host | null;
  getSidecar: () => Sidecar | null;
  getBridge: () => AgentHostBridge | null;
  getActiveTurn: (sessionId: string) => string | undefined;
  flushTranscript: () => Promise<boolean>;
  isPluginLoaded: (pluginId: string) => boolean;
  isQuitting: () => boolean;
  onChanged: () => void;
  log: (message: string, data: Record<string, unknown>) => void;
};

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code, errorCode: code });
}

function text(input: Record<string, unknown>, key: string, required = true): string | undefined {
  const value = input[key];
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || !value.trim()) fail("INVALID_ARGUMENT", `${key} must be a nonempty string`);
  return value.trim();
}

function messageKind(value: unknown): "task" | "message" {
  if (value === undefined) return "message";
  if (value !== "task" && value !== "message") fail("INVALID_ARGUMENT", "kind must be task or message");
  return value;
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = error as { code?: string; errorCode?: string; data?: { errorCode?: string } };
  return value.data?.errorCode ?? value.errorCode ?? value.code;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try { return JSON.stringify(error) ?? String(error); } catch { return String(error); }
}

function delivery(message: SessionCollaborationMessage): SessionCollaborationDelivery {
  return {
    sessionId: message.targetSessionId,
    messageId: message.id,
    status: message.status,
    ...(message.turnId ? { turnId: message.turnId } : {}),
  };
}

/** Coordinates reviewed operations; Rust owns all identity and outcome state. */
export function createSessionCollaborationService(deps: SessionCollaborationDependencies) {
  const dispatching = new Map<string, Promise<SessionCollaborationDelivery>>();
  // Turn IDs awaiting settlement. The host keys the receipt by the turn row in
  // its own database, so an entry orphaned by a host restart is replayed there.
  const settlements = new Set<string>();
  let draining: Promise<void> | undefined;
  let dirty = false;

  function requireHost(): Host {
    if (deps.isQuitting()) fail("ABORTED", "The application is shutting down");
    const host = deps.getHost();
    if (!host) fail("HOST_UNAVAILABLE", "The host is unavailable");
    return host;
  }

  function checkCurrent(host: Host, signal?: AbortSignal): void {
    if (signal?.aborted || deps.isQuitting()) fail("ABORTED", "The session operation was cancelled");
    if (deps.getHost() !== host) fail("HOST_UNAVAILABLE", "The host restarted during the session operation");
  }

  function sender(input: McpControlInvokeInput): { pluginId: string; sourceSessionId: string; sourceTurnId: string } {
    const context = input.pluginContext;
    if (!context?.sessionId || !context.turnId || !context.invocationId
      || deps.getActiveTurn(context.sessionId) !== context.turnId) {
      fail("PERMISSION_DENIED", "Sending requires an active, host-authenticated Agent tool invocation");
    }
    return { pluginId: context.pluginId, sourceSessionId: context.sessionId, sourceTurnId: context.turnId };
  }

  async function dispatch(message: SessionCollaborationMessage, signal?: AbortSignal): Promise<SessionCollaborationDelivery> {
    const existing = dispatching.get(message.id);
    if (existing) return existing;
    const operation = (async () => {
      const host = requireHost();
      try {
        checkCurrent(host, signal);
        let current = (await host.call<{ message?: SessionCollaborationMessage }>(
          "session.collaboration.message", { messageId: message.id },
        )).message;
        checkCurrent(host, signal);
        if (!current) fail("NOT_FOUND", "Session message not found");
        if (current.status !== "queued") return delivery(current);
        const bridge = deps.getBridge();
        if (!bridge || !deps.getSidecar()) fail("HOST_UNAVAILABLE", "The Agent runtime is unavailable");
        if (bridge.queue.list(current.targetSessionId).some((entry) => entry.sessionMessageId === message.id)) {
          return delivery(current);
        }
        if (!deps.isPluginLoaded(current.pluginId)) fail("ABORTED", "The sending plugin is no longer enabled");
        if (current.currentTurn?.state === "offered") {
          const turnId = current.currentTurn.turnId;
          const gate = deps.getActiveTurn(current.targetSessionId) === turnId
            ? await deps.getSidecar()!.call<{ accepting: boolean }>("agent.collaborationContext", {
              sessionId: current.targetSessionId, expectedTurnId: turnId,
            }) : { accepting: false };
          checkCurrent(host, signal);
          if (gate.accepting) return delivery(current);
          // A CAS release arbitrates against concurrent runtime acceptance. A
          // lost receive acknowledgement cannot become a second queued prompt.
          current = (await host.call<{ message: SessionCollaborationMessage }>(
            "session.collaboration.release", { messageId: current.id, turnId },
          )).message;
          checkCurrent(host, signal);
          if (current.status !== "queued" || current.currentTurn?.state !== "fallback") return delivery(current);
        }
        // beginTurn rechecks the persisted authorization ceiling at execution,
        // including when a queued turn resumes after settings have changed.
        await bridge.agentHost.startTurn(DESKTOP_PRINCIPAL, {
          sessionId: current.targetSessionId,
          input: { text: current.content, sessionMessageId: current.id },
          admission: "queue",
          idempotencyKey: `session-message:${current.id}`,
          context: { requestId: `session-message:${current.id}` },
        });
        checkCurrent(host);
        const accepted = (await host.call<{ message: SessionCollaborationMessage }>(
          "session.collaboration.message", { messageId: current.id },
        )).message;
        if (signal?.aborted) await cancel(host, { sessionId: current.targetSessionId, messageId: current.id });
        deps.onChanged();
        return delivery(accepted);
      } catch (error) {
        // A full callback inbox is deferred until a later queue/turn change.
        // It must not turn a successfully completed original task into failure.
        const knownRejection = ["ABORTED", "PERMISSION_DENIED", "MODEL_NOT_CONFIGURED", "INVALID_ARGUMENT"].includes(errorCode(error) ?? "");
        const deferred = errorCode(error) === "AGENT_BUSY" && (message.kind === "completion" || !!message.currentTurn);
        if (deps.getHost() === host && !deferred && (!message.currentTurn || knownRejection)) {
          // The host persists free text, so the code is embedded to keep the
          // stored failure machine-readable and bounded.
          const persisted = `${errorCode(error) ?? "FAILED"}: ${errorMessage(error)}`;
          await host.call("session.collaboration.fail", {
            messageId: message.id,
            error: persisted.slice(0, 2000),
          }).catch((persistenceError: unknown) => deps.log("Session delivery failure could not be saved", {
            messageId: message.id, error: String(persistenceError),
          }));
        }
        throw error;
      }
    })();
    dispatching.set(message.id, operation);
    try { return await operation; }
    finally { if (dispatching.get(message.id) === operation) dispatching.delete(message.id); }
  }

  async function cancel(host: Host, args: Record<string, unknown>) {
    const result = await host.call<{
      sessionId: string; cancelled: true; sessionRetained: true; messageIds: string[]; runningTurnIds: string[];
    }>("session.collaboration.cancel", args);
    checkCurrent(host);
    const bridge = deps.getBridge();
    if (bridge) {
      for (const messageId of result.messageIds) await bridge.queue.cancelSessionMessage(result.sessionId, messageId);
      for (const turnId of result.runningTurnIds) {
        // The exact turn guard prevents a late cancellation from stopping a
        // newer task in this reusable session.
        if (deps.getActiveTurn(result.sessionId) === turnId) {
          await bridge.interruptSessionMessage(result.sessionId, turnId);
        }
      }
    }
    deps.onChanged();
    return { sessionId: result.sessionId, cancelled: true, sessionRetained: true };
  }

  async function drain(): Promise<void> {
    // Re-entrant, self-healing: a caller arriving while a pass is running flags
    // dirty and awaits it, then re-checks. This also closes the narrow window
    // where a settlement is queued right as a running pass decides to stop, so a
    // completion callback is never deferred to an unrelated later trigger.
    for (;;) {
      if (draining) {
        dirty = true;
        await draining;
        if (!dirty) return;
        continue;
      }
      if (!deps.getHost() || deps.isQuitting()) return;
      draining = (async () => {
        do {
          // Cleared first so a throwing pass cannot keep re-running the loop.
          dirty = false;
          const host = requireHost();
          if (settlements.size && await deps.flushTranscript()) {
            checkCurrent(host);
            for (const turnId of settlements) {
              // Settling is idempotent host-side, so entries recorded against a
              // previous host are replayed rather than dropped. A failing call
              // keeps its entry for a later drain.
              await host.call("session.collaboration.settle", { turnId });
              settlements.delete(turnId);
            }
          }
          const pending = await host.call<{ messages: SessionCollaborationMessage[] }>("session.collaboration.pending", {});
          checkCurrent(host);
          await Promise.all(pending.messages.map(async (message) => {
            try { await dispatch(message); }
            catch (error) {
              deps.log("Session completion delivery is pending or failed", { messageId: message.id, error: String(error) });
            }
          }));
        } while (dirty);
      })();
      try { await draining; }
      finally { draining = undefined; }
      if (dirty) continue;
      return;
    }
  }

  return {
    /** Runtime-only entry: fence the exact turn and order all preceding tool
     * results before the durable incoming transcript input. */
    async receive(params: Record<string, unknown>): Promise<unknown> {
      const sessionId = text(params, "sessionId")!;
      const turnId = text(params, "turnId")!;
      const requestId = text(params, "requestId")!;
      const host = requireHost();
      if (deps.getActiveTurn(sessionId) !== turnId) return { messages: [] };
      const sidecar = deps.getSidecar();
      if (!sidecar) fail("HOST_UNAVAILABLE", "The Agent runtime is unavailable");
      if (!await deps.flushTranscript()) fail("HOST_UNAVAILABLE", "Transcript persistence is pending");
      checkCurrent(host);
      const gate = await sidecar.call<{ accepting: boolean }>("agent.collaborationContext", {
        sessionId, expectedTurnId: turnId,
      });
      checkCurrent(host);
      if (!gate.accepting || deps.getActiveTurn(sessionId) !== turnId) return { messages: [] };
      const received = await host.call("session.collaboration.receive", { sessionId, turnId, requestId });
      checkCurrent(host);
      deps.onChanged();
      return received;
    },
    async invoke(input: McpControlInvokeInput): Promise<unknown> {
      if (input.source !== "plugin" || !input.pluginContext?.pluginId) {
        fail("PERMISSION_DENIED", "Session collaboration requires a trusted plugin context");
      }
      const args = input.args?.[0];
      if (input.args?.length !== 1 || !args || typeof args !== "object" || Array.isArray(args)) {
        fail("INVALID_ARGUMENT", "One session operation object is required");
      }
      const data = args as Record<string, unknown>;
      const host = requireHost();
      checkCurrent(host, input.signal);
      switch (input.operation) {
        case "session/collaboration/status":
          await drain();
          return readSessionCollaboration(host, deps.getSidecar(), text(data, "sessionId")!);
        case "session/collaboration/list":
          await drain();
          return host.call("session.collaboration.list", {});
        case "session/collaboration/result":
          await drain();
          return host.call("session.collaboration.result", {
            sessionId: text(data, "sessionId"), messageId: text(data, "messageId", false), turnId: text(data, "turnId", false),
          });
        case "session/collaboration/cancel": {
          const result = await cancel(host, {
            sessionId: text(data, "sessionId"), messageId: text(data, "messageId", false),
            pluginId: input.pluginContext.pluginId,
            ...(input.pluginContext.sessionId ? { sourceSessionId: input.pluginContext.sessionId } : {}),
          });
          await drain();
          return result;
        }
        case "session/collaboration/spawn":
        case "session/collaboration/send": {
          const source = sender(input);
          const spawn = input.operation.endsWith("/spawn");
          const content = text(data, spawn ? "task" : "content");
          const notify = data.notifyOnCompletion;
          if (notify !== undefined && typeof notify !== "boolean") fail("INVALID_ARGUMENT", "notifyOnCompletion must be a boolean");
          let model: { providerId: string; modelId: string } | null = null;
          if (spawn) {
            const [listed, settings] = await Promise.all([
              host.call<{ providers: Parameters<typeof listReadyPluginModels>[0] }>("providers.list", { includeDisabled: false }),
              host.call<AppSettings>("settings.get"),
            ]);
            checkCurrent(host, input.signal);
            const models = listReadyPluginModels(listed.providers, settings);
            const requested = text(data, "modelKey", false);
            const chosen = requested ? models.find((item) => item.key === requested)
              : models.find((item) => item.availableForSubagents) ?? models.find((item) => item.isDefault);
            if (!chosen) fail("MODEL_NOT_CONFIGURED", "No matching configured model is available");
            // A worker the agent starts is AI-driven delegation, so naming a model here
            // needs that model's own `availableForSubagents` opt-in — the gate `Task.model`
            // already applies (ADR subagent-model-opt-in; #386). Inheriting stays open, and
            // naming the default is that inheritance spelled out, the way repeating a
            // definition's own pin is on the Task path.
            if (requested && !chosen.availableForSubagents && !chosen.isDefault) {
              fail("PERMISSION_DENIED", `Model "${requested}" is not enabled for AI delegation. Turn on "Available for AI delegation" for it in model settings, or omit modelKey to inherit.`);
            }
            model = parsePluginModelKey(chosen.key);
          }
          checkCurrent(host, input.signal);
          sender(input);
          const response = await host.call<{ message: SessionCollaborationMessage }>(`session.collaboration.${spawn ? "spawn" : "send"}`, {
            ...source, content,
            idempotencyKey: text(data, "idempotencyKey", false) ?? randomUUID(),
            ...(typeof notify === "boolean" ? { notifyOnCompletion: notify } : {}),
            ...(spawn ? { ...model, title: text(data, "title", false) }
              : { sessionId: text(data, "sessionId"), kind: messageKind(data.kind) }),
          });
          return dispatch(response.message, input.signal);
        }
        default: fail("NOT_FOUND", "Unknown session collaboration operation");
      }
    },
    // The session ID stays part of the runtime callback contract; the host
    // resolves the receipt from the turn ID alone.
    async settle(_sessionId: string, turnId: string): Promise<void> {
      const host = deps.getHost();
      if (!host || deps.isQuitting()) return;
      settlements.add(turnId);
      // Let final message_end enqueues from this event-loop turn reach the outbox.
      await new Promise<void>((resolve) => setImmediate(resolve));
      await drain();
      deps.onChanged();
    },
    drain,
  };
}
