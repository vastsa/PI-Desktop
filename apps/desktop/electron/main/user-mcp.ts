import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  isActiveInProject,
  type McpServerRecord,
  type McpServerStatus,
} from "@pi-desktop/shared";
import { userMcpToolName } from "@pi-desktop/plugin-sdk";
import type { McpServerClient, McpTool } from "./plugin-mcp";
import { McpCallRegistry } from "./mcp-call-registry.ts";

/**
 * MCP servers the user configured directly, with no plugin around them.
 *
 * host-core owns the records; this runtime owns the processes and sockets. A
 * server is connected the first time a session that can see it is assembled.
 * Stdio clients are cached per workspace, so another session in the same
 * project reuses the process while a different project gets its own cwd.
 * Editing or disabling a server drops all of its connections. Previously
 * discovered names survive transport loss as routing hints, never as
 * permission to call a tool absent from the new handshake.
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
  "connect" | "callTool" | "getTools" | "isConnected" | "close" | "ping"
>;

export type UserMcpClientConfig = ConstructorParameters<typeof McpServerClient>[0];

export type UserMcpOAuthHandler = {
  getValidAccessToken: (serverId: string) => Promise<string | null>;
  hasOAuth: (serverId: string) => Promise<boolean>;
};

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
  oauth?: UserMcpOAuthHandler;
  audit?: (entry: Record<string, unknown>) => void;
  log?: (level: "info" | "warn" | "error", message: string, data?: unknown) => void;
  connectTimeoutMs?: number;
  callTimeoutMs?: number;
  discoveryTimeoutMs?: number;
};

type Entry = {
  key: string;
  record: McpServerRecord;
  client: UserMcpClient;
  status: McpServerStatus;
  connecting?: Promise<McpTool[]>;
  oauthToken?: string | null;
  activeCalls: number;
  lastUsedAt: number;
};

/**
 * Servers whose processes may be alive at once.
 *
 * 16 is the width the app already uses for per-owner resource caps (watched
 * plugins, bus subscriptions, in-flight tools); a session that wants more than
 * sixteen MCP servers has a configuration problem, not a limit problem.
 */
const MAX_ACTIVE_SERVERS = 16;
const MAX_CACHED_CONNECTIONS = MAX_ACTIVE_SERVERS * 4;

export class UserMcpRuntime {
  private entries = new Map<string, Entry>();
  private statusRefreshes = new Map<string, Promise<void>>();
  private readonly calls = new McpCallRegistry();
  // Routing identity must survive a transport clearing its own tools on close.
  // These names are hints only: dispatch revalidates the fresh handshake list.
  private discoveredTools = new Map<string, Set<string>>();
  // The active record list, bucketed per workspace. host-core's "mcp.active"
  // answers for one project at a time, so a flat list would let one
  // workspace's refresh drop another active project's scoped servers.
  private recordsByScope = new Map<string, McpServerRecord[]>();
  private options: UserMcpRuntimeOptions;

  // Spelled out rather than a constructor parameter property, because the test
  // runner loads this file with Node's type-stripping loader, which rejects them.
  constructor(options: UserMcpRuntimeOptions) {
    this.options = options;
  }

  /**
   * Adopt a fresh list from host-core for one workspace. Records live in a
   * per-workspace bucket: a refresh for workspace B must not evict workspace
   * A's scoped servers, whose sessions and stdio processes are still live.
   * Global configuration is authoritative across buckets: a server that
   * disappears from any refreshed bucket has been disabled or removed
   * globally and its retained copies are dropped everywhere, while a server
   * still listed by the refreshed bucket has its newest saved config
   * reconciled into every retained copy. In either case the connection is
   * dropped so the next call re-handshakes against what the user saved.
   */
  setRecords(records: McpServerRecord[], projectPath?: string | null): void {
    const scopeKey = workspaceIdentity(projectPath);
    const fresh = records.map((record) => ({ ...record }));
    const freshIds = new Set(fresh.map((record) => record.id));
    this.recordsByScope.set(scopeKey, fresh);
    // A globally scoped server is visible to every project, so it appears in
    // every bucket's active list. If such a server is missing from a freshly
    // refreshed bucket, host-core has disabled or removed it everywhere: drop
    // every retained copy, not just this bucket's, or another project would
    // keep serving stale tools from its own snapshot.
    const removed = new Set<string>();
    for (const id of this.retainedIds()) {
      if (freshIds.has(id) || removed.has(id)) continue;
      const copy = this.findRetained(id);
      if (copy && isActiveInProject(copy, null)) removed.add(id);
    }
    if (removed.size > 0) {
      for (const [key, bucket] of [...this.recordsByScope]) {
        this.recordsByScope.set(key, bucket.filter((record) => !removed.has(record.id)));
      }
    }
    // The refreshed bucket carries the newest saved configuration for every
    // server it still lists. Reconcile the copies retained for other projects
    // so a configuration edit is authoritative across buckets immediately:
    // this is what lets the entry sweep below see the change and drop the
    // connections other projects were still holding on the old config.
    for (const record of fresh) {
      for (const [key, bucket] of [...this.recordsByScope]) {
        if (key === scopeKey) continue;
        const index = bucket.findIndex((candidate) => candidate.id === record.id);
        if (index >= 0) {
          const next = [...bucket];
          next[index] = { ...record };
          this.recordsByScope.set(key, next);
        }
      }
    }
    const all = this.allRecords();
    const byId = new Map(all.map((record) => [record.id, record]));
    for (const id of this.discoveredTools.keys()) {
      if (!byId.has(id)) this.discoveredTools.delete(id);
    }
    for (const [key, entry] of [...this.entries]) {
      const next = byId.get(entry.record.id);
      if (!next || configurationChanged(entry.record, next)) {
        entry.client.close();
        this.entries.delete(key);
        continue;
      }
      entry.record = next;
    }
  }

  /**
   * Every bucket's records, deduplicated by id. Global servers appear in each
   * bucket, so first-wins keeps them from stacking per workspace. Project
   * visibility is still decided by `isActiveInProject`, never by bucket
   * membership alone.
   */
  private allRecords(): McpServerRecord[] {
    const seen = new Map<string, McpServerRecord>();
    for (const records of this.recordsByScope.values()) {
      for (const record of records) {
        if (!seen.has(record.id)) seen.set(record.id, record);
      }
    }
    return [...seen.values()];
  }

  /** Every server id still held by any bucket. */
  private retainedIds(): Set<string> {
    const ids = new Set<string>();
    for (const records of this.recordsByScope.values()) {
      for (const record of records) ids.add(record.id);
    }
    return ids;
  }

  /** Any retained copy of a server, for global-scope detection. */
  private findRetained(id: string): McpServerRecord | undefined {
    for (const records of this.recordsByScope.values()) {
      const found = records.find((record) => record.id === id);
      if (found) return found;
    }
    return undefined;
  }

  listRecords(): McpServerRecord[] {
    return this.allRecords().map((record) => ({ ...record }));
  }

  /** Per-server connection state for the Extensions page. */
  listStatuses(): McpServerStatus[] {
    return this.allRecords().map((record) => this.statusFor(record.id));
  }

  /** Confirm ready remote connections when the settings page refreshes. */
  async refreshStatuses(): Promise<McpServerStatus[]> {
    await Promise.all([...this.entries].map(async ([key, entry]) => {
      if (entry.record.transport === "stdio" || entry.status.state !== "ready") return;
      let pending = this.statusRefreshes.get(key);
      if (!pending) {
        pending = (async () => {
          try {
            await entry.client.ping();
          } catch (error) {
            if (this.entries.get(key) !== entry) return;
            // A settings probe must not abort a tool call already in flight.
            // Test connection will close this client before retrying.
            const message = error instanceof Error ? error.message : "mcp server did not respond";
            entry.status = {
              ...entry.status,
              state: "failed",
              toolCount: 0,
              message: message.slice(0, 500),
              updatedAt: Date.now(),
            };
          }
        })();
        this.statusRefreshes.set(key, pending);
      }
      try {
        await pending;
      } finally {
        if (this.statusRefreshes.get(key) === pending) this.statusRefreshes.delete(key);
      }
    }));
    return this.listStatuses();
  }

  statusFor(serverId: string): McpServerStatus {
    const entry = [...this.entries.values()]
      .filter((candidate) => candidate.record.id === serverId)
      .sort((left, right) => right.status.updatedAt - left.status.updatedAt)[0];
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
    const active = this.allRecords().filter((record) => isActiveInProject(record, projectPath));
    const admitted = active.slice(0, MAX_ACTIVE_SERVERS);
    if (admitted.length < active.length) {
      this.options.log?.("warn", "user mcp servers skipped over the active cap", {
        limit: MAX_ACTIVE_SERVERS,
        skipped: active.length - admitted.length,
      });
    }
    const lists = await Promise.all(admitted.map(async (record) => {
      const result = await this.connect(record, projectPath);
      return result.tools;
    }));
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

  /** Whether a saved server advertised this name (not a readiness check). */
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
    sessionId?: string,
  ): Promise<unknown> {
    return this.calls.run(sessionId, (signal) => this.callToolActive(fullName, args, projectPath, signal));
  }

  private async callToolActive(
    fullName: string,
    args: unknown,
    projectPath: string | null | undefined,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const found = this.findTool(fullName);
    if (!found) {
      throw Object.assign(new Error(`unknown mcp tool: ${fullName}`), {
        errorCode: "TOOL_NOT_FOUND",
      });
    }
    const record = this.allRecords().find((entry) => entry.id === found.serverId);
    if (!record || !isActiveInProject(record, projectPath)) {
      throw Object.assign(
        new Error(`mcp server ${found.serverId} is not active for this session`),
        { errorCode: "TOOL_NOT_FOUND" },
      );
    }
    const { entry } = await this.connect(record, projectPath, true);
    if (!entry) {
      throw Object.assign(new Error(`mcp server ${found.serverId} is unavailable`), {
        errorCode: "UNAVAILABLE",
      });
    }
    try {
      // Configuration or scope can change while the handshake is in flight.
      const current = this.allRecords().find((entry) => entry.id === found.serverId);
      if (!current || !isActiveInProject(current, projectPath)) {
        throw Object.assign(
          new Error(`mcp server ${found.serverId} is not active for this session`),
          { errorCode: "TOOL_NOT_FOUND" },
        );
      }
      if (
        configurationChanged(record, current) ||
        entry.status.state !== "ready" || !entry.client.isConnected()
      ) {
        throw Object.assign(new Error(`mcp server ${found.serverId} is unavailable`), {
          errorCode: "UNAVAILABLE",
        });
      }
      if (!entry.client.getTools().some((tool) => tool.name === found.toolName)) {
        throw Object.assign(new Error(`unknown mcp tool: ${fullName}`), {
          errorCode: "TOOL_NOT_FOUND",
        });
      }
      // Do not retry tools/call: a failed response may have followed a mutation.
      try {
        return await entry.client.callTool(found.toolName, args, signal);
      } catch (error) {
        const msg = (error as Error).message || "";
        if (msg.includes("401") || (error as { status?: number }).status === 401) {
          entry.status = {
            ...entry.status,
            state: "failed",
            authRequired: true,
            message: msg.slice(0, 500),
            updatedAt: Date.now(),
          };
        }
        throw error;
      }
    } finally {
      entry.activeCalls -= 1;
    }
  }

  /**
   * Handshake once and report what happened, for the editor's "Test connection"
   * button. The connection is kept: a user who just tested a server is about to
   * use it.
   */
  async test(
    serverId: string,
    projectPath: string | null | undefined = null,
  ): Promise<McpServerStatus> {
    const record = this.allRecords().find((entry) => entry.id === serverId);
    if (!record) {
      return {
        serverId,
        state: "failed",
        toolCount: 0,
        message: "server not found",
        updatedAt: Date.now(),
      };
    }
    // Retry the requested workspace and clear this server's other failed
    // workspace caches. A successful home test must not leave project sessions
    // stuck on an earlier failure. Never interrupt a handshake or tool call.
    const targetKey = connectionKey(record, projectPath);
    for (const [key, entry] of [...this.entries]) {
      if (
        entry.record.id !== serverId || entry.connecting || entry.activeCalls > 0 ||
        (key !== targetKey && entry.status.state !== "failed")
      ) continue;
      entry.client.close();
      this.entries.delete(key);
    }
    const { entry } = await this.connect(record, projectPath);
    return entry ? { ...entry.status } : {
      serverId,
      state: "failed",
      toolCount: 0,
      message: "connection cache is full; try again after active calls finish",
      updatedAt: Date.now(),
    };
  }

  /** Drop a cached connection and tools for a server. */
  invalidate(serverId: string): void {
    for (const [key, entry] of [...this.entries]) {
      if (entry.record.id === serverId) {
        entry.client.close();
        this.entries.delete(key);
      }
    }
    this.discoveredTools.delete(serverId);
  }

  /** Drop every connection, e.g. on quit. */
  disposeAll(): void {
    this.calls.cancelAll();
    for (const entry of this.entries.values()) entry.client.close();
    this.entries.clear();
    this.statusRefreshes.clear();
    this.discoveredTools.clear();
  }

  cancelSessionCalls(sessionId: string): void {
    this.calls.cancelSession(sessionId);
  }

  private findTool(fullName: string): { serverId: string; toolName: string } | undefined {
    for (const [serverId, tools] of this.discoveredTools) {
      for (const toolName of tools) {
        if (userMcpToolName(serverId, toolName) === fullName) {
          return { serverId, toolName };
        }
      }
    }
    return undefined;
  }

  private async connect(
    record: McpServerRecord,
    projectPath: string | null | undefined = null,
    pin = false,
  ): Promise<{ tools: McpTool[]; entry?: Entry }> {
    let oauthToken: string | null = null;
    if (record.transport === "http" && this.options.oauth) {
      try {
        oauthToken = await this.options.oauth.getValidAccessToken(record.id);
      } catch {
        oauthToken = null;
      }
    }

    const key = connectionKey(record, projectPath);
    let existing = this.entries.get(key);
    // Token refresh can run while Test connection or another session arrives.
    // Let existing calls/handshakes finish; rotate the transport when idle.
    if (
      existing && record.transport === "http" && existing.oauthToken !== oauthToken &&
      !existing.connecting && existing.activeCalls === 0
    ) {
      existing.client.close();
      this.entries.delete(key);
      existing = undefined;
    }

    if (!existing && !this.makeRoom()) {
      this.options.log?.("warn", "user mcp connection cache is full", {
        serverId: record.id,
        limit: MAX_CACHED_CONNECTIONS,
      });
      return { tools: [] };
    }

    if (existing?.connecting) {
      if (pin) existing.activeCalls += 1;
      existing.lastUsedAt = Date.now();
      return { tools: await existing.connecting, entry: existing };
    }
    if (existing?.client.isConnected()) {
      if (pin) existing.activeCalls += 1;
      existing.lastUsedAt = Date.now();
      return { tools: existing.client.getTools(), entry: existing };
    }
    // A server that already failed its handshake this run stays failed until the
    // user edits it or asks for a test, so every session assembly does not pay
    // the connect timeout again.
    if (existing?.status.state === "failed") {
      if (pin) existing.activeCalls += 1;
      existing.lastUsedAt = Date.now();
      return { tools: [], entry: existing };
    }

    const entry = existing ?? this.createEntry(record, oauthToken, key, projectPath);
    if (pin) entry.activeCalls += 1;
    entry.lastUsedAt = Date.now();
    entry.connecting = this.handshake(record, entry).finally(() => {
      entry.connecting = undefined;
    });
    return { tools: await entry.connecting, entry };
  }

  private async handshake(record: McpServerRecord, entry: Entry): Promise<McpTool[]> {
    entry.status = {
      ...entry.status,
      state: "connecting",
      updatedAt: Date.now(),
    };
    try {
      const tools = await entry.client.connect();
      // An edited/deleted record must not resurrect a discarded connection.
      if (this.entries.get(entry.key) !== entry) {
        entry.client.close();
        return [];
      }
      const catalog = this.discoveredTools.get(record.id) ?? new Set<string>();
      for (const tool of tools) catalog.add(tool.name);
      this.discoveredTools.set(record.id, catalog);
      entry.status = {
        serverId: record.id,
        state: "ready",
        toolCount: tools.length,
        toolNames: tools.map((tool) => tool.name),
        updatedAt: Date.now(),
        authRequired: false,
      };
      return tools;
    } catch (error) {
      const msg = (error as Error).message || "";
      const is401 = msg.includes("401");
      entry.status = {
        serverId: record.id,
        state: "failed",
        toolCount: 0,
        message: msg.slice(0, 500),
        updatedAt: Date.now(),
        authRequired: is401,
      };
      this.options.log?.("warn", "user mcp server failed to connect", {
        serverId: record.id,
        message: entry.status.message,
      });
      return [];
    }
  }

  private createEntry(
    record: McpServerRecord,
    oauthToken: string | null | undefined,
    key: string,
    projectPath: string | null | undefined,
  ): Entry {
    const headers = {
      ...(record.headers ?? {}),
      ...(oauthToken ? { Authorization: `Bearer ${oauthToken}` } : {}),
    };
    const customTimeoutMs =
      typeof record.timeoutSeconds === "number" && record.timeoutSeconds > 0
        ? record.timeoutSeconds * 1000
        : undefined;
    const client = this.options.createClient({
      // Stdio servers inherit the session workspace as their cwd. HTTP
      // transports do not spawn a child and keep the existing home default.
      rootPath: record.transport === "stdio" ? workspacePath(projectPath) : homedir(),
      commandPolicy: "trusted",
      server: {
        id: record.id,
        label: record.label,
        transport: record.transport,
        command: record.command,
        args: record.args ?? [],
        env: record.env ?? {},
        url: record.url,
        headers,
      },
      values: record.transport === "stdio" ? (record.env ?? {}) : headers,
      audit: this.options.audit,
      auditScope: "mcp",
      connectTimeoutMs: customTimeoutMs ?? this.options.connectTimeoutMs,
      callTimeoutMs: customTimeoutMs ? Math.max(customTimeoutMs, this.options.callTimeoutMs ?? 0) : this.options.callTimeoutMs,
      discoveryTimeoutMs: customTimeoutMs ? Math.max(customTimeoutMs, this.options.discoveryTimeoutMs ?? 0) : this.options.discoveryTimeoutMs,
    });
    const entry: Entry = {
      key,
      record,
      client,
      oauthToken,
      activeCalls: 0,
      lastUsedAt: Date.now(),
      status: {
        serverId: record.id,
        state: "idle",
        toolCount: 0,
        updatedAt: Date.now(),
      },
    };
    this.entries.set(key, entry);
    return entry;
  }

  private makeRoom(): boolean {
    if (this.entries.size < MAX_CACHED_CONNECTIONS) return true;
    const candidate = [...this.entries.values()]
      .filter((entry) =>
        !entry.connecting &&
        entry.activeCalls === 0 &&
        !this.statusRefreshes.has(entry.key)
      )
      .sort((left, right) => left.lastUsedAt - right.lastUsedAt)[0];
    if (!candidate) return false;
    candidate.client.close();
    this.entries.delete(candidate.key);
    return true;
  }
}

function workspacePath(projectPath: string | null | undefined): string {
  return projectPath ? resolve(projectPath) : homedir();
}

/**
 * The normalized workspace a bucket of records belongs to. Empty string for
 * the home/global bucket. Same normalization stdio connection keys use.
 */
function workspaceIdentity(projectPath: string | null | undefined): string {
  const rootPath = projectPath ? resolve(projectPath) : "";
  return process.platform === "win32" ? rootPath.toLowerCase() : rootPath;
}

function connectionKey(record: McpServerRecord, projectPath: string | null | undefined): string {
  if (record.transport !== "stdio") return JSON.stringify([record.id, "http"]);
  const identity = workspaceIdentity(projectPath) || homedir();
  return JSON.stringify([record.id, identity]);
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
    JSON.stringify(before.headers ?? {}) !== JSON.stringify(after.headers ?? {}) ||
    before.timeoutSeconds !== after.timeoutSeconds
  );
}
