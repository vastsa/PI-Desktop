/**
 * Event bridge: translate a paired host's RACP event stream into the local
 * renderer IPC events already consumed for a local session. The renderer
 * cannot tell the difference (spec §3.4); only the namespaced session id and
 * the `source: "remote"` badge distinguish a remote row.
 *
 * The bridge is pure translation: it forwards to an injected `emit(channel,
 * payload)` and calls an optional `onLifecycle` for host-scope `session.*`
 * kinds. It never touches the router, the connection, or persistence — the
 * connection layer (Stage 3) drives subscription and unsubscription.
 */
import { IPC } from "@pi-desktop/shared";
import type {
  AgentEvent,
  AgentEventEnvelope,
  AskToolRequest,
  PlanningStateEvent,
  RacpApprovalRequest,
  RacpEventEnvelope,
  RacpInputRequest,
  ToolPermissionRequest,
} from "@pi-desktop/shared";
import { makeRemoteApprovalRequestId, makeRemoteSessionId } from "./backend-router.js";
import { pendingAsksRegistry } from "../pending-asks";

/** A minimal shape of the session field carried by host-scope session events.
 * Both the RACP `RacpSession` and the host's smaller `SessionSummary` extend
 * this — no field beyond these five is read by lifecycle handlers. */
export type RemoteEventSessionRef = {
  id: string;
  title?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type RemoteLifecycleEvent =
  | { readonly kind: "session.created"; readonly hostSessionId: string; readonly remoteSessionId: string; readonly session: RemoteEventSessionRef }
  | { readonly kind: "session.changed"; readonly hostSessionId: string; readonly remoteSessionId: string; readonly session: RemoteEventSessionRef }
  | { readonly kind: "session.archived"; readonly hostSessionId: string; readonly remoteSessionId: string; readonly session?: RemoteEventSessionRef };

export type RemoteEventBridgeOptions = {
  /** Renderer-visible id prefix component. Fixed for one host. */
  hostKey: string;
  /** Dispatch a local IPC event to the renderer. */
  emit: (channel: string, payload: unknown) => void;
  /** Lifecycle callback for host-scope `session.*` kinds; drives the router. */
  onLifecycle?: (event: RemoteLifecycleEvent) => void;
  /** Optional structured warning log; defaults to a no-op. */
  log?: (level: "warn", message: string, data?: unknown) => void;
};

export interface RemoteEventBridge {
  /** Handle one RACP envelope. Unknown kinds are dropped. */
  handle(envelope: RacpEventEnvelope): void;
}

const APPROVAL_KIND = { tool: "tool", plan: "plan", goal: "goal" } as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function extractSessionRef(payload: unknown): RemoteEventSessionRef | undefined {
  if (!isRecord(payload)) return undefined;
  const session = payload.session;
  if (!isRecord(session) || typeof session.id !== "string") return undefined;
  return {
    id: session.id,
    ...(typeof session.title === "string" ? { title: session.title } : {}),
    ...(typeof session.createdAt === "string" ? { createdAt: session.createdAt } : {}),
    ...(typeof session.updatedAt === "string" ? { updatedAt: session.updatedAt } : {}),
  };
}

function extractAgentEvent(payload: unknown): AgentEvent | undefined {
  if (!isRecord(payload)) return undefined;
  const event = payload.event;
  if (!isRecord(event) || typeof event.type !== "string") return undefined;
  return event as unknown as AgentEvent;
}

function extractApprovalRequest(payload: unknown): RacpApprovalRequest | undefined {
  if (!isRecord(payload)) return undefined;
  // The RACP schema publishes the approval request as the payload's own body,
  // not nested under `.approval`. Both agent-host emit sites and the fixture
  // in packages/racp use that shape.
  if (typeof payload.id !== "string" || typeof payload.kind !== "string") return undefined;
  return payload as unknown as RacpApprovalRequest;
}

function extractInputRequest(payload: unknown): RacpInputRequest | undefined {
  if (!isRecord(payload)) return undefined;
  if (typeof payload.id !== "string" || !Array.isArray(payload.questions)) return undefined;
  return payload as unknown as RacpInputRequest;
}

function toToolPermissionRequest(
  remoteSessionId: string,
  approval: RacpApprovalRequest,
): ToolPermissionRequest {
  return {
    // Stateless approval id encoding — see backend-router.ts.
    requestId: makeRemoteApprovalRequestId(remoteSessionId, approval.id),
    sessionId: remoteSessionId,
    // RACP approvals do not carry a toolCallId back; the permission card does
    // not display it and only the resolution path needs the requestId.
    toolCallId: "",
    toolName: approval.toolName ?? "",
    argsPreview: null,
    risk: approval.risk ?? "medium",
    reason: approval.summary,
    ...(approval.agentName ? { agentName: approval.agentName } : {}),
    ...(approval.parentToolCallId ? { parentToolCallId: approval.parentToolCallId } : {}),
  };
}

function toAskToolRequest(
  remoteSessionId: string,
  input: RacpInputRequest,
): AskToolRequest {
  return {
    requestId: input.id,
    sessionId: remoteSessionId,
    // The RACP response is keyed by `input.id`, not this field. Preserve the
    // parent tool call when present; for a top-level ask use the input id as a
    // stable non-empty lifecycle key for the main-process registry.
    toolCallId: input.parentToolCallId ?? input.id,
    questions: input.questions.map((question) => ({
      question: question.question,
      options: question.options,
      multiSelect: question.multiSelect,
    })),
  };
}

function toPlanningStateAgentEvent(
  remoteSessionId: string,
  planning: PlanningStateEvent,
): AgentEvent {
  const { sessionId: _hostSessionId, ...rest } = planning;
  return { type: "planning_state", ...rest };
}

export function createRemoteEventBridge(options: RemoteEventBridgeOptions): RemoteEventBridge {
  const { hostKey, emit, onLifecycle } = options;
  const log = options.log ?? (() => undefined);
  const remoteIdOf = (hostSessionId: string) => makeRemoteSessionId(hostKey, hostSessionId);
  const emitAgentEvent = (
    envelope: RacpEventEnvelope,
    remoteSessionId: string,
    event: AgentEvent,
  ): void => {
    const local: AgentEventEnvelope = {
      sessionId: remoteSessionId,
      ...(envelope.turnId ? { turnId: envelope.turnId } : {}),
      ts: Date.parse(envelope.occurredAt) || Date.now(),
      event,
      ...(envelope.parentToolCallId ? { parentToolCallId: envelope.parentToolCallId } : {}),
      ...(envelope.agentName ? { agentName: envelope.agentName } : {}),
    };
    pendingAsksRegistry.ingest(local);
    emit(IPC.event.agentMessage, local);
  };

  const handleHostSession = (envelope: RacpEventEnvelope): void => {
    const session = extractSessionRef(envelope.payload);
    if (!session) {
      log("warn", `host-scope ${envelope.kind} carried no session`, envelope);
      return;
    }
    const remoteSessionId = remoteIdOf(session.id);
    if (envelope.kind === "session.created") {
      onLifecycle?.({ kind: "session.created", hostSessionId: session.id, remoteSessionId, session });
      emit(IPC.event.sessionsChanged, {
        reason: "remote.session.created",
        selectSessionId: remoteSessionId,
      });
      return;
    }
    if (envelope.kind === "session.changed") {
      onLifecycle?.({ kind: "session.changed", hostSessionId: session.id, remoteSessionId, session });
      emit(IPC.event.sessionsChanged, { reason: "remote.session.changed" });
      return;
    }
    // "session.archived": pass through to the lifecycle handler for router
    // cleanup, then refresh the renderer's session list.
    pendingAsksRegistry.clearSession(remoteSessionId);
    onLifecycle?.({ kind: "session.archived", hostSessionId: session.id, remoteSessionId, session });
    emit(IPC.event.sessionsChanged, { reason: "remote.session.archived" });
  };

  const handleSessionScope = (envelope: RacpEventEnvelope): void => {
    if (typeof envelope.sessionId !== "string") return;
    const remoteSessionId = remoteIdOf(envelope.sessionId);
    switch (envelope.kind) {
      case "item.started":
      case "item.delta":
      case "item.completed":
      case "tool.progress":
      case "turn.queued":
      case "turn.started":
      case "turn.completed":
      case "turn.interrupted":
      case "turn.failed":
      case "turn.canceled":
      case "turn.activity": {
        const event = extractAgentEvent(envelope.payload);
        if (!event) return;
        emitAgentEvent(envelope, remoteSessionId, event);
        return;
      }
      case "session.changed": {
        // Two shapes ride this kind (agent-host):
        //   1. `{ event: PlanningStateEvent }` — surface as a local planning
        //      event so the plan card behaves the same as local.
        //   2. `{ sessionId, status, planningState }` — a periodic status
        //      refresh; the desktop derives its own status from turn events, so
        //      drop it and let the eventual snapshot refresh cover it.
        const payload = envelope.payload;
        if (isRecord(payload) && isRecord(payload.event) && payload.event.state !== undefined) {
          const planning = payload.event as unknown as PlanningStateEvent;
          emitAgentEvent(
            envelope,
            remoteSessionId,
            toPlanningStateAgentEvent(remoteSessionId, planning),
          );
        }
        return;
      }
      case "approval.requested": {
        const approval = extractApprovalRequest(envelope.payload);
        if (!approval) return;
        // Plan / goal approvals ride the following `planning_state` event; the
        // renderer's plan card is driven by that, not by a synthetic tool card.
        if (approval.kind !== APPROVAL_KIND.tool) return;
        emitAgentEvent(envelope, remoteSessionId, {
          type: "tool_permission_request",
          request: toToolPermissionRequest(remoteSessionId, approval),
        });
        return;
      }
      case "input.requested": {
        const input = extractInputRequest(envelope.payload);
        if (!input) return;
        emitAgentEvent(envelope, remoteSessionId, {
          type: "asktool_request",
          request: toAskToolRequest(remoteSessionId, input),
        });
        return;
      }
      case "input.resolved": {
        const payload = envelope.payload;
        if (isRecord(payload) && typeof payload.inputId === "string") {
          pendingAsksRegistry.settle(remoteSessionId, payload.inputId);
        }
        return;
      }
      case "approval.resolved":
      case "terminal.changed":
      case "terminal.output":
      case "resync.required":
        // Approvals settle through the renderer's own resolve call; the plan
        // and status changes come as `session.changed` payloads. Terminal
        // events belong to Stage 5. `resync.required` is Stage 3b — the
        // connection layer must consume it, not the bridge.
        return;
      default:
        return;
    }
  };

  return {
    handle(envelope) {
      try {
        if (envelope.scope === "host") return handleHostSession(envelope);
        if (envelope.scope === "session") return handleSessionScope(envelope);
      } catch (error) {
        log("warn", `remote event bridge failed on ${envelope.kind}`, error);
      }
    },
  };
}
