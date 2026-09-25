import { randomUUID } from "node:crypto";

import type {
  RacpRelayTool,
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

  advertise(input: {
    connectionId: string;
    sessionId: string;
    tools: RacpRelayTool[];
    request: (method: string, params: unknown, timeoutMs: number) => Promise<unknown>;
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
    });
    this.advertisements.set(input.connectionId, sessions);
  }

  clearConnection(connectionId: string): void {
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
    this.turnCatalogs.delete(turnKey(sessionId, turnId));
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

    try {
      const response = await active.request("tool/execute", {
        executionId: input.executionId,
        sessionId: input.sessionId,
        turnId: input.turnId,
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        args: input.args,
      }, entry.tool.timeoutMs);
      if (!Value.Check(RacpToolExecuteResultSchema, response) || !isBoundedRacpRelayJson(response.result)) {
        return TOOL_FAILED;
      }
      return response.isError
        ? { ok: false, content: response.result, errorCode: "TOOL_FAILED" }
        : { ok: true, content: response.result };
    } catch {
      return TOOL_FAILED;
    }
  }
}
