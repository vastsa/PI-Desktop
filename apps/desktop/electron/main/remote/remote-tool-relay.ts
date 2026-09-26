import {
  ErrorCodes,
  isBoundedRacpRelayJson,
  isValidRacpToolsAdvertiseParams,
  RacpToolCancelParamsSchema,
  RacpToolExecuteParamsSchema,
  RACP_TOOL_RELAY_LIMITS,
  type RacpInitializeResult,
  type RacpRelayTool,
  type RacpServerCapabilities,
} from "@pi-desktop/shared";
import * as Value from "typebox/value";
import type { TSchema } from "typebox";
import { MCP_CALL_TIMEOUT_MS } from "../plugin-mcp.js";
import type { UserMcpToolDescriptor } from "../user-mcp.js";

type RelayClient = {
  request<T>(method: string, params?: unknown): Promise<T>;
  initialized?(): RacpInitializeResult | undefined;
  hostCapabilities?(): RacpServerCapabilities | undefined;
};

type RemoteUserMcpRuntime = {
  toolsForRemoteSession(): Promise<UserMcpToolDescriptor[]>;
  callTool(
    fullName: string,
    args: unknown,
    projectPath: null,
    sessionId: string,
  ): Promise<unknown>;
  cancelSessionCalls(sessionId: string): void;
  onCatalogChanged?(listener: () => void): () => void;
};

export type RemoteToolRelayOptions = {
  hostKey: string;
  /** True only for a saved device-token connection, never a pairing exchange. */
  pairedDevice: boolean;
  client: RelayClient;
  userMcp: RemoteUserMcpRuntime;
  log?: (level: "warn" | "error", message: string, data?: unknown) => void;
  /** Injectable deadline for deterministic cancellation tests. */
  scheduleTimeout?: (callback: () => void, delayMs: number) => () => void;
};

export type RemoteToolRelay = {
  /** Add a Host session and replace its advertised tool catalog. */
  addSession(sessionId: string): Promise<void>;
  /** Stop routing a removed Host session and cancel its in-flight calls. */
  removeSession(sessionId: string): void;
  /** Replace all known session catalogs after a source or transport change. */
  refreshAll(): Promise<void>;
  /** Handle the only server request this Desktop relay accepts. */
  handleServerRequest(method: string, params: unknown): Promise<unknown>;
  /** The RACP transport disconnected; cancel local calls and clear snapshots. */
  disconnected(): void;
  /** Re-advertise after the RACP adapter has restored its connection. */
  reconnected(): Promise<void>;
  /** Remove catalog listeners and cancel work when the owner connection closes. */
  close(): void;
};

type ActiveCall = {
  sessionId: string;
  turnId: string;
  executionId: string;
  toolCallId: string;
  executionKey: string;
  canceled: boolean;
  cancellation: Promise<CallOutcome>;
  cancel: (code: string, message: string) => void;
};

type CallOutcome =
  | { kind: "result"; value: unknown }
  | { kind: "failed"; error: unknown }
  | { kind: "canceled"; code: string; message: string };

const MAX_RELAY_TOOLS = RACP_TOOL_RELAY_LIMITS.maxToolsPerSession;
const MAX_SEEN_EXECUTIONS = 512;
const SAFE_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  [ErrorCodes.INVALID_ARGUMENT]: "The relayed tool request is invalid.",
  [ErrorCodes.TOOL_NOT_FOUND]: "The relayed tool is not available.",
  [ErrorCodes.HOST_DISCONNECTED]: "The remote Host connection was closed.",
  [ErrorCodes.TIMEOUT]: "The relayed tool timed out.",
  [ErrorCodes.TOOL_FAILED]: "The relayed tool failed.",
};

function invalidArgument(message: string): Error {
  return Object.assign(new Error(message), { errorCode: ErrorCodes.INVALID_ARGUMENT });
}

function unavailable(message: string): Error {
  return Object.assign(new Error(message), { errorCode: ErrorCodes.CAPABILITY_UNAVAILABLE });
}

function notFound(message: string): Error {
  return Object.assign(new Error(message), { errorCode: ErrorCodes.TOOL_NOT_FOUND });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function safeJson(value: unknown): string | null {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" ? serialized : null;
  } catch {
    return null;
  }
}

function isAuthorized(client: RelayClient, pairedDevice: boolean): boolean {
  if (!pairedDevice) return false;
  const initialized = client.initialized?.();
  return initialized?.principal.roles.includes("owner") === true &&
    client.hostCapabilities?.()?.toolRelay === true;
}

function toRelayTool(descriptor: UserMcpToolDescriptor, sessionId: string): RacpRelayTool | null {
  if (
    !/^mcp_[A-Za-z0-9_]+$/.test(descriptor.fullName) ||
    descriptor.fullName.length > RACP_TOOL_RELAY_LIMITS.maxToolNameLength ||
    typeof descriptor.description !== "string" ||
    !isRecord(descriptor.schema) ||
    descriptor.schema.type !== "object"
  ) {
    return null;
  }

  const candidate: RacpRelayTool = {
    name: descriptor.fullName,
    description: descriptor.description,
    inputSchema: descriptor.schema,
    timeoutMs: MCP_CALL_TIMEOUT_MS,
    workspaceFree: true,
  };
  return isValidRacpToolsAdvertiseParams({ sessionId, tools: [candidate] }) ? candidate : null;
}

function validateToolArgs(tool: RacpRelayTool, args: unknown): boolean {
  if (!isRecord(args) || !isBoundedRacpRelayJson(args)) return false;
  try {
    return Value.Check(tool.inputSchema as TSchema, args);
  } catch {
    // A malformed schema from an MCP peer is not permission to call it.
    return false;
  }
}

function errorResult(code: string): { result: { code: string; message: string }; isError: true } {
  return {
    result: {
      code,
      message: SAFE_ERROR_MESSAGES[code] ?? SAFE_ERROR_MESSAGES[ErrorCodes.TOOL_FAILED]!,
    },
    isError: true,
  };
}

export function createRemoteToolRelay(options: RemoteToolRelayOptions): RemoteToolRelay {
  const log = options.log ?? (() => undefined);
  const scheduleTimeout = options.scheduleTimeout ?? ((callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  });
  const sessions = new Set<string>();
  const catalogs = new Map<string, Map<string, RacpRelayTool>>();
  const updates = new Map<string, Promise<void>>();
  const activeCalls = new Map<string, ActiveCall>();
  const seenExecutions = new Set<string>();
  let connected = true;
  let closed = false;

  const subscribeCatalog = options.userMcp.onCatalogChanged?.(() => {
    void refreshAll();
  });

  const canRelay = (): boolean => !closed && connected && isAuthorized(options.client, options.pairedDevice);

  const rememberExecution = (executionKey: string): void => {
    if (seenExecutions.has(executionKey)) {
      throw Object.assign(new Error("duplicate remote MCP execution"), { errorCode: ErrorCodes.CONFLICT });
    }
    seenExecutions.add(executionKey);
    while (seenExecutions.size > MAX_SEEN_EXECUTIONS) {
      const oldest = seenExecutions.values().next().value;
      if (oldest === undefined) break;
      seenExecutions.delete(oldest);
    }
  };

  const beginCall = (params: {
    executionId: string;
    sessionId: string;
    turnId: string;
    toolCallId: string;
  }): ActiveCall => {
    const executionKey = `remote-mcp:${JSON.stringify([options.hostKey, params.sessionId, params.executionId])}`;
    rememberExecution(executionKey);
    let finishCancellation!: (outcome: CallOutcome) => void;
    const cancellation = new Promise<CallOutcome>((resolve) => {
      finishCancellation = resolve;
    });
    const active: ActiveCall = {
      sessionId: params.sessionId,
      turnId: params.turnId,
      executionId: params.executionId,
      toolCallId: params.toolCallId,
      executionKey,
      canceled: false,
      cancellation,
      cancel(code, message) {
        finishCancellation({ kind: "canceled", code, message });
      },
    };
    activeCalls.set(executionKey, active);
    return active;
  };

  const forgetCall = (active: ActiveCall): void => {
    if (activeCalls.get(active.executionKey) === active) activeCalls.delete(active.executionKey);
  };

  const currentCatalog = async (sessionId: string): Promise<Map<string, RacpRelayTool>> => {
    const discovered = await options.userMcp.toolsForRemoteSession();
    const catalog = new Map<string, RacpRelayTool>();
    for (const descriptor of discovered) {
      const tool = toRelayTool(descriptor, sessionId);
      if (tool) catalog.set(tool.name, tool);
    }
    return new Map([...catalog].sort(([left], [right]) => left.localeCompare(right)).slice(0, MAX_RELAY_TOOLS));
  };

  const cancelCall = (call: ActiveCall, code: string, message: string): void => {
    if (activeCalls.get(call.executionKey) !== call) return;
    if (call.canceled) return;
    call.canceled = true;
    options.userMcp.cancelSessionCalls(call.executionKey);
    call.cancel(code, message);
  };

  const cancelSessionCalls = (sessionId: string, code: string, message: string): void => {
    for (const call of activeCalls.values()) {
      if (call.sessionId === sessionId) cancelCall(call, code, message);
    }
  };

  const updateSession = (sessionId: string): Promise<void> => {
    const previous = updates.get(sessionId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        if (!sessions.has(sessionId)) return;
        if (!canRelay()) {
          catalogs.delete(sessionId);
          return;
        }
        const catalog = await currentCatalog(sessionId);
        if (!sessions.has(sessionId) || !canRelay()) return;
        const tools = [...catalog.values()];
        const params = { sessionId, tools };
        if (!isValidRacpToolsAdvertiseParams(params)) {
          catalogs.delete(sessionId);
          log("warn", "remote MCP catalog failed RACP validation", { hostKey: options.hostKey });
          return;
        }
        await options.client.request("tools/advertise", params);
        if (sessions.has(sessionId) && canRelay()) catalogs.set(sessionId, catalog);
      })
      .catch((error: unknown) => {
        catalogs.delete(sessionId);
        log("warn", "remote MCP catalog advertisement failed", {
          hostKey: options.hostKey,
          sessionId,
          error: error instanceof Error ? error.message.slice(0, 300) : "unknown error",
        });
      });
    updates.set(sessionId, next);
    void next.finally(() => {
      if (updates.get(sessionId) === next) updates.delete(sessionId);
    });
    return next;
  };

  const refreshAll = async (): Promise<void> => {
    await Promise.all([...sessions].map((sessionId) => updateSession(sessionId)));
  };

  const runTool = async (params: {
    executionId: string;
    sessionId: string;
    turnId: string;
    toolCallId: string;
    toolName: string;
    args: Record<string, unknown>;
  }, tool: RacpRelayTool, active: ActiveCall): Promise<unknown> => {
    const cancelTimer = scheduleTimeout(() => {
      cancelCall(active, ErrorCodes.TIMEOUT, "tool deadline elapsed");
    }, tool.timeoutMs);

    try {
      const invocation: Promise<CallOutcome> = active.canceled
        ? Promise.resolve({ kind: "canceled", code: ErrorCodes.TOOL_FAILED, message: "tool call was canceled before execution" })
        : options.userMcp.callTool(
            params.toolName,
            params.args,
            null,
            active.executionKey,
          ).then<CallOutcome, CallOutcome>(
            (value): CallOutcome => ({ kind: "result", value }),
            (error: unknown): CallOutcome => ({ kind: "failed", error }),
          );
      const outcome = await Promise.race([invocation, active.cancellation]);
      if (outcome.kind === "canceled") return errorResult(outcome.code);
      if (outcome.kind === "failed") {
        const code = (outcome.error as { errorCode?: unknown; code?: unknown } | null)?.errorCode ??
          (outcome.error as { code?: unknown } | null)?.code;
        return errorResult(typeof code === "string" && SAFE_ERROR_MESSAGES[code]
          ? code
          : ErrorCodes.TOOL_FAILED);
      }
      if (!isBoundedRacpRelayJson(outcome.value, RACP_TOOL_RELAY_LIMITS.maxResultBytes)) {
        return errorResult(ErrorCodes.TOOL_FAILED);
      }
      return { result: outcome.value, isError: false };
    } finally {
      cancelTimer();
      forgetCall(active);
    }
  };

  return {
    addSession(sessionId) {
      if (typeof sessionId !== "string" || sessionId.length === 0 || sessionId.length > 256) {
        return Promise.reject(invalidArgument("Host session id is invalid"));
      }
      sessions.add(sessionId);
      return updateSession(sessionId);
    },
    removeSession(sessionId) {
      sessions.delete(sessionId);
      catalogs.delete(sessionId);
      cancelSessionCalls(sessionId, ErrorCodes.TOOL_FAILED, "Host session was removed");
    },
    refreshAll,
    async handleServerRequest(method, params) {
      if (method === "tool/cancel") {
        if (!canRelay()) throw unavailable("remote tool relay is unavailable");
        if (!Value.Check(RacpToolCancelParamsSchema, params)) {
          throw invalidArgument("tool/cancel params do not match the RACP contract");
        }
        const cancel = params;
        if (!sessions.has(cancel.sessionId)) return { cancelled: false };
        const executionKey = `remote-mcp:${JSON.stringify([options.hostKey, cancel.sessionId, cancel.executionId])}`;
        const active = activeCalls.get(executionKey);
        if (!active || active.canceled || active.sessionId !== cancel.sessionId || active.turnId !== cancel.turnId || active.toolCallId !== cancel.toolCallId) {
          return { cancelled: false };
        }
        cancelCall(active, ErrorCodes.TOOL_FAILED, "remote Host canceled the tool call");
        return { cancelled: true };
      }
      if (method !== "tool/execute") {
        throw Object.assign(new Error("unsupported RACP server request"), { errorCode: ErrorCodes.METHOD_NOT_FOUND });
      }
      if (!canRelay()) throw unavailable("remote tool relay is unavailable");
      if (!Value.Check(RacpToolExecuteParamsSchema, params)) {
        throw invalidArgument("tool/execute params do not match the RACP contract");
      }
      const execute = params;
      if (!isBoundedRacpRelayJson(execute.args)) {
        throw invalidArgument("tool/execute arguments exceed the RACP bound");
      }
      if (!sessions.has(execute.sessionId)) throw notFound("unknown Host session");

      const advertised = catalogs.get(execute.sessionId)?.get(execute.toolName);
      if (!advertised) throw notFound("tool was not advertised for this Host session");
      const active = beginCall(execute);
      try {
        const catalogOrCancel = await Promise.race([
          currentCatalog(execute.sessionId).then((catalog) => ({ kind: "catalog" as const, catalog })),
          active.cancellation.then((outcome) => ({ kind: "canceled" as const, outcome })),
        ]);
        if (catalogOrCancel.kind === "canceled") {
          const outcome = catalogOrCancel.outcome;
          forgetCall(active);
          return errorResult(outcome.kind === "canceled" ? outcome.code : ErrorCodes.TOOL_FAILED);
        }
        const current = catalogOrCancel.catalog;
        if (active.canceled) {
          const outcome = await active.cancellation;
          forgetCall(active);
          return errorResult(outcome.kind === "canceled" ? outcome.code : ErrorCodes.TOOL_FAILED);
        }
        if (!canRelay() || !sessions.has(execute.sessionId)) throw unavailable("remote tool relay is unavailable");
        const currentTool = current.get(execute.toolName);
        if (!currentTool || safeJson(currentTool) !== safeJson(advertised)) {
          throw notFound("tool catalog changed after advertisement");
        }
        if (!validateToolArgs(currentTool, execute.args)) {
          throw invalidArgument("tool arguments do not match the advertised schema");
        }
        if (active.canceled) {
          const outcome = await active.cancellation;
          const result = errorResult(outcome.kind === "canceled" ? outcome.code : ErrorCodes.TOOL_FAILED);
          forgetCall(active);
          return result;
        }
        return runTool(execute, currentTool, active);
      } catch (error) {
        // Validation failures happen before execution and must not consume the
        // caller's execution id; a corrected request may use it again. A
        // canceled call remains tombstoned so a late duplicate cannot restart
        // work after the Host already settled it.
        if (!active.canceled) seenExecutions.delete(active.executionKey);
        forgetCall(active);
        throw error;
      }
    },
    disconnected() {
      connected = false;
      catalogs.clear();
      for (const call of activeCalls.values()) {
        cancelCall(call, ErrorCodes.HOST_DISCONNECTED, "RACP transport disconnected");
      }
    },
    async reconnected() {
      if (closed) return;
      connected = true;
      await refreshAll();
    },
    close() {
      if (closed) return;
      closed = true;
      connected = false;
      subscribeCatalog?.();
      catalogs.clear();
      for (const call of activeCalls.values()) {
        cancelCall(call, ErrorCodes.HOST_DISCONNECTED, "remote Host connection closed");
      }
      sessions.clear();
      updates.clear();
    },
  };
}
