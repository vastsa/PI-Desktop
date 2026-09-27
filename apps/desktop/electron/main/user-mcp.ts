import { homedir } from "node:os";
import {
  isActiveInProject,
  type McpServerRecord,
  type McpServerStatus,
} from "@pi-desktop/shared";
import { userMcpToolName } from "@pi-desktop/plugin-sdk";
import type { McpServerClient, McpTool } from "./plugin-mcp";

/**
 * MCP servers the user configured directly, with no plugin around them.
 *
 * host-core owns the records; this runtime owns the processes and sockets. A
 * server is connected the first time a session that can see it is assembled,
 * and its tool list is cached afterwards, so opening a second session on the
 * same project costs nothing. Editing or disabling a server drops its
 * connection, because a stale tool list is worse than a missing one.
 */
export type UserMcpToolDescriptor = {
  /** `mcp_<serverId>_<tool>`, the name the model calls. */
  fullName: string;
  serverId: string;
  toolName: string;
  description: string;
  schema?: unknown;
};

/** The slice of {@link McpServerClient} this runtime drives. */
export type UserMcpClient = Pick<
  McpServerClient,
  "connect" | "callTool" | "getTools" | "isConnected" | "close"
>;

export type UserMcpClientConfig = ConstructorParameters<typeof McpServerClient>[0];

export type UserMcpRuntimeOptions = {
  /**
   * How a connection is made.
   *
   * Injected rather than imported because every value import would make this
   * module unloadable by the test runner, which reads it with Node's
   * type-stripping loader and cannot resolve extensionless specifiers. Keeping
   * the import type-only is what lets the runtime be tested against real
   * servers.
   */
  createClient: (config: UserMcpClientConfig) => UserMcpClient;
  audit?: (entry: Record<string, unknown>) => void;
  log?: (level: "info" | "warn" | "error", message: string, data?: unknown) => void;
  connectTimeoutMs?: number;
  callTimeoutMs?: number;
};

type Entry = {
  record: McpServerRecord;
  client: UserMcpClient;
  status: McpServerStatus;
};

/**
 * Servers whose processes may be alive at once.
 *
 * 16 is the width the app already uses for per-owner resource caps (watched
 * plugins, bus subscriptions, in-flight tools); a session that wants more than
 * sixteen MCP servers has a configuration problem, not a limit problem.
 */
const MAX_ACTIVE_SERVERS = 16;

export class UserMcpRuntime {
  private entries = new Map<string, Entry>();
  private records: McpServerRecord[] = [];
  private options: UserMcpRuntimeOptions;

  // Spelled out rather than a constructor parameter property, because the test
  // runner loads this file with Node's type-stripping loader, which rejects them.
  constructor(options: UserMcpRuntimeOptions) {
    this.options = options;
  }

  /**
   * Adopt a fresh list from host-core. Servers whose configuration changed —
   * or that vanished — lose their connection so the next call re-handshakes
   * against what the user actually saved.
   */
  setRecords(records: McpServerRecord[]): void {
    this.records = records.map((record) => ({ ...record }));
    const byId = new Map(this.records.map((record) => [record.id, record]));
    for (const [id, entry] of [...this.entries]) {
      const next = byId.get(id);
      if (!next || configurationChanged(entry.record, next)) {
        entry.client.close();
        this.entries.delete(id);
        continue;
      }
      entry.record = next;
    }
  }

  listRecords(): McpServerRecord[] {
    return this.records.map((record) => ({ ...record }));
  }

  /** Per-server connection state for the Extensions page. */
  listStatuses(): McpServerStatus[] {
    return this.records.map((record) => this.statusFor(record.id));
  }

  statusFor(serverId: string): McpServerStatus {
    const entry = this.entries.get(serverId);
    if (entry) return { ...entry.status };
    return {
      serverId,
      state: "idle",
      toolCount: 0,
      updatedAt: Date.now(),
    };
  }

  /**
   * Connect every server active in `projectPath` and return their tools.
   *
   * Called while assembling a session, so a slow or broken server must not block
   * the turn: each handshake has its own timeout and a failure is recorded as
   * status rather than thrown.
   */
  async toolsForProject(projectPath: string | null | undefined): Promise<UserMcpToolDescriptor[]> {
    const active = this.records.filter((record) => isActiveInProject(record, projectPath));
    const admitted = active.slice(0, MAX_ACTIVE_SERVERS);
    if (admitted.length < active.length) {
      this.options.log?.("warn", "user mcp servers skipped over the active cap", {
        limit: MAX_ACTIVE_SERVERS,
        skipped: active.length - admitted.length,
      });
    }
    const lists = await Promise.all(admitted.map((record) => this.connect(record)));
    const out: UserMcpToolDescriptor[] = [];
    admitted.forEach((record, index) => {
      for (const tool of lists[index]) {
        out.push({
          fullName: userMcpToolName(record.id, tool.name),
          serverId: record.id,
          toolName: tool.name,
          description: tool.description ?? `${record.label} tool "${tool.name}" (MCP)`,
          schema: tool.inputSchema,
        });
      }
    });
    return out;
  }

  /** Whether a tool name belongs to this runtime at all. */
  hasTool(fullName: string): boolean {
    return this.findTool(fullName) !== undefined;
  }

  /**
   * Run a tool. The name carries the server id, but the lookup goes through the
   * cached tool list so a name the server never advertised is refused instead of
   * forwarded — and a server the user has since scoped away cannot be reached
   * from a session that still remembers the tool.
   */
  async callTool(
    fullName: string,
    args: unknown,
    projectPath: string | null | undefined,
  ): Promise<unknown> {
    const found = this.findTool(fullName);
    if (!found) {
      throw Object.assign(new Error(`unknown mcp tool: ${fullName}`), {
        errorCode: "TOOL_NOT_FOUND",
      });
    }
    const record = this.records.find((entry) => entry.id === found.serverId);
    if (!record || !isActiveInProject(record, projectPath)) {
      throw Object.assign(
        new Error(`mcp server ${found.serverId} is not active for this session`),
        { errorCode: "TOOL_NOT_FOUND" },
      );
    }
    const entry = this.entries.get(found.serverId);
    if (!entry) {
      await this.connect(record);
    }
    const client = this.entries.get(found.serverId)?.client;
    if (!client) {
      throw Object.assign(new Error(`mcp server ${found.serverId} is unavailable`), {
        errorCode: "UNAVAILABLE",
      });
    }
    return client.callTool(found.toolName, args);
  }

  /**
   * Handshake once and report what happened, for the editor's "Test connection"
   * button. The connection is kept: a user who just tested a server is about to
   * use it.
   */
  async test(serverId: string): Promise<McpServerStatus> {
    const record = this.records.find((entry) => entry.id === serverId);
    if (!record) {
      return {
        serverId,
        state: "failed",
        toolCount: 0,
        message: "server not found",
        updatedAt: Date.now(),
      };
    }
    // Force a fresh handshake so a fixed command is retried rather than
    // reporting the cached failure.
    this.entries.get(serverId)?.client.close();
    this.entries.delete(serverId);
    await this.connect(record);
    return this.statusFor(serverId);
  }

  /** Drop every connection, e.g. on quit. */
  disposeAll(): void {
    for (const entry of this.entries.values()) entry.client.close();
    this.entries.clear();
  }

  private findTool(fullName: string): UserMcpToolDescriptor | undefined {
    for (const [serverId, entry] of this.entries) {
      for (const tool of entry.client.getTools()) {
        if (userMcpToolName(serverId, tool.name) === fullName) {
          return {
            fullName,
            serverId,
            toolName: tool.name,
            description: tool.description ?? tool.name,
            schema: tool.inputSchema,
          };
        }
      }
    }
    return undefined;
  }

  private async connect(record: McpServerRecord): Promise<McpTool[]> {
    const existing = this.entries.get(record.id);
    if (existing?.client.isConnected()) return existing.client.getTools();
    // A server that already failed its handshake this run stays failed until the
    // user edits it or asks for a test, so every session assembly does not pay
    // the connect timeout again.
    if (existing?.status.state === "failed") return [];
    const entry = existing ?? this.createEntry(record);
    entry.status = {
      ...entry.status,
      state: "connecting",
      updatedAt: Date.now(),
    };
    try {
      const tools = await entry.client.connect();
      entry.status = {
        serverId: record.id,
        state: "ready",
        toolCount: tools.length,
        toolNames: tools.map((tool) => tool.name),
        updatedAt: Date.now(),
      };
      return tools;
    } catch (error) {
      entry.status = {
        serverId: record.id,
        state: "failed",
        toolCount: 0,
        message: (error as Error).message.slice(0, 500),
        updatedAt: Date.now(),
      };
      this.options.log?.("warn", "user mcp server failed to connect", {
        serverId: record.id,
        message: entry.status.message,
      });
      return [];
    }
  }

  private createEntry(record: McpServerRecord): Entry {
    const client = this.options.createClient({
      // No plugin owns this server; `rootPath` is only the child's cwd, and the
      // user's own command may live anywhere on the machine.
      rootPath: homedir(),
      commandPolicy: "trusted",
      server: {
        id: record.id,
        label: record.label,
        transport: record.transport,
        command: record.command,
        args: record.args ?? [],
        env: record.env ?? {},
        url: record.url,
        headers: record.headers ?? {},
      },
      values: record.transport === "stdio" ? (record.env ?? {}) : (record.headers ?? {}),
      audit: this.options.audit,
      auditScope: "mcp",
      connectTimeoutMs: this.options.connectTimeoutMs,
      callTimeoutMs: this.options.callTimeoutMs,
    });
    const entry: Entry = {
      record,
      client,
      status: {
        serverId: record.id,
        state: "idle",
        toolCount: 0,
        updatedAt: Date.now(),
      },
    };
    this.entries.set(record.id, entry);
    return entry;
  }
}

/**
 * Whether a saved edit invalidates a live connection. Scope, label and
 * description do not: they change who may call the server, not what it is.
 */
export function configurationChanged(before: McpServerRecord, after: McpServerRecord): boolean {
  if (before.enabled !== after.enabled && !after.enabled) return true;
  return (
    before.transport !== after.transport ||
    before.command !== after.command ||
    JSON.stringify(before.args ?? []) !== JSON.stringify(after.args ?? []) ||
    JSON.stringify(before.env ?? {}) !== JSON.stringify(after.env ?? {}) ||
    before.url !== after.url ||
    JSON.stringify(before.headers ?? {}) !== JSON.stringify(after.headers ?? {})
  );
}
