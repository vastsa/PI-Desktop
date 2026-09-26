import { randomUUID } from "node:crypto";

import type {
  RacpRelayTool,
  RacpToolCancelParams,
  RacpToolExecuteParams,
} from "@pi-desktop/shared";
import {
  isBoundedRacpRelayJson,
  isValidRacpToolsAdvertiseParams,
  RACP_TOOL_RELAY_LIMITS,
  RacpToolExecuteParamsSchema,
  RacpToolExecuteResultSchema,
} from "@pi-desktop/shared";
import * as Value from "typebox/value";
import { RacpError } from "@pi-desktop/agent-host";
import type {
  ToolRelayCatalogSnapshot,
  ToolRelayExecutionResult,
  ToolRelayPort,
} from "@pi-desktop/agent-host";

type Registration = {
  connectionId: string;
  sessionId: string;
  tools: Map<string, RacpRelayTool>;
  request: (method: string, params: unknown, timeoutMs: number) => Promise<unknown>;
  cancel?: (params: RacpToolCancelParams) => Promise<unknown>;
};

type CatalogEntry = {
  connectionId: string;
  registration: Registration;
  tool: RacpRelayTool;
};

type CatalogSnapshot = {
  id: string;
  sessionId: string;
  entries: Map<string, CatalogEntry>;
};

type ActiveExecution = {
  key: string;
  input: RacpToolExecuteParams;
  registration: Registration;
  settled: boolean;
  resolveCancellation: (result: ToolRelayExecutionResult) => void;
};

const TOOL_FAILED: ToolRelayExecutionResult = {
  ok: false,
  content: { error: "The advertised tool is unavailable or failed.", code: "TOOL_FAILED" },
  errorCode: "TOOL_FAILED",
};

function turnKey(sessionId: string, turnId: string): string {
  return JSON.stringify([sessionId, turnId]);
}

function cloneTool(tool: RacpRelayTool): RacpRelayTool {
  return JSON.parse(JSON.stringify(tool)) as RacpRelayTool;
}

/**
 * Owns the ephemeral tool catalog and dispatches each tool call to the exact
 * owner connection whose advertisement was included in that turn's catalog.
 */
export class RemoteToolRelay implements ToolRelayPort {
  private readonly advertisements = new Map<string, Map<string, Registration>>();
  private readonly pendingCatalogs = new Map<string, CatalogSnapshot>();
  private readonly turnCatalogs = new Map<string, CatalogSnapshot>();
  private readonly activeExecutions = new Map<string, ActiveExecution>();

  advertise(input: {
    connectionId: string;
    sessionId: string;
    tools: RacpRelayTool[];
    request: (method: string, params: unknown, timeoutMs: number) => Promise<unknown>;
    cancel?: (params: RacpToolCancelParams) => Promise<unknown>;
  }): void {
    if (!input.connectionId || !input.sessionId || typeof input.request !== "function") {
      throw new Error("invalid tool relay registration");
    }
    if (!isValidRacpToolsAdvertiseParams({ sessionId: input.sessionId, tools: input.tools })) {
      throw new Error("invalid tool relay catalog");
    }

    const sessions = this.advertisements.get(input.connectionId) ?? new Map<string, Registration>();
    const tools = new Map(input.tools.map((tool) => [tool.name, cloneTool(tool)]));
    let catalogToolCount = tools.size;
    let catalogBytes = new TextEncoder().encode(JSON.stringify([...tools.values()])).byteLength;
    for (const [connectionId, currentSessions] of this.advertisements) {
      if (connectionId === input.connectionId) continue;
      const current = currentSessions.get(input.sessionId);
      if (!current) continue;
      catalogToolCount += current.tools.size;
      catalogBytes += new TextEncoder().encode(JSON.stringify([...current.tools.values()])).byteLength;
    }
    if (catalogToolCount > RACP_TOOL_RELAY_LIMITS.maxToolsPerSession || catalogBytes > RACP_TOOL_RELAY_LIMITS.maxCatalogBytes) {
      throw new RacpError("PAYLOAD_TOO_LARGE", "session tool catalog exceeds relay limits");
    }
    sessions.set(input.sessionId, {
      connectionId: input.connectionId,
      sessionId: input.sessionId,
      tools,
      request: input.request,
      ...(input.cancel ? { cancel: input.cancel } : {}),
    });
    this.advertisements.set(input.connectionId, sessions);
  }

  clearConnection(connectionId: string): void {
    for (const active of this.activeExecutions.values()) {
      if (active.registration.connectionId === connectionId) {
        this.cancelExecution(active, "HOST_DISCONNECTED", false);
      }
    }
    this.advertisements.delete(connectionId);
  }

  captureCatalog(sessionId: string): ToolRelayCatalogSnapshot {
    const candidates = new Map<string, CatalogEntry | null>();
    for (const [connectionId, sessions] of this.advertisements) {
      const registration = sessions.get(sessionId);
      if (!registration) continue;
      for (const [name, tool] of registration.tools) {
        if (candidates.has(name)) {
          candidates.set(name, null);
          continue;
        }
        candidates.set(name, { connectionId, registration, tool });
      }
    }

    const entries = new Map<string, CatalogEntry>();
    const tools: RacpRelayTool[] = [];
    for (const [name, entry] of candidates) {
      if (!entry) continue;
      entries.set(name, entry);
      tools.push(cloneTool(entry.tool));
    }
    const id = randomUUID();
    this.pendingCatalogs.set(id, { id, sessionId, entries });
    return { id, tools };
  }

  bindTurn(catalogId: string, sessionId: string, turnId: string): void {
    const catalog = this.pendingCatalogs.get(catalogId);
    if (!catalog || catalog.sessionId !== sessionId || !turnId) {
      throw new Error("tool relay catalog does not match the turn");
    }
    this.pendingCatalogs.delete(catalogId);
    this.turnCatalogs.set(turnKey(sessionId, turnId), catalog);
  }

  releaseCatalog(catalogId: string): void {
    this.pendingCatalogs.delete(catalogId);
  }

  releaseTurn(sessionId: string, turnId: string): void {
    for (const active of this.activeExecutions.values()) {
      if (active.input.sessionId === sessionId && active.input.turnId === turnId) {
        this.cancelExecution(active, "TOOL_FAILED", true);
      }
    }
    this.turnCatalogs.delete(turnKey(sessionId, turnId));
  }

  private cancelExecution(
    active: ActiveExecution,
    _code: string,
    notifyClient: boolean,
  ): boolean {
    if (this.activeExecutions.get(active.key) !== active || active.settled) return false;
    active.settled = true;
    if (notifyClient && active.registration.cancel) {
      const params: RacpToolCancelParams = {
        executionId: active.input.executionId,
        sessionId: active.input.sessionId,
        turnId: active.input.turnId,
        toolCallId: active.input.toolCallId,
      };
      void active.registration.cancel(params).catch(() => undefined);
    }
    active.resolveCancellation(TOOL_FAILED);
    return true;
  }

  async execute(input: RacpToolExecuteParams): Promise<ToolRelayExecutionResult> {
    if (!Value.Check(RacpToolExecuteParamsSchema, input) || !isBoundedRacpRelayJson(input.args)) {
      return TOOL_FAILED;
    }
    const catalog = this.turnCatalogs.get(turnKey(input.sessionId, input.turnId));
    const entry = catalog?.entries.get(input.toolName);
    if (!entry) return TOOL_FAILED;

    // A changed or disconnected advertisement invalidates this turn's entry.
    // Never look up the same name on a different connection.
    const active = this.advertisements.get(entry.connectionId)?.get(input.sessionId);
    if (active !== entry.registration || active.tools.get(input.toolName) !== entry.tool) return TOOL_FAILED;

    let resolveCancellation!: (result: ToolRelayExecutionResult) => void;
    const cancellation = new Promise<ToolRelayExecutionResult>((resolve) => {
      resolveCancellation = resolve;
    });
    const executionKey = `${turnKey(input.sessionId, input.turnId)}\u0000${input.executionId}`;
    const activeExecution: ActiveExecution = {
      key: executionKey,
      input,
      registration: entry.registration,
      settled: false,
      resolveCancellation,
    };
    if (this.activeExecutions.has(executionKey)) return TOOL_FAILED;
    this.activeExecutions.set(executionKey, activeExecution);
    const timeout = setTimeout(() => {
      this.cancelExecution(activeExecution, "TIMEOUT", true);
    }, entry.tool.timeoutMs);
    timeout.unref?.();

    try {
      const response = await Promise.race([
        active.request("tool/execute", {
          executionId: input.executionId,
          sessionId: input.sessionId,
          turnId: input.turnId,
          toolCallId: input.toolCallId,
          toolName: input.toolName,
          args: input.args,
        }, entry.tool.timeoutMs).then((value) => ({ kind: "response" as const, value })),
        cancellation.then((value) => ({ kind: "canceled" as const, value })),
      ]);
      if (response.kind === "canceled") return response.value;
      const result = response.value;
      if (!Value.Check(RacpToolExecuteResultSchema, result) || !isBoundedRacpRelayJson(result.result)) {
        return TOOL_FAILED;
      }
      return result.isError
        ? { ok: false, content: result.result, errorCode: "TOOL_FAILED" }
        : { ok: true, content: result.result };
    } catch {
      return TOOL_FAILED;
    } finally {
      clearTimeout(timeout);
      if (this.activeExecutions.get(executionKey) === activeExecution) {
        this.activeExecutions.delete(executionKey);
      }
    }
  }
}
