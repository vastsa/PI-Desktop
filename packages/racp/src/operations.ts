import type { AgentHost, Principal } from "@pi-desktop/agent-host";
import { RacpError } from "@pi-desktop/agent-host";
import {
  RacpApprovalResponseSchema,
  RacpCursorSchema,
  RacpInputResponseSchema,
  RacpRequestContextSchema,
  type RacpCursor,
  type RacpLimits,
  type RacpOperation,
  type RacpServerCapabilities,
  type RacpEventEnvelope,
} from "@pi-desktop/shared";
import Type from "typebox";
import * as Value from "typebox/value";

import type { DeviceTokenAuthenticator } from "./auth.js";
import type { RacpHostOperations } from "./host-operations.js";
import type { RacpConnection } from "./server.js";

export type OperationContext = {
  connection: RacpConnection;
  principal: Principal;
  agentHost: AgentHost;
  operations: RacpHostOperations;
  authenticator: DeviceTokenAuthenticator;
  limits: RacpLimits;
  capabilities: RacpServerCapabilities;
  traceId: string;
  now: () => number;
  deliverEvent: (envelope: RacpEventEnvelope) => void;
  closeSubscription: (subscriptionId: string, error: RacpError, lastSafeCursor: RacpCursor) => void;
  log: (level: "info" | "warn" | "error", message: string, data?: Record<string, unknown>) => void;
};

export type OperationHandler = (context: OperationContext, params: Record<string, unknown>) => Promise<unknown>;

const SessionIdParams = Type.Object({ sessionId: Type.String({ minLength: 1 }) });
const TurnIdParams = Type.Object({ turnId: Type.String({ minLength: 1 }) });
const AttachParams = Type.Object({
  sessionId: Type.String({ minLength: 1 }),
  role: Type.Optional(Type.Union([Type.Literal("viewer"), Type.Literal("controller"), Type.Literal("approver"), Type.Literal("owner")])),
  after: Type.Optional(RacpCursorSchema),
  includeSnapshot: Type.Optional(Type.Boolean()),
});
const SubscribeParams = Type.Object({
  scope: Type.Union([Type.Literal("session"), Type.Literal("host")]),
  sessionId: Type.Optional(Type.String({ minLength: 1 })),
  after: Type.Optional(RacpCursorSchema),
});
const TurnStartParams = Type.Object({
  sessionId: Type.String({ minLength: 1 }),
  idempotencyKey: Type.Optional(Type.String({ minLength: 1 })),
  admission: Type.Optional(Type.Union([Type.Literal("reject_if_busy"), Type.Literal("queue")])),
  input: Type.Object({
    text: Type.String(),
    attachments: Type.Optional(Type.Array(Type.Unknown())),
    sessionMessageId: Type.Optional(Type.String()),
    /** Client-chosen id for the durable user row (D288). */
    messageId: Type.Optional(Type.String()),
  }),
  context: RacpRequestContextSchema,
});
const HistoryParams = Type.Object({
  sessionId: Type.String({ minLength: 1 }),
  beforeItemId: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ minimum: 1 })),
});
const SessionCreateParams = Type.Object({
  title: Type.Optional(Type.String()),
  projectId: Type.Optional(Type.String()),
  mode: Type.Optional(Type.Union([Type.Literal("agent"), Type.Literal("plan"), Type.Literal("goal")])),
  providerId: Type.Optional(Type.String()),
  modelId: Type.Optional(Type.String()),
  thinkingLevel: Type.Optional(Type.String()),
  permissionMode: Type.Optional(Type.Union([Type.Literal("ask"), Type.Literal("accept-edits"), Type.Literal("auto")])),
});
const SessionConfigureParams = Type.Object({
  sessionId: Type.String({ minLength: 1 }),
  mode: Type.Optional(Type.Union([Type.Literal("agent"), Type.Literal("plan"), Type.Literal("goal")])),
  providerId: Type.Optional(Type.String()),
  modelId: Type.Optional(Type.String()),
  thinkingLevel: Type.Optional(Type.String()),
  permissionMode: Type.Optional(Type.Union([Type.Literal("ask"), Type.Literal("accept-edits"), Type.Literal("auto")])),
});
const WorkspacePathParams = Type.Object({ sessionId: Type.String({ minLength: 1 }), path: Type.Optional(Type.String()) });
const TerminalOpenParams = Type.Object({
  sessionId: Type.String({ minLength: 1 }),
  cols: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
  rows: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
  /** Re-attach to a terminal this session already has open. */
  terminalId: Type.Optional(Type.String({ minLength: 1 })),
});
const TerminalInputParams = Type.Object({ terminalId: Type.String({ minLength: 1 }), data: Type.String() });
const TerminalResizeParams = Type.Object({
  terminalId: Type.String({ minLength: 1 }),
  cols: Type.Integer({ minimum: 1, maximum: 1000 }),
  rows: Type.Integer({ minimum: 1, maximum: 1000 }),
});
const TerminalIdParams = Type.Object({ terminalId: Type.String({ minLength: 1 }) });
const PairParams = Type.Object({ deviceLabel: Type.Optional(Type.String()) });

function check<T extends Type.TSchema>(schema: T, params: unknown): Type.Static<T> {
  if (!Value.Check(schema, params)) {
    const first = Value.Errors(schema, params)[Symbol.iterator]().next().value as { path?: string; message?: string } | undefined;
    throw new RacpError("INVALID_ARGUMENT", `invalid params${first?.path ? ` at ${first.path}` : ""}: ${first?.message ?? "schema mismatch"}`);
  }
  return params;
}

function requireTerminal(context: OperationContext) {
  const terminal = context.operations.terminal;
  if (!terminal || !context.capabilities.terminal) {
    throw new RacpError("CAPABILITY_UNAVAILABLE", "this Host does not offer terminals");
  }
  return terminal;
}

function unavailable(capability: string): OperationHandler {
  return async () => {
    throw new RacpError("CAPABILITY_UNAVAILABLE", `${capability} is not offered by this Host`);
  };
}

/** The operation catalog bound to the Agent Host module and the Host operations. */
export function createOperations(): Map<RacpOperation, OperationHandler> {
  const handlers = new Map<RacpOperation, OperationHandler>();

  handlers.set("connection/initialize", async () => {
    throw new RacpError("CONFLICT", "the connection is already initialized");
  });
  handlers.set("connection/ping", async (context) => ({ ok: true, serverTime: new Date(context.now()).toISOString() }));
  handlers.set("connection/pair", async (context, params) => {
    const input = check(PairParams, params);
    if (context.connection.auth.kind !== "pairing") {
      throw new RacpError("FORBIDDEN", "connection/pair needs a pairing token on the upgrade request");
    }
    const paired = await context.authenticator.pair(
      context.connection.auth.tokenHash,
      input.deviceLabel?.trim() || "desktop",
      ["owner"],
    ).catch((error: unknown) => {
      const code = (error as { errorCode?: string })?.errorCode;
      if (code === "PAIRING_FAILED" || code === "PAIRING_TOKEN_EXPIRED") {
        throw new RacpError(code, error instanceof Error ? error.message : String(error));
      }
      throw error;
    });
    context.log("info", "device paired", { deviceId: paired.deviceId, connectionId: context.connection.id });
    // The pairing connection stays unprivileged: the client reconnects with the device token.
    return { deviceId: paired.deviceId, deviceToken: paired.token, roles: ["owner"] };
  });
  handlers.set("host/list", async () => {
    throw new RacpError("METHOD_NOT_FOUND", "host/list exists only behind a Gateway");
  });

  handlers.set("project/list", async (context) => ({ projects: await context.operations.projects.list() }));
  handlers.set("project/register", async (context, params) => {
    const input = check(Type.Object({ path: Type.String({ minLength: 1 }) }), params);
    const project = await context.operations.projects.register(input.path);
    return { project };
  });
  handlers.set("project/browse", async (context, params) => {
    const input = check(Type.Object({ path: Type.Optional(Type.String()) }), params);
    return context.operations.projects.browse(input.path);
  });

  handlers.set("session/list", async (context) => {
    const sessions = await context.operations.sessions.list();
    return { sessions: sessions.map((summary) => context.agentHost.describeSession(summary)) };
  });
  handlers.set("session/get", async (context, params) => {
    const input = check(SessionIdParams, params);
    const summary = (await context.operations.sessions.list()).find((candidate) => candidate.id === input.sessionId);
    if (!summary) throw new RacpError("NOT_FOUND", `session ${input.sessionId} is unknown`);
    return { session: context.agentHost.describeSession(summary) };
  });
  handlers.set("session/create", async (context, params) => {
    const input = check(SessionCreateParams, params);
    const summary = await context.operations.sessions.create(input, context.principal);
    context.agentHost.publishSessionChange("session.created", summary);
    return { session: context.agentHost.describeSession(summary) };
  });
  handlers.set("session/attach", async (context, params) => {
    const input = check(AttachParams, params);
    return context.agentHost.attach(context.principal, {
      sessionId: input.sessionId,
      ...(input.role ? { role: input.role } : {}),
      ...(input.after ? { after: input.after } : {}),
      ...(input.includeSnapshot !== undefined ? { includeSnapshot: input.includeSnapshot } : {}),
    });
  });
  handlers.set("session/history", async (context, params) => {
    const input = check(HistoryParams, params);
    return context.agentHost.history(context.principal, input);
  });

  handlers.set("events/subscribe", async (context, params) => {
    const input = check(SubscribeParams, params);
    if (context.connection.subscriptions.size >= context.limits.maxSubscriptionsPerConnection) {
      throw new RacpError("RATE_LIMITED", "subscription limit reached for this connection", {
        details: { limit: context.limits.maxSubscriptionsPerConnection },
      });
    }
    const result = context.agentHost.subscribe(
      context.principal,
      { scope: input.scope, ...(input.sessionId ? { sessionId: input.sessionId } : {}), ...(input.after ? { after: input.after } : {}) },
      {
        deliver: (envelope) => context.deliverEvent(envelope),
        close: (error, lastSafeCursor) => context.closeSubscription(result.subscriptionId, error, lastSafeCursor),
      },
    );
    context.connection.subscriptions.set(result.subscriptionId, {
      id: result.subscriptionId,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    });
    return result;
  });
  handlers.set("events/unsubscribe", async (context, params) => {
    const input = check(Type.Object({ subscriptionId: Type.String({ minLength: 1 }) }), params);
    const subscription = context.connection.subscriptions.get(input.subscriptionId);
    if (!subscription) return { removed: false };
    context.connection.subscriptions.delete(input.subscriptionId);
    return { removed: context.agentHost.unsubscribe(subscription.id, subscription.sessionId) };
  });
  handlers.set("events/ack", async (context, params) => {
    const input = check(Type.Object({ subscriptionId: Type.String({ minLength: 1 }), sequence: Type.Integer({ minimum: 0 }) }), params);
    if (context.connection.subscriptions.has(input.subscriptionId)) {
      context.agentHost.ack(input.subscriptionId, input.sequence);
    }
    return { ok: true };
  });

  handlers.set("turn/start", async (context, params) => {
    const input = check(TurnStartParams, params);
    if (Buffer.byteLength(input.input.text, "utf8") > context.limits.maxPromptBytes) {
      throw new RacpError("PAYLOAD_TOO_LARGE", "prompt exceeds maxPromptBytes");
    }
    if (input.input.attachments?.length) {
      throw new RacpError("CAPABILITY_UNAVAILABLE", "attachments are not offered by this Host");
    }
    return context.agentHost.startTurn(context.principal, {
      sessionId: input.sessionId,
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      ...(input.admission ? { admission: input.admission } : {}),
      input: {
        text: input.input.text,
        ...(input.input.sessionMessageId ? { sessionMessageId: input.input.sessionMessageId } : {}),
        ...(input.input.messageId ? { userMessageId: input.input.messageId } : {}),
      },
      context: input.context,
    });
  });
  handlers.set("turn/get", async (context, params) => ({ turn: context.agentHost.getTurn(check(TurnIdParams, params).turnId) }));
  handlers.set("turn/stop", async (context, params) => ({
    turn: await context.agentHost.stopTurn(context.principal, check(TurnIdParams, params).turnId),
  }));
  handlers.set("turn/interrupt", async (context, params) => ({
    turn: await context.agentHost.interruptTurn(context.principal, check(TurnIdParams, params).turnId),
  }));
  handlers.set("turn/cancel", async (context, params) => ({
    turn: await context.agentHost.cancelTurn(context.principal, check(TurnIdParams, params).turnId),
  }));
  handlers.set("turn/prioritize", async (context, params) => ({
    turn: await context.agentHost.prioritizeTurn(context.principal, check(TurnIdParams, params).turnId),
  }));

  handlers.set("approval/respond", async (context, params) =>
    context.agentHost.respondApproval(context.principal, check(RacpApprovalResponseSchema, params)),
  );
  handlers.set("input/respond", async (context, params) =>
    context.agentHost.respondInput(context.principal, check(RacpInputResponseSchema, params)),
  );

  handlers.set("attachment/create", unavailable("attachments"));
  handlers.set("attachment/complete", unavailable("attachments"));
  handlers.set("tools/advertise", unavailable("tool relay"));

  handlers.set("session/revoke", async (context, params) => {
    const input = check(Type.Object({ deviceId: Type.String({ minLength: 1 }) }), params);
    const revoke = context.operations.revokeDevice;
    if (!revoke) throw new RacpError("CAPABILITY_UNAVAILABLE", "device revocation is not offered by this Host");
    return { revoked: await revoke(input.deviceId) };
  });
  handlers.set("session/archive", unavailable("session archival"));

  handlers.set("session/configure", async (context, params) => {
    const { sessionId, ...input } = check(SessionConfigureParams, params);
    const summary = await context.operations.sessions.configure(sessionId, input);
    context.agentHost.publishSessionChange("session.changed", summary);
    return { session: context.agentHost.describeSession(summary) };
  });
  handlers.set("session/fork", async (context, params) => {
    const input = check(Type.Object({ sessionId: Type.String({ minLength: 1 }), title: Type.Optional(Type.String()), throughMessageId: Type.Optional(Type.String()) }), params);
    const summary = await context.operations.sessions.fork(input.sessionId, input);
    context.agentHost.publishSessionChange("session.created", summary);
    return { session: context.agentHost.describeSession(summary) };
  });
  handlers.set("session/rename", async (context, params) => {
    const input = check(Type.Object({ sessionId: Type.String({ minLength: 1 }), title: Type.String({ minLength: 1 }) }), params);
    await context.operations.sessions.rename(input.sessionId, input.title);
    const summary = (await context.operations.sessions.list()).find((candidate) => candidate.id === input.sessionId);
    if (summary) context.agentHost.publishSessionChange("session.changed", summary);
    return { ok: true };
  });
  handlers.set("session/delete", async (context, params) => {
    const input = check(SessionIdParams, params);
    await context.operations.sessions.delete(input.sessionId);
    return { ok: true };
  });
  handlers.set("session/compact", async (context, params) => {
    const input = check(SessionIdParams, params);
    return context.operations.sessions.compact(input.sessionId);
  });

  handlers.set("workspace/list", async (context, params) => {
    const input = check(WorkspacePathParams, params);
    return context.operations.workspace.list(input.sessionId, input.path ?? "");
  });
  handlers.set("workspace/read", async (context, params) => {
    const input = check(WorkspacePathParams, params);
    if (!input.path) throw new RacpError("INVALID_ARGUMENT", "path is required");
    return context.operations.workspace.read(input.sessionId, input.path);
  });
  handlers.set("workspace/diff", async (context, params) => {
    const input = check(SessionIdParams, params);
    return context.operations.workspace.diff(input.sessionId);
  });

  handlers.set("terminal/open", async (context, params) => {
    const terminal = requireTerminal(context);
    const input = check(TerminalOpenParams, params);
    const sink = {
      output: (data: string) =>
        context.deliverEvent(terminalEvent(context, input.sessionId, "terminal.output", { terminalId: opened.terminalId, data })),
      exit: (code: number | null) => {
        context.connection.terminals.delete(opened.terminalId);
        context.deliverEvent(terminalEvent(context, input.sessionId, "terminal.changed", { terminalId: opened.terminalId, state: "exited", code }));
      },
    };
    let opened: Awaited<ReturnType<typeof terminal.open>>;
    if (input.terminalId) {
      const attached = await terminal.attach(input.terminalId, sink);
      if (!attached) throw new RacpError("NOT_FOUND", `terminal ${input.terminalId} is not open`);
      opened = attached;
    } else {
      opened = await terminal.open(input.sessionId, { cols: input.cols ?? 80, rows: input.rows ?? 24 }, sink);
    }
    context.connection.terminals.add(opened.terminalId);
    return opened;
  });
  handlers.set("terminal/input", async (context, params) => {
    const input = check(TerminalInputParams, params);
    await requireTerminal(context).input(input.terminalId, input.data);
    return { ok: true };
  });
  handlers.set("terminal/resize", async (context, params) => {
    const input = check(TerminalResizeParams, params);
    await requireTerminal(context).resize(input.terminalId, input.cols, input.rows);
    return { ok: true };
  });
  handlers.set("terminal/close", async (context, params) => {
    const input = check(TerminalIdParams, params);
    context.connection.terminals.delete(input.terminalId);
    await requireTerminal(context).close(input.terminalId);
    return { ok: true };
  });

  return handlers;
}

/** Terminal events are connection-local: they never enter the replay log (spec §5.3). */
function terminalEvent(
  context: OperationContext,
  sessionId: string,
  kind: "terminal.output" | "terminal.changed",
  payload: Record<string, unknown>,
): RacpEventEnvelope {
  const cursor = context.agentHost.hub.stream(sessionId).cursor();
  return {
    eventId: `term_${context.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    scope: "session",
    sessionId,
    epoch: cursor.epoch,
    ...(kind === "terminal.output" ? { afterSequence: cursor.sequence } : { sequence: cursor.sequence }),
    revision: 0,
    kind,
    occurredAt: new Date(context.now()).toISOString(),
    payload,
  };
}
