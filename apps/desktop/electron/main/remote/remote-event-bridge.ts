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
  RacpSessionSnapshot,
  RemoteInteractionUpdate,
  ToolPermissionRequest,
} from "@pi-desktop/shared";
import { makeRemoteApprovalRequestId, makeRemoteSessionId } from "./backend-router.js";

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
  /** Reconcile attach state through the same translations as the live stream. */
  restoreSnapshot(snapshot: RacpSessionSnapshot): void;
  forgetSession(hostSessionId: string): void;
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
    ...(approval.nestedParentToolCallId ? { nestedParentToolCallId: approval.nestedParentToolCallId } : {}),
  };
}

function toAskToolRequest(
  remoteSessionId: string,
  input: RacpInputRequest,
): AskToolRequest {
  return {
    requestId: input.id,
    sessionId: remoteSessionId,
    // Ask-tool needs a toolCallId to attach the answer to; the RACP schema
    // supplies it as `parentToolCallId` when the input came from a subagent,
    // and leaves it undefined for the top-level agent.
    toolCallId: input.parentToolCallId ?? "",
    questions: input.questions.map((question) => ({
      question: question.question,
      options: question.options,
      multiSelect: question.multiSelect,
    })),
  };
}

function toPlanningStateAgentEvent(
  planning: PlanningStateEvent,
): AgentEvent {
  const { sessionId: _hostSessionId, ...rest } = planning;
  return { type: "planning_state", ...rest };
}

export function createRemoteEventBridge(options: RemoteEventBridgeOptions): RemoteEventBridge {
  const { hostKey, emit, onLifecycle } = options;
  const log = options.log ?? (() => undefined);
  type PromptState = { epoch: string; sequence: number; snapshotSequence: number; seen: Set<string>; retired: Set<string> };
  const prompts = new Map<string, PromptState>();
  const stateFor = (sessionId: string, epoch: string): PromptState | undefined => {
    let state = prompts.get(sessionId);
    if (state?.retired.has(epoch)) return undefined;
    if (!state || state.epoch !== epoch) {
      const retired = state?.retired ?? new Set<string>();
      if (state) retired.add(state.epoch);
      if (retired.size > 16) retired.delete(retired.values().next().value!);
      state = { epoch, sequence: 0, snapshotSequence: -1, seen: new Set(), retired };
      prompts.set(sessionId, state);
      if (prompts.size > 128) prompts.delete(prompts.keys().next().value!);
    }
    return state;
  };
  const remember = (state: PromptState, key: string) => {
    if (state.seen.has(key)) return false;
    state.seen.add(key);
    if (state.seen.size > 512) state.seen.delete(state.seen.values().next().value!);
    return true;
  };
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
      ...(envelope.nestedParentToolCallId ? { nestedParentToolCallId: envelope.nestedParentToolCallId } : {}),
      ...(envelope.agentName ? { agentName: envelope.agentName } : {}),
    };
    emit(IPC.event.agentMessage, local);
  };
  const emitInteractions = (update: RemoteInteractionUpdate): void => {
    emit(IPC.event.remoteInteractions, update);
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
    onLifecycle?.({ kind: "session.archived", hostSessionId: session.id, remoteSessionId, session });
    emit(IPC.event.sessionsChanged, { reason: "remote.session.archived" });
  };

  const handleSessionScope = (envelope: RacpEventEnvelope): void => {
    if (typeof envelope.sessionId !== "string") return;
    const remoteSessionId = remoteIdOf(envelope.sessionId);
    const state = stateFor(envelope.sessionId, envelope.epoch);
    if (!state) return;
    if (envelope.sequence !== undefined) state.sequence = Math.max(state.sequence, envelope.sequence);
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
            toPlanningStateAgentEvent(planning),
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
        if (!remember(state, `approval:${approval.id}`)) return;
        emitAgentEvent(envelope, remoteSessionId, {
          type: "tool_permission_request",
          request: toToolPermissionRequest(remoteSessionId, approval),
        });
        return;
      }
      case "input.requested": {
        const input = extractInputRequest(envelope.payload);
        if (!input) return;
        if (!remember(state, `input:${input.id}`)) return;
        emitAgentEvent(envelope, remoteSessionId, {
          type: "asktool_request",
          request: toAskToolRequest(remoteSessionId, input),
        });
        return;
      }
      case "approval.resolved":
      case "input.resolved": {
        const payload = envelope.payload;
        const kind = envelope.kind === "approval.resolved" ? "approval" : "input";
        const id = isRecord(payload) ? payload[`${kind}Id`] : undefined;
        if (typeof id === "string") {
          remember(state, `${kind}:${id}`);
          emitInteractions({ kind: "resolved", sessionId: remoteSessionId,
            requestKind: kind === "approval" ? "permission" : "ask",
            requestId: kind === "approval" ? makeRemoteApprovalRequestId(remoteSessionId, id) : id });
          emit(IPC.event.sessionsChanged, { reason: `remote.${kind}.resolved` });
        }
        return;
      }
      case "terminal.changed":
      case "terminal.output":
      case "resync.required":
        // Terminal events belong to their work-panel consumer. Subscription
        // recovery is owned by the connection, not the translation layer.
        return;
      default:
        return;
    }
  };

  return {
    forgetSession(sessionId) { prompts.delete(sessionId); },
    restoreSnapshot(snapshot) {
      const sessionId = snapshot.session.id;
      const state = stateFor(sessionId, snapshot.cursor.epoch);
      if (!state || snapshot.cursor.sequence < state.sequence || snapshot.cursor.sequence < state.snapshotSequence) return;
      state.snapshotSequence = snapshot.cursor.sequence;
      const envelope = (kind: RacpEventEnvelope["kind"], payload: unknown, turnId?: string): RacpEventEnvelope => ({
        eventId: `snapshot:${sessionId}:${snapshot.cursor.sequence}`, scope: "session", sessionId,
        epoch: snapshot.cursor.epoch, sequence: snapshot.cursor.sequence, revision: snapshot.revision,
        occurredAt: snapshot.generatedAt, kind, payload, ...(turnId ? { turnId } : {}),
      });
      for (const approval of snapshot.pendingApprovals) {
        if (approval.sessionId !== sessionId) continue;
        if (approval.kind === "tool") handleSessionScope(envelope("approval.requested", approval, approval.turnId));
        else if (remember(state, `approval:${approval.id}`)) {
          handleSessionScope(envelope("session.changed", { event: {
            sessionId, state: "awaiting_approval", kind: approval.kind, proposalId: approval.id,
            title: approval.title ?? approval.summary, question: approval.question,
            artifact: approval.artifact, version: approval.revision,
          } }, approval.turnId));
        }
      }
      for (const input of snapshot.pendingInputs) {
        if (input.sessionId === sessionId) handleSessionScope(envelope("input.requested", input, input.turnId));
      }
      state.sequence = snapshot.cursor.sequence;
      const remoteSessionId = remoteIdOf(sessionId);
      emitInteractions({ kind: "snapshot", sessionId: remoteSessionId,
        permissions: snapshot.pendingApprovals.filter(item => item.sessionId === sessionId && item.kind === "tool")
          .map(item => toToolPermissionRequest(remoteSessionId, item)),
        asks: snapshot.pendingInputs.filter(item => item.sessionId === sessionId)
          .map(item => toAskToolRequest(remoteSessionId, item)),
      });
    },
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
