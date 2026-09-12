/**
 * PI Remote Agent Control Protocol (RACP) contract.
 *
 * Normative source: `docs/spec/03-runtime/19-remote-agent-control-protocol.md`
 * (D373, amended by D374 and D375). These typebox schemas are the single
 * source of the contract (frozen decision 28): the JSON Schema fixtures,
 * documentation tables, and any future Protobuf file are generated from
 * them, never hand-maintained beside them.
 *
 * The module is transport-neutral. `RACP-WS` is the normative v1 binding,
 * first deployed over an SSH tunnel; `RACP-HTTP` is the browser profile and
 * unscheduled; `RACP-GRPC` is reserved.
 */
import Type from "typebox";

import { ErrorCodes } from "./errors.js";
import type { AgentEvent } from "./types.js";

type Static<T extends Type.TSchema> = Type.Static<T>;

// ---------------------------------------------------------------------------
// Versions, bindings, roles
// ---------------------------------------------------------------------------

export const RACP_PROTOCOL_VERSION = "1.0" as const;

export const RACP_BINDINGS = ["RACP-WS", "RACP-HTTP", "RACP-GRPC"] as const;
export type RacpBinding = (typeof RACP_BINDINGS)[number];

/** Bindings a v1 Host may advertise. HTTP and gRPC stay in the enum so the
 * contract does not drift while their milestones are unscheduled. */
export const RACP_SHIPPED_BINDINGS: readonly RacpBinding[] = ["RACP-WS"];

export const RACP_WS_SUBPROTOCOL = "pi-racp.v1.jsonrpc" as const;

export const RACP_ROLES = ["viewer", "controller", "approver", "owner"] as const;
export type RacpRole = (typeof RACP_ROLES)[number];

// ---------------------------------------------------------------------------
// Primitive vocabularies
// ---------------------------------------------------------------------------


export const RACP_PERMISSION_MODES = ["ask", "accept-edits", "auto"] as const;
export type RacpPermissionMode = (typeof RACP_PERMISSION_MODES)[number];
export const RacpPermissionModeSchema = Type.Union([Type.Literal("ask"), Type.Literal("accept-edits"), Type.Literal("auto")]);

export const RACP_SESSION_MODES = ["agent", "plan", "goal"] as const;
export type RacpSessionMode = (typeof RACP_SESSION_MODES)[number];
export const RacpSessionModeSchema = Type.Union([Type.Literal("agent"), Type.Literal("plan"), Type.Literal("goal")]);

export const RACP_SESSION_STATUSES = [
  "idle",
  "running",
  "waiting_permission",
  "aborted",
  "error",
] as const;
export type RacpSessionStatus = (typeof RACP_SESSION_STATUSES)[number];
export const RacpSessionStatusSchema = Type.Union([Type.Literal("idle"), Type.Literal("running"), Type.Literal("waiting_permission"), Type.Literal("aborted"), Type.Literal("error")]);

export const RACP_PLANNING_STATES = ["inactive", "planning", "awaiting_approval"] as const;
export type RacpPlanningState = (typeof RACP_PLANNING_STATES)[number];
export const RacpPlanningStateSchema = Type.Union([Type.Literal("inactive"), Type.Literal("planning"), Type.Literal("awaiting_approval")]);

export const RACP_TURN_STATUSES = [
  "queued",
  "running",
  "waiting_approval",
  "waiting_input",
  "completed",
  "interrupted",
  "failed",
  "canceled",
] as const;
export type RacpTurnStatus = (typeof RACP_TURN_STATUSES)[number];
export const RacpTurnStatusSchema = Type.Union([Type.Literal("queued"), Type.Literal("running"), Type.Literal("waiting_approval"), Type.Literal("waiting_input"), Type.Literal("completed"), Type.Literal("interrupted"), Type.Literal("failed"), Type.Literal("canceled")]);

/** Statuses in which a turn still occupies the session. */
export const RACP_ACTIVE_TURN_STATUSES: readonly RacpTurnStatus[] = [
  "running",
  "waiting_approval",
  "waiting_input",
];

export const RACP_TURN_ADMISSIONS = ["reject_if_busy", "queue"] as const;
export type RacpTurnAdmission = (typeof RACP_TURN_ADMISSIONS)[number];
export const RacpTurnAdmissionSchema = Type.Union([Type.Literal("reject_if_busy"), Type.Literal("queue")]);

export const RACP_ITEM_TYPES = ["message", "tool", "compaction"] as const;
export type RacpItemType = (typeof RACP_ITEM_TYPES)[number];
export const RacpItemTypeSchema = Type.Union([Type.Literal("message"), Type.Literal("tool"), Type.Literal("compaction")]);

// ---------------------------------------------------------------------------
// Request context
// ---------------------------------------------------------------------------

export const RacpRequestContextSchema = Type.Object({
  requestId: Type.String({ minLength: 1 }),
  idempotencyKey: Type.Optional(Type.String({ minLength: 1 })),
  expectedRevision: Type.Optional(Type.Integer({ minimum: 0 })),
  traceparent: Type.Optional(Type.String()),
});
export type RacpRequestContext = Static<typeof RacpRequestContextSchema>;

// ---------------------------------------------------------------------------
// Canonical resources (spec §5)
// ---------------------------------------------------------------------------

export const RacpSessionSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  title: Type.String(),
  projectId: Type.Optional(Type.String()),
  workspaceLabel: Type.Optional(Type.String()),
  mode: RacpSessionModeSchema,
  status: RacpSessionStatusSchema,
  planningState: RacpPlanningStateSchema,
  permissionMode: RacpPermissionModeSchema,
  activeTurnId: Type.Optional(Type.String()),
  queuedTurnIds: Type.Array(Type.String()),
  revision: Type.Integer({ minimum: 0 }),
  createdAt: Type.String(),
  updatedAt: Type.String(),
});
export type RacpSession = Static<typeof RacpSessionSchema>;

export const RacpRemoteErrorSchema = Type.Object({
  code: Type.String({ minLength: 1 }),
  message: Type.String(),
  retriable: Type.Boolean(),
  traceId: Type.String(),
  details: Type.Optional(Type.Unknown()),
});
export type RacpRemoteError = Static<typeof RacpRemoteErrorSchema>;

export const RacpTurnSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  sessionId: Type.String({ minLength: 1 }),
  status: RacpTurnStatusSchema,
  admission: RacpTurnAdmissionSchema,
  queuePosition: Type.Optional(Type.Integer({ minimum: 1 })),
  effectivePermissionMode: RacpPermissionModeSchema,
  idempotencyKey: Type.Optional(Type.String()),
  startedAt: Type.Optional(Type.String()),
  endedAt: Type.Optional(Type.String()),
  error: Type.Optional(RacpRemoteErrorSchema),
});
export type RacpTurn = Static<typeof RacpTurnSchema>;

export const RacpCursorSchema = Type.Object({
  epoch: Type.String({ minLength: 1 }),
  sequence: Type.Integer({ minimum: 0 }),
});
export type RacpCursor = Static<typeof RacpCursorSchema>;

export const RACP_EVENT_SCOPES = ["session", "host"] as const;
export const RacpEventScopeSchema = Type.Union([Type.Literal("session"), Type.Literal("host")]);

export const RACP_EVENT_KINDS = [
  "session.created",
  "session.changed",
  "session.archived",
  "host.changed",
  "turn.queued",
  "turn.started",
  "turn.completed",
  "turn.interrupted",
  "turn.failed",
  "turn.canceled",
  "turn.activity",
  "item.started",
  "item.delta",
  "item.completed",
  "tool.progress",
  "terminal.changed",
  "terminal.output",
  "approval.requested",
  "approval.resolved",
  "input.requested",
  "input.resolved",
  "resync.required",
] as const;
export type RacpEventKind = (typeof RACP_EVENT_KINDS)[number];
export const RacpEventKindSchema = Type.Union([Type.Literal("session.created"), Type.Literal("session.changed"), Type.Literal("session.archived"), Type.Literal("host.changed"), Type.Literal("turn.queued"), Type.Literal("turn.started"), Type.Literal("turn.completed"), Type.Literal("turn.interrupted"), Type.Literal("turn.failed"), Type.Literal("turn.canceled"), Type.Literal("turn.activity"), Type.Literal("item.started"), Type.Literal("item.delta"), Type.Literal("item.completed"), Type.Literal("tool.progress"), Type.Literal("terminal.changed"), Type.Literal("terminal.output"), Type.Literal("approval.requested"), Type.Literal("approval.resolved"), Type.Literal("input.requested"), Type.Literal("input.resolved"), Type.Literal("resync.required")]);

/**
 * Ephemeral kinds are delivered live, never sequenced, never replayed, and
 * never counted against the replay window (spec §5.3, §8). Everything else
 * is durable and carries a `sequence`.
 */
export const RACP_EPHEMERAL_EVENT_KINDS: readonly RacpEventKind[] = [
  "turn.activity",
  "item.delta",
  "tool.progress",
  "terminal.output",
];

export function isDurableEventKind(kind: RacpEventKind): boolean {
  return !RACP_EPHEMERAL_EVENT_KINDS.includes(kind);
}

export const RacpEventEnvelopeSchema = Type.Object({
  eventId: Type.String({ minLength: 1 }),
  scope: RacpEventScopeSchema,
  sessionId: Type.Optional(Type.String()),
  turnId: Type.Optional(Type.String()),
  epoch: Type.String({ minLength: 1 }),
  /** Present on durable events only. */
  sequence: Type.Optional(Type.Integer({ minimum: 1 })),
  /** Present on ephemeral events only: the last durable sequence they follow. */
  afterSequence: Type.Optional(Type.Integer({ minimum: 0 })),
  revision: Type.Integer({ minimum: 0 }),
  kind: RacpEventKindSchema,
  occurredAt: Type.String(),
  parentToolCallId: Type.Optional(Type.String()),
  agentName: Type.Optional(Type.String()),
  payload: Type.Unknown(),
});
export type RacpEventEnvelope = Static<typeof RacpEventEnvelopeSchema>;

/**
 * Structural rule that JSON Schema cannot express: a durable event carries
 * `sequence` and no `afterSequence`; an ephemeral event the reverse.
 */
export function eventEnvelopeSequencingIsValid(envelope: RacpEventEnvelope): boolean {
  const durable = isDurableEventKind(envelope.kind);
  const hasSequence = typeof envelope.sequence === "number";
  const hasAfter = typeof envelope.afterSequence === "number";
  return durable ? hasSequence && !hasAfter : hasAfter && !hasSequence;
}

export const RacpItemSummarySchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  turnId: Type.String({ minLength: 1 }),
  itemType: RacpItemTypeSchema,
  status: Type.Union([Type.Literal("streaming"), Type.Literal("completed")]),
  sequence: Type.Optional(Type.Integer({ minimum: 1 })),
  createdAt: Type.String(),
  parentToolCallId: Type.Optional(Type.String()),
  agentName: Type.Optional(Type.String()),
  content: Type.Unknown(),
});
export type RacpItemSummary = Static<typeof RacpItemSummarySchema>;

export const RACP_TOOL_APPROVAL_DECISIONS = ["allow-once", "allow-session", "deny"] as const;
export type RacpToolApprovalDecision = (typeof RACP_TOOL_APPROVAL_DECISIONS)[number];
export const RACP_CONTRACT_APPROVAL_DECISIONS = ["approve", "reject"] as const;
export type RacpContractApprovalDecision = (typeof RACP_CONTRACT_APPROVAL_DECISIONS)[number];
export const RacpApprovalDecisionSchema = Type.Union([
  Type.Literal("allow-once"),
  Type.Literal("allow-session"),
  Type.Literal("deny"),
  Type.Literal("approve"),
  Type.Literal("reject"),
]);
export type RacpApprovalDecision = RacpToolApprovalDecision | RacpContractApprovalDecision;

export const RACP_APPROVAL_KINDS = ["tool", "plan", "goal"] as const;
export type RacpApprovalKind = (typeof RACP_APPROVAL_KINDS)[number];

export const RacpApprovalRequestSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  sessionId: Type.String({ minLength: 1 }),
  turnId: Type.String({ minLength: 1 }),
  kind: Type.Union([Type.Literal("tool"), Type.Literal("plan"), Type.Literal("goal")]),
  summary: Type.String(),
  expiresAt: Type.String(),
  revision: Type.Integer({ minimum: 0 }),
  toolName: Type.Optional(Type.String()),
  risk: Type.Optional(Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")])),
  agentName: Type.Optional(Type.String()),
  parentToolCallId: Type.Optional(Type.String()),
  title: Type.Optional(Type.String()),
  question: Type.Optional(Type.String()),
  artifact: Type.Optional(
    Type.Object({
      relativePath: Type.String(),
      sha256: Type.String(),
      sizeBytes: Type.Integer({ minimum: 0 }),
    }),
  ),
  allowedDecisions: Type.Array(RacpApprovalDecisionSchema, { minItems: 1 }),
  allowedPermissionModes: Type.Optional(Type.Array(RacpPermissionModeSchema)),
});
export type RacpApprovalRequest = Static<typeof RacpApprovalRequestSchema>;

/** The decisions a request of each kind may offer (spec §5.5). */
export function allowedDecisionsAreCoherent(request: RacpApprovalRequest): boolean {
  const toolDecisions = new Set<string>(RACP_TOOL_APPROVAL_DECISIONS);
  const contractDecisions = new Set<string>(RACP_CONTRACT_APPROVAL_DECISIONS);
  if (request.kind === "tool") {
    return (
      request.allowedDecisions.every((decision) => toolDecisions.has(decision)) &&
      request.allowedPermissionModes === undefined
    );
  }
  return (
    request.allowedDecisions.every((decision) => contractDecisions.has(decision)) &&
    Array.isArray(request.allowedPermissionModes) &&
    request.allowedPermissionModes.length > 0
  );
}

export const RacpApprovalResponseSchema = Type.Object({
  approvalId: Type.String({ minLength: 1 }),
  decision: RacpApprovalDecisionSchema,
  permissionMode: Type.Optional(RacpPermissionModeSchema),
  context: RacpRequestContextSchema,
});
export type RacpApprovalResponse = Static<typeof RacpApprovalResponseSchema>;

export const RacpApprovalResultSchema = Type.Object({
  approvalId: Type.String({ minLength: 1 }),
  status: Type.Union([Type.Literal("resolved"), Type.Literal("expired"), Type.Literal("canceled")]),
  decision: Type.Optional(RacpApprovalDecisionSchema),
  permissionMode: Type.Optional(RacpPermissionModeSchema),
  alreadyResolved: Type.Boolean(),
  revision: Type.Integer({ minimum: 0 }),
});
export type RacpApprovalResult = Static<typeof RacpApprovalResultSchema>;

export const RacpInputRequestSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  sessionId: Type.String({ minLength: 1 }),
  turnId: Type.String({ minLength: 1 }),
  expiresAt: Type.String(),
  agentName: Type.Optional(Type.String()),
  parentToolCallId: Type.Optional(Type.String()),
  questions: Type.Array(
    Type.Object({
      id: Type.String({ minLength: 1 }),
      question: Type.String(),
      options: Type.Array(Type.String()),
      multiSelect: Type.Boolean(),
    }),
    { minItems: 1 },
  ),
});
export type RacpInputRequest = Static<typeof RacpInputRequestSchema>;

export const RacpInputResponseSchema = Type.Object({
  inputId: Type.String({ minLength: 1 }),
  /** `null` skips a question, matching the local `AskToolResolution`. */
  answers: Type.Array(Type.Union([Type.Array(Type.String()), Type.Null()])),
  context: RacpRequestContextSchema,
});
export type RacpInputResponse = Static<typeof RacpInputResponseSchema>;

export const RacpAttachmentSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  sessionId: Type.String({ minLength: 1 }),
  name: Type.String(),
  mimeType: Type.String(),
  sizeBytes: Type.Integer({ minimum: 0 }),
  sha256: Type.String({ minLength: 64, maxLength: 64 }),
  status: Type.Union([Type.Literal("pending"), Type.Literal("ready"), Type.Literal("expired"), Type.Literal("rejected")]),
  expiresAt: Type.String(),
});
export type RacpAttachment = Static<typeof RacpAttachmentSchema>;

export const RacpHostSummarySchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  label: Type.String(),
  status: Type.Union([Type.Literal("online"), Type.Literal("offline")]),
  lastSeenAt: Type.String(),
  protocolVersion: Type.String(),
});
export type RacpHostSummary = Static<typeof RacpHostSummarySchema>;

export const RacpProjectSummarySchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  label: Type.String(),
  archived: Type.Boolean(),
});
export type RacpProjectSummary = Static<typeof RacpProjectSummarySchema>;

export const RacpSessionSnapshotSchema = Type.Object({
  session: RacpSessionSchema,
  activeTurn: Type.Optional(RacpTurnSchema),
  queuedTurns: Type.Array(RacpTurnSchema),
  items: Type.Array(RacpItemSummarySchema),
  activeItems: Type.Array(RacpItemSummarySchema),
  pendingApprovals: Type.Array(RacpApprovalRequestSchema),
  pendingInputs: Type.Array(RacpInputRequestSchema),
  hasMoreHistory: Type.Boolean(),
  cursor: RacpCursorSchema,
  revision: Type.Integer({ minimum: 0 }),
  generatedAt: Type.String(),
});
export type RacpSessionSnapshot = Static<typeof RacpSessionSnapshotSchema>;

// ---------------------------------------------------------------------------
// Initialization (spec §3)
// ---------------------------------------------------------------------------

export const RacpClientCapabilitiesSchema = Type.Object({
  eventReplay: Type.Optional(Type.Boolean()),
  approvals: Type.Optional(Type.Boolean()),
  inputRequests: Type.Optional(Type.Boolean()),
  attachments: Type.Optional(Type.Boolean()),
  turnQueue: Type.Optional(Type.Boolean()),
  hostEvents: Type.Optional(Type.Boolean()),
  history: Type.Optional(Type.Boolean()),
  toolRelay: Type.Optional(Type.Boolean()),
  terminal: Type.Optional(Type.Boolean()),
});

export const RacpServerCapabilitiesSchema = Type.Object({
  eventReplay: Type.Boolean(),
  snapshot: Type.Boolean(),
  approvals: Type.Boolean(),
  inputRequests: Type.Boolean(),
  attachments: Type.Boolean(),
  serverRequests: Type.Boolean(),
  turnQueue: Type.Boolean(),
  hostEvents: Type.Boolean(),
  history: Type.Boolean(),
  remoteHostProfile: Type.Boolean(),
  toolRelay: Type.Boolean(),
  terminal: Type.Boolean(),
  notifications: Type.Boolean(),
  bindings: Type.Array(Type.Union([Type.Literal("RACP-WS"), Type.Literal("RACP-HTTP"), Type.Literal("RACP-GRPC")])),
});
export type RacpServerCapabilities = Static<typeof RacpServerCapabilitiesSchema>;

export const RacpLimitsSchema = Type.Object({
  maxFrameBytes: Type.Integer({ minimum: 1 }),
  maxPromptBytes: Type.Integer({ minimum: 1 }),
  maxAttachmentBytes: Type.Integer({ minimum: 1 }),
  maxSubscriptionsPerConnection: Type.Integer({ minimum: 1 }),
  maxQueuedTurnsPerSession: Type.Integer({ minimum: 0 }),
  replayWindowEvents: Type.Integer({ minimum: 1 }),
  replayWindowMs: Type.Integer({ minimum: 1 }),
  maxConnectedClients: Type.Integer({ minimum: 1 }),
  terminalReplayRingBytes: Type.Integer({ minimum: 0 }),
  maxOpenTerminalsPerSession: Type.Integer({ minimum: 0 }),
});
export type RacpLimits = Static<typeof RacpLimitsSchema>;

/** Initial target limits from spec §12 and security §9. */
export const RACP_DEFAULT_LIMITS: RacpLimits = {
  maxFrameBytes: 1024 * 1024,
  maxPromptBytes: 256 * 1024,
  maxAttachmentBytes: 50 * 1024 * 1024,
  maxSubscriptionsPerConnection: 8,
  maxQueuedTurnsPerSession: 8,
  replayWindowEvents: 10_000,
  replayWindowMs: 24 * 60 * 60 * 1000,
  maxConnectedClients: 16,
  terminalReplayRingBytes: 128 * 1024,
  maxOpenTerminalsPerSession: 2,
};

export const RacpPolicySchema = Type.Object({
  remoteMaxPermissionMode: RacpPermissionModeSchema,
  applyCeilingToPairedDevices: Type.Boolean(),
  approvalLifetimeMs: Type.Integer({ minimum: 1 }),
});
export type RacpPolicy = Static<typeof RacpPolicySchema>;

/** Local approval lifetime: frozen decision 17, 120 seconds then deny. */
export const RACP_LOCAL_APPROVAL_LIFETIME_MS = 120_000;
/** Default lifetime while a remote subscriber is attached (D375). */
export const RACP_REMOTE_APPROVAL_LIFETIME_MS = 30 * 60 * 1000;

export const RACP_DEFAULT_POLICY: RacpPolicy = {
  remoteMaxPermissionMode: "ask",
  applyCeilingToPairedDevices: false,
  approvalLifetimeMs: RACP_REMOTE_APPROVAL_LIFETIME_MS,
};

export const RacpInitializeParamsSchema = Type.Object({
  protocolVersion: Type.String({ minLength: 1 }),
  client: Type.Object({ name: Type.String(), version: Type.String() }),
  bindings: Type.Array(Type.Union([Type.Literal("RACP-WS"), Type.Literal("RACP-HTTP"), Type.Literal("RACP-GRPC")])),
  capabilities: RacpClientCapabilitiesSchema,
  maxReceiveBytes: Type.Optional(Type.Integer({ minimum: 1 })),
});
export type RacpInitializeParams = Static<typeof RacpInitializeParamsSchema>;

export const RacpInitializeResultSchema = Type.Object({
  protocolVersion: Type.String({ minLength: 1 }),
  server: Type.Object({ name: Type.String(), version: Type.String() }),
  connectionId: Type.String({ minLength: 1 }),
  principal: Type.Object({
    subject: Type.String({ minLength: 1 }),
    roles: Type.Array(Type.Union([Type.Literal("viewer"), Type.Literal("controller"), Type.Literal("approver"), Type.Literal("owner")])),
  }),
  capabilities: RacpServerCapabilitiesSchema,
  limits: RacpLimitsSchema,
  policy: RacpPolicySchema,
});
export type RacpInitializeResult = Static<typeof RacpInitializeResultSchema>;

/**
 * Major/minor compatibility (spec §3): the same major is compatible, a
 * different major is `PROTOCOL_MISMATCH`.
 */
export function protocolVersionsCompatible(server: string, client: string): boolean {
  const major = (value: string) => value.split(".")[0];
  return major(server) === major(client) && /^\d+\.\d+$/.test(client);
}

// ---------------------------------------------------------------------------
// Operation catalog (spec §6)
// ---------------------------------------------------------------------------

export type RacpOperationRole = RacpRole | "authenticated";

export type RacpOperationSpec = {
  role: RacpOperationRole;
  /** `v1` ships first; `remote-host` is the v1.1 profile required by rollout R2. */
  profile: "v1" | "remote-host";
  mutation: boolean;
};

export const RACP_OPERATIONS = {
  "connection/initialize": { role: "authenticated", profile: "v1", mutation: false },
  "connection/ping": { role: "authenticated", profile: "v1", mutation: false },
  "host/list": { role: "authenticated", profile: "v1", mutation: false },
  "project/list": { role: "viewer", profile: "v1", mutation: false },
  "session/list": { role: "viewer", profile: "v1", mutation: false },
  "session/get": { role: "viewer", profile: "v1", mutation: false },
  "session/create": { role: "controller", profile: "v1", mutation: true },
  "session/attach": { role: "viewer", profile: "v1", mutation: false },
  "session/history": { role: "viewer", profile: "v1", mutation: false },
  "events/subscribe": { role: "viewer", profile: "v1", mutation: false },
  "events/unsubscribe": { role: "viewer", profile: "v1", mutation: false },
  "events/ack": { role: "viewer", profile: "v1", mutation: false },
  "turn/start": { role: "controller", profile: "v1", mutation: true },
  "turn/get": { role: "viewer", profile: "v1", mutation: false },
  "turn/stop": { role: "controller", profile: "v1", mutation: true },
  "turn/interrupt": { role: "controller", profile: "v1", mutation: true },
  "turn/cancel": { role: "controller", profile: "v1", mutation: true },
  "turn/prioritize": { role: "controller", profile: "v1", mutation: true },
  "approval/respond": { role: "approver", profile: "v1", mutation: true },
  "input/respond": { role: "controller", profile: "v1", mutation: true },
  "attachment/create": { role: "controller", profile: "v1", mutation: true },
  "attachment/complete": { role: "controller", profile: "v1", mutation: true },
  "tools/advertise": { role: "owner", profile: "v1", mutation: true },
  "session/revoke": { role: "owner", profile: "v1", mutation: true },
  "session/archive": { role: "owner", profile: "v1", mutation: true },
  "session/configure": { role: "controller", profile: "remote-host", mutation: true },
  "session/fork": { role: "controller", profile: "remote-host", mutation: true },
  "session/rename": { role: "controller", profile: "remote-host", mutation: true },
  "session/delete": { role: "owner", profile: "remote-host", mutation: true },
  "session/compact": { role: "controller", profile: "remote-host", mutation: true },
  "workspace/list": { role: "viewer", profile: "remote-host", mutation: false },
  "workspace/read": { role: "viewer", profile: "remote-host", mutation: false },
  "workspace/diff": { role: "viewer", profile: "remote-host", mutation: false },
  "terminal/open": { role: "controller", profile: "remote-host", mutation: true },
  "terminal/input": { role: "controller", profile: "remote-host", mutation: true },
  "terminal/resize": { role: "controller", profile: "remote-host", mutation: true },
  "terminal/close": { role: "controller", profile: "remote-host", mutation: true },
} as const satisfies Record<string, RacpOperationSpec>;
export type RacpOperation = keyof typeof RACP_OPERATIONS;

/** Server-initiated requests on the WebSocket binding (spec §4.3, §9). */
export const RACP_SERVER_REQUESTS = ["approval/request", "input/request", "tool/execute"] as const;
export type RacpServerRequest = (typeof RACP_SERVER_REQUESTS)[number];

/** Notification method that carries an `EventEnvelope` on the WS binding. */
export const RACP_EVENT_NOTIFICATION = "session/event" as const;

/** Operations the desktop offers locally that RACP reserves but does not expose. */
export const RACP_DEFERRED_OPERATIONS = [
  "turn/override",
  "provider/*",
  "secret/*",
] as const;

const ROLE_RANK: Record<RacpRole, number> = { viewer: 0, controller: 1, approver: 2, owner: 3 };

/**
 * Whether a principal's roles admit an operation. Roles are additive
 * (spec §6.2): `owner` implies every other role, `approver` and
 * `controller` imply `viewer`, but `approver` does not imply `controller`
 * and vice versa.
 */
export function rolesAllowOperation(roles: readonly RacpRole[], operation: RacpOperation): boolean {
  const required = RACP_OPERATIONS[operation].role;
  if (required === "authenticated") return true;
  if (roles.includes("owner")) return true;
  if (required === "viewer") return roles.length > 0;
  return roles.includes(required);
}

export { ROLE_RANK as RACP_ROLE_RANK };

// ---------------------------------------------------------------------------
// HTTP mapping (spec §11.2; browser profile, unscheduled)
// ---------------------------------------------------------------------------

export const RACP_HTTP_ROUTES: Partial<Record<RacpOperation, { method: "GET" | "POST"; path: string }>> = {
  "host/list": { method: "GET", path: "/v1/hosts" },
  "project/list": { method: "GET", path: "/v1/projects" },
  "session/list": { method: "GET", path: "/v1/sessions" },
  "session/create": { method: "POST", path: "/v1/sessions" },
  "session/get": { method: "GET", path: "/v1/sessions/{sessionId}" },
  "session/attach": { method: "POST", path: "/v1/sessions/{sessionId}:attach" },
  "session/history": { method: "GET", path: "/v1/sessions/{sessionId}/history" },
  "turn/start": { method: "POST", path: "/v1/sessions/{sessionId}/turns" },
  "turn/get": { method: "GET", path: "/v1/turns/{turnId}" },
  "turn/stop": { method: "POST", path: "/v1/turns/{turnId}:stop" },
  "turn/interrupt": { method: "POST", path: "/v1/turns/{turnId}:interrupt" },
  "turn/cancel": { method: "POST", path: "/v1/turns/{turnId}:cancel" },
  "turn/prioritize": { method: "POST", path: "/v1/turns/{turnId}:prioritize" },
  "events/subscribe": { method: "GET", path: "/v1/sessions/{sessionId}/events" },
  "approval/respond": { method: "POST", path: "/v1/approvals/{approvalId}:respond" },
  "input/respond": { method: "POST", path: "/v1/inputs/{inputId}:respond" },
};

export const RACP_HTTP_HOST_EVENTS_PATH = "/v1/events" as const;
export const RACP_WS_PATH = "/v1/racp/ws" as const;

// ---------------------------------------------------------------------------
// Cursors (spec §7.2, §11.2)
// ---------------------------------------------------------------------------

/** SSE `id` and `Last-Event-ID` form: `<epoch>:<sequence>`. */
export function formatRacpCursor(cursor: RacpCursor): string {
  return `${cursor.epoch}:${cursor.sequence}`;
}

export function parseRacpCursor(value: string): RacpCursor | null {
  const separator = value.lastIndexOf(":");
  if (separator <= 0) return null;
  const epoch = value.slice(0, separator);
  const sequenceText = value.slice(separator + 1);
  if (!/^\d+$/.test(sequenceText)) return null;
  const sequence = Number(sequenceText);
  if (!Number.isSafeInteger(sequence)) return null;
  return { epoch, sequence };
}

// ---------------------------------------------------------------------------
// Local event mapping (spec §5.3)
// ---------------------------------------------------------------------------

export type RacpEventMapping = {
  kind: RacpEventKind;
  durable: boolean;
  itemType?: RacpItemType;
};

/**
 * Fixed mapping from the shared normalized `AgentEvent` to the RACP kind.
 * `turn.completed` maps to the local `agent_end`, never to `turn_end`, which
 * only closes one model round. The caller says whether the Host recorded the
 * turn as aborted or stopped so `agent_end` becomes `turn.interrupted`.
 */
export function racpKindForAgentEvent(
  type: AgentEvent["type"],
  options: { interrupted?: boolean } = {},
): RacpEventMapping {
  switch (type) {
    case "agent_start":
      return { kind: "turn.started", durable: true };
    case "agent_end":
      return { kind: options.interrupted ? "turn.interrupted" : "turn.completed", durable: true };
    case "error":
      return { kind: "turn.failed", durable: true };
    case "turn_start":
    case "turn_end":
    case "status":
      return { kind: "turn.activity", durable: false };
    case "message_start":
      return { kind: "item.started", durable: true, itemType: "message" };
    case "message_update":
      return { kind: "item.delta", durable: false, itemType: "message" };
    case "message_end":
      return { kind: "item.completed", durable: true, itemType: "message" };
    case "tool_start":
      return { kind: "item.started", durable: true, itemType: "tool" };
    case "tool_update":
      return { kind: "tool.progress", durable: false, itemType: "tool" };
    case "tool_end":
      return { kind: "item.completed", durable: true, itemType: "tool" };
    case "compaction_start":
      return { kind: "item.started", durable: true, itemType: "compaction" };
    case "compaction_end":
      return { kind: "item.completed", durable: true, itemType: "compaction" };
    case "planning_state":
      return { kind: "session.changed", durable: true };
    case "tool_permission_request":
      return { kind: "approval.requested", durable: true };
    case "asktool_request":
      return { kind: "input.requested", durable: true };
    default: {
      const exhaustive: never = type;
      throw new Error(`unmapped agent event type: ${String(exhaustive)}`);
    }
  }
}

/** Every local `AgentEvent.type`, for completeness tests and generators. */
export const LOCAL_AGENT_EVENT_TYPES: readonly AgentEvent["type"][] = [
  "agent_start",
  "agent_end",
  "turn_start",
  "turn_end",
  "message_start",
  "message_update",
  "message_end",
  "tool_start",
  "tool_update",
  "tool_end",
  "planning_state",
  "tool_permission_request",
  "asktool_request",
  "compaction_start",
  "compaction_end",
  "error",
  "status",
];

// ---------------------------------------------------------------------------
// Remote permission ceiling (spec §7.3, security §4.3)
// ---------------------------------------------------------------------------

const PERMISSION_MODE_RANK: Record<RacpPermissionMode, number> = {
  ask: 0,
  "accept-edits": 1,
  auto: 2,
};

export type RacpCeilingInput = {
  sessionMode: RacpPermissionMode;
  policy: Pick<RacpPolicy, "remoteMaxPermissionMode" | "applyCeilingToPairedDevices">;
  /** True for the SSH-paired desktop device that owns the Host. */
  pairedDevice: boolean;
  /** True when the principal holds `approver` and Host policy lets approvers
   * use the session's own mode. */
  approverOverride: boolean;
};

/**
 * The mode a remote-initiated turn actually runs under: the lower of the
 * session mode and the ceiling, unless the principal is exempt.
 */
export function effectiveRemotePermissionMode(input: RacpCeilingInput): RacpPermissionMode {
  const exempt =
    (input.pairedDevice && !input.policy.applyCeilingToPairedDevices) || input.approverOverride;
  if (exempt) return input.sessionMode;
  const ceiling = input.policy.remoteMaxPermissionMode;
  return PERMISSION_MODE_RANK[input.sessionMode] <= PERMISSION_MODE_RANK[ceiling]
    ? input.sessionMode
    : ceiling;
}

// ---------------------------------------------------------------------------
// Errors (spec §13)
// ---------------------------------------------------------------------------

export type RacpErrorSpec = { retriable: boolean | "maybe" };

export const RACP_ERROR_CODES = {
  UNAUTHORIZED: { retriable: false },
  FORBIDDEN: { retriable: false },
  PROTOCOL_MISMATCH: { retriable: false },
  METHOD_NOT_FOUND: { retriable: false },
  INVALID_ARGUMENT: { retriable: false },
  NOT_FOUND: { retriable: false },
  AGENT_UNAVAILABLE: { retriable: true },
  AGENT_BUSY: { retriable: false },
  CONFLICT: { retriable: true },
  IDEMPOTENCY_CONFLICT: { retriable: false },
  CURSOR_EXPIRED: { retriable: false },
  CLIENT_TOO_SLOW: { retriable: true },
  APPROVAL_EXPIRED: { retriable: false },
  APPROVAL_STALE: { retriable: false },
  PAYLOAD_TOO_LARGE: { retriable: false },
  RATE_LIMITED: { retriable: true },
  TOOL_FAILED: { retriable: false },
  INTERNAL: { retriable: "maybe" },
} as const satisfies Record<string, RacpErrorSpec>;
export type RacpErrorCode = keyof typeof RACP_ERROR_CODES;

/**
 * Local outcomes that surface remotely under a RACP code (spec §5.5 rule 5,
 * §13). Anything not listed keeps its shared `AppError` code.
 */
export const RACP_ERROR_CODE_ALIASES: Record<string, RacpErrorCode> = {
  PERMISSION_TIMEOUT: "APPROVAL_EXPIRED",
  PLAN_APPROVAL_TIMEOUT: "APPROVAL_EXPIRED",
  PLAN_APPROVAL_STALE: "APPROVAL_STALE",
  SESSION_NOT_FOUND: "NOT_FOUND",
  TURN_NOT_FOUND: "NOT_FOUND",
  HOST_UNAVAILABLE: "AGENT_UNAVAILABLE",
};

export function toRacpErrorCode(localCode: string): string {
  return RACP_ERROR_CODE_ALIASES[localCode] ?? localCode;
}

export function racpErrorIsRegistered(code: RacpErrorCode): boolean {
  return Object.values(ErrorCodes).includes(code);
}

// ---------------------------------------------------------------------------
// Schema bundle (generated fixtures are derived from this object)
// ---------------------------------------------------------------------------

export const RACP_SCHEMAS = {
  RequestContext: RacpRequestContextSchema,
  Session: RacpSessionSchema,
  Turn: RacpTurnSchema,
  Cursor: RacpCursorSchema,
  EventEnvelope: RacpEventEnvelopeSchema,
  ItemSummary: RacpItemSummarySchema,
  SessionSnapshot: RacpSessionSnapshotSchema,
  ApprovalRequest: RacpApprovalRequestSchema,
  ApprovalResponse: RacpApprovalResponseSchema,
  ApprovalResult: RacpApprovalResultSchema,
  InputRequest: RacpInputRequestSchema,
  InputResponse: RacpInputResponseSchema,
  Attachment: RacpAttachmentSchema,
  HostSummary: RacpHostSummarySchema,
  ProjectSummary: RacpProjectSummarySchema,
  InitializeParams: RacpInitializeParamsSchema,
  InitializeResult: RacpInitializeResultSchema,
  RemoteError: RacpRemoteErrorSchema,
  Limits: RacpLimitsSchema,
  Policy: RacpPolicySchema,
} as const;
export type RacpSchemaName = keyof typeof RACP_SCHEMAS;
