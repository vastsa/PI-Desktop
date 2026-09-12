import { describe, expect, it } from "vitest";
import * as Value from "typebox/value";

import { ErrorCodes } from "./errors.js";
import {
  LOCAL_AGENT_EVENT_TYPES,
  RACP_DEFAULT_LIMITS,
  RACP_DEFAULT_POLICY,
  RACP_EPHEMERAL_EVENT_KINDS,
  RACP_ERROR_CODES,
  RACP_EVENT_KINDS,
  RACP_HTTP_ROUTES,
  RACP_OPERATIONS,
  RACP_SCHEMAS,
  RACP_SHIPPED_BINDINGS,
  RacpEventEnvelopeSchema,
  RacpInitializeResultSchema,
  RacpSessionSnapshotSchema,
  allowedDecisionsAreCoherent,
  effectiveRemotePermissionMode,
  eventEnvelopeSequencingIsValid,
  formatRacpCursor,
  isDurableEventKind,
  parseRacpCursor,
  protocolVersionsCompatible,
  racpErrorIsRegistered,
  racpKindForAgentEvent,
  rolesAllowOperation,
  toRacpErrorCode,
  type RacpApprovalRequest,
  type RacpEventEnvelope,
  type RacpInitializeResult,
  type RacpSessionSnapshot,
} from "./racp.js";

const session = {
  id: "ses_01J",
  title: "Fix the failing test",
  projectId: "proj_1",
  mode: "agent",
  status: "idle",
  planningState: "inactive",
  permissionMode: "ask",
  queuedTurnIds: [],
  revision: 22,
  createdAt: "2026-09-10T00:00:00.000Z",
  updatedAt: "2026-09-10T00:00:00.000Z",
} as const;

const initializeResult: RacpInitializeResult = {
  protocolVersion: "1.0",
  server: { name: "pi-desktop-agent-host", version: "0.1.0" },
  connectionId: "conn_01J",
  principal: { subject: "user_123", roles: ["viewer", "controller"] },
  capabilities: {
    eventReplay: true,
    snapshot: true,
    approvals: true,
    inputRequests: true,
    attachments: true,
    serverRequests: true,
    turnQueue: true,
    hostEvents: true,
    history: true,
    remoteHostProfile: true,
    toolRelay: true,
    terminal: true,
    notifications: false,
    bindings: ["RACP-WS"],
  },
  limits: RACP_DEFAULT_LIMITS,
  policy: RACP_DEFAULT_POLICY,
};

describe("RACP schemas", () => {
  it("accepts the spec initialization result", () => {
    expect(Value.Check(RacpInitializeResultSchema, initializeResult)).toBe(true);
  });

  it("rejects an initialization result that advertises an unknown binding", () => {
    const broken = {
      ...initializeResult,
      capabilities: { ...initializeResult.capabilities, bindings: ["RACP-FTP"] },
    };
    expect(Value.Check(RacpInitializeResultSchema, broken)).toBe(false);
  });

  it("accepts a snapshot with pending requests and queued turns", () => {
    const snapshot: RacpSessionSnapshot = {
      session: { ...session, status: "running", activeTurnId: "turn_1", queuedTurnIds: ["turn_2"] },
      activeTurn: {
        id: "turn_1",
        sessionId: session.id,
        status: "waiting_approval",
        admission: "reject_if_busy",
        effectivePermissionMode: "ask",
        startedAt: "2026-09-10T00:00:01.000Z",
      },
      queuedTurns: [
        {
          id: "turn_2",
          sessionId: session.id,
          status: "queued",
          admission: "queue",
          queuePosition: 1,
          effectivePermissionMode: "ask",
          idempotencyKey: "turn-client-7f9c",
        },
      ],
      items: [],
      activeItems: [
        {
          id: "item_1",
          turnId: "turn_1",
          itemType: "message",
          status: "streaming",
          createdAt: "2026-09-10T00:00:01.000Z",
          content: { role: "assistant", content: "partial" },
        },
      ],
      pendingApprovals: [
        {
          id: "approval_1",
          sessionId: session.id,
          turnId: "turn_1",
          kind: "tool",
          summary: "Run the selected shell command",
          expiresAt: "2026-09-10T00:30:00.000Z",
          revision: 22,
          toolName: "Bash",
          risk: "high",
          allowedDecisions: ["allow-once", "allow-session", "deny"],
        },
      ],
      pendingInputs: [],
      hasMoreHistory: true,
      cursor: { epoch: "ep_7f", sequence: 314 },
      revision: 22,
      generatedAt: "2026-09-10T00:00:02.000Z",
    };
    expect(Value.Check(RacpSessionSnapshotSchema, snapshot)).toBe(true);
  });

  it("keeps every named schema in the generated fixture bundle", () => {
    const bundle = JSON.stringify(RACP_SCHEMAS, null, 2) + "\n";
    expect(bundle).toMatchFileSnapshot("../fixtures/racp.schema.json");
  });
});

describe("event envelopes", () => {
  const base: Omit<RacpEventEnvelope, "kind" | "sequence" | "afterSequence"> = {
    eventId: "evt_1",
    scope: "session",
    sessionId: session.id,
    turnId: "turn_1",
    epoch: "ep_7f",
    revision: 22,
    occurredAt: "2026-09-10T00:00:01.000Z",
    payload: {},
  };

  it("classifies every kind as durable or ephemeral", () => {
    for (const kind of RACP_EVENT_KINDS) {
      expect(typeof isDurableEventKind(kind)).toBe("boolean");
    }
    expect(RACP_EPHEMERAL_EVENT_KINDS).toEqual([
      "turn.activity",
      "item.delta",
      "tool.progress",
      "terminal.output",
    ]);
  });

  it("requires sequence on durable events and afterSequence on ephemeral ones", () => {
    const durable: RacpEventEnvelope = { ...base, kind: "item.completed", sequence: 315 };
    const ephemeral: RacpEventEnvelope = { ...base, kind: "item.delta", afterSequence: 315 };
    const wrong: RacpEventEnvelope = { ...base, kind: "item.delta", sequence: 316 };
    expect(Value.Check(RacpEventEnvelopeSchema, durable)).toBe(true);
    expect(eventEnvelopeSequencingIsValid(durable)).toBe(true);
    expect(eventEnvelopeSequencingIsValid(ephemeral)).toBe(true);
    expect(eventEnvelopeSequencingIsValid(wrong)).toBe(false);
  });

  it("maps every local AgentEvent type and never maps turn_end to turn.completed", () => {
    for (const type of LOCAL_AGENT_EVENT_TYPES) {
      const mapping = racpKindForAgentEvent(type);
      expect(RACP_EVENT_KINDS).toContain(mapping.kind);
      expect(mapping.durable).toBe(isDurableEventKind(mapping.kind));
    }
    expect(racpKindForAgentEvent("turn_end").kind).toBe("turn.activity");
    expect(racpKindForAgentEvent("agent_end").kind).toBe("turn.completed");
    expect(racpKindForAgentEvent("agent_end", { interrupted: true }).kind).toBe("turn.interrupted");
    expect(racpKindForAgentEvent("compaction_end")).toEqual({
      kind: "item.completed",
      durable: true,
      itemType: "compaction",
    });
    expect(racpKindForAgentEvent("message_update").durable).toBe(false);
  });

  it("round-trips the SSE cursor form", () => {
    const cursor = { epoch: "ep_7f", sequence: 314 };
    expect(formatRacpCursor(cursor)).toBe("ep_7f:314");
    expect(parseRacpCursor("ep_7f:314")).toEqual(cursor);
    expect(parseRacpCursor("ep:with:colons:9")).toEqual({ epoch: "ep:with:colons", sequence: 9 });
    expect(parseRacpCursor("nocolon")).toBeNull();
    expect(parseRacpCursor("ep_7f:x")).toBeNull();
    expect(parseRacpCursor(":3")).toBeNull();
  });
});

describe("approvals", () => {
  const toolRequest: RacpApprovalRequest = {
    id: "approval_1",
    sessionId: session.id,
    turnId: "turn_1",
    kind: "tool",
    summary: "Run the selected shell command",
    expiresAt: "2026-09-10T00:30:00.000Z",
    revision: 22,
    allowedDecisions: ["allow-once", "allow-session", "deny"],
  };

  it("offers the local tool vocabulary and requires a permission mode on contracts", () => {
    expect(allowedDecisionsAreCoherent(toolRequest)).toBe(true);
    expect(
      allowedDecisionsAreCoherent({ ...toolRequest, allowedDecisions: ["approve", "reject"] }),
    ).toBe(false);
    const plan: RacpApprovalRequest = {
      ...toolRequest,
      kind: "plan",
      allowedDecisions: ["approve", "reject"],
      allowedPermissionModes: ["ask", "accept-edits", "auto"],
    };
    expect(allowedDecisionsAreCoherent(plan)).toBe(true);
    expect(allowedDecisionsAreCoherent({ ...plan, allowedPermissionModes: undefined })).toBe(false);
    expect(allowedDecisionsAreCoherent({ ...plan, allowedDecisions: ["allow-once"] })).toBe(false);
  });

  it("validates schemas for every request shape", () => {
    expect(Value.Check(RACP_SCHEMAS.ApprovalRequest, toolRequest)).toBe(true);
    expect(
      Value.Check(RACP_SCHEMAS.InputResponse, {
        inputId: "input_1",
        answers: [["a"], null],
        context: { requestId: "req_1", idempotencyKey: "k1", expectedRevision: 22 },
      }),
    ).toBe(true);
  });
});

describe("remote permission ceiling", () => {
  const policy = { remoteMaxPermissionMode: "ask", applyCeilingToPairedDevices: false } as const;

  it("caps gateway-routed principals at the ceiling", () => {
    expect(
      effectiveRemotePermissionMode({
        sessionMode: "auto",
        policy,
        pairedDevice: false,
        approverOverride: false,
      }),
    ).toBe("ask");
    expect(
      effectiveRemotePermissionMode({
        sessionMode: "accept-edits",
        policy: { ...policy, remoteMaxPermissionMode: "auto" },
        pairedDevice: false,
        approverOverride: false,
      }),
    ).toBe("accept-edits");
  });

  it("exempts paired devices unless the host policy re-applies the ceiling", () => {
    expect(
      effectiveRemotePermissionMode({
        sessionMode: "auto",
        policy,
        pairedDevice: true,
        approverOverride: false,
      }),
    ).toBe("auto");
    expect(
      effectiveRemotePermissionMode({
        sessionMode: "auto",
        policy: { ...policy, applyCeilingToPairedDevices: true },
        pairedDevice: true,
        approverOverride: false,
      }),
    ).toBe("ask");
    expect(
      effectiveRemotePermissionMode({
        sessionMode: "auto",
        policy: { ...policy, applyCeilingToPairedDevices: true },
        pairedDevice: true,
        approverOverride: true,
      }),
    ).toBe("auto");
  });
});

describe("catalog and roles", () => {
  it("lets owners do everything and keeps approver and controller separate", () => {
    expect(rolesAllowOperation(["owner"], "session/archive")).toBe(true);
    expect(rolesAllowOperation(["viewer"], "turn/start")).toBe(false);
    expect(rolesAllowOperation(["controller"], "turn/start")).toBe(true);
    expect(rolesAllowOperation(["controller"], "approval/respond")).toBe(false);
    expect(rolesAllowOperation(["approver"], "approval/respond")).toBe(true);
    expect(rolesAllowOperation(["approver"], "turn/start")).toBe(false);
    expect(rolesAllowOperation(["approver"], "session/get")).toBe(true);
    expect(rolesAllowOperation([], "connection/initialize")).toBe(true);
    expect(rolesAllowOperation([], "session/get")).toBe(false);
  });

  it("maps every HTTP route to a catalog operation", () => {
    for (const operation of Object.keys(RACP_HTTP_ROUTES)) {
      expect(RACP_OPERATIONS).toHaveProperty(operation);
    }
    expect(RACP_SHIPPED_BINDINGS).toEqual(["RACP-WS"]);
  });

  it("marks every operation with a profile", () => {
    for (const spec of Object.values(RACP_OPERATIONS)) {
      expect(["v1", "remote-host"]).toContain(spec.profile);
    }
  });
});

describe("versions and errors", () => {
  it("accepts minor additions and rejects a different major", () => {
    expect(protocolVersionsCompatible("1.0", "1.0")).toBe(true);
    expect(protocolVersionsCompatible("1.0", "1.3")).toBe(true);
    expect(protocolVersionsCompatible("1.0", "2.0")).toBe(false);
    expect(protocolVersionsCompatible("1.0", "banana")).toBe(false);
  });

  it("registers every RACP code in the shared AppError vocabulary", () => {
    for (const code of Object.keys(RACP_ERROR_CODES) as Array<keyof typeof RACP_ERROR_CODES>) {
      expect(racpErrorIsRegistered(code), code).toBe(true);
      expect(Object.values(ErrorCodes)).toContain(code);
    }
  });

  it("maps local timeout outcomes to APPROVAL_EXPIRED", () => {
    expect(toRacpErrorCode("PERMISSION_TIMEOUT")).toBe("APPROVAL_EXPIRED");
    expect(toRacpErrorCode("PLAN_APPROVAL_TIMEOUT")).toBe("APPROVAL_EXPIRED");
    expect(toRacpErrorCode("TOOL_DENIED")).toBe("TOOL_DENIED");
  });

  it("keeps the spec default limits and policy", () => {
    expect(RACP_DEFAULT_LIMITS.maxFrameBytes).toBe(1048576);
    expect(RACP_DEFAULT_LIMITS.maxPromptBytes).toBe(262144);
    expect(RACP_DEFAULT_LIMITS.maxAttachmentBytes).toBe(52428800);
    expect(RACP_DEFAULT_LIMITS.replayWindowEvents).toBe(10000);
    expect(RACP_DEFAULT_LIMITS.maxQueuedTurnsPerSession).toBe(8);
    expect(RACP_DEFAULT_POLICY).toEqual({
      remoteMaxPermissionMode: "ask",
      applyCeilingToPairedDevices: false,
      approvalLifetimeMs: 1800000,
    });
  });
});
