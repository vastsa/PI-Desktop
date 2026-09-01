import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { isAbsolute, resolve, sep } from "node:path";
import type { PluginMcpServerContrib } from "@pi-desktop/plugin-sdk";

/** MCP revision we advertise during the handshake. */
export const MCP_PROTOCOL_VERSION = "2025-06-18";
/** Discovery must finish inside this budget or the server is skipped. */
export const MCP_CONNECT_TIMEOUT_MS = 10_000;
/** Kept under the plugin tool budget so the MCP error wins the race. */
export const MCP_CALL_TIMEOUT_MS = 100_000;
/** A chatty server must not flood the model's tool list. */
export const MAX_MCP_TOOLS_PER_SERVER = 64;
/** Keep an MCP endpoint from bouncing requests through an unbounded chain. */
const MAX_MCP_REDIRECTS = 5;
/** `tools/list` pages to follow before giving up on a cursor loop. */
const MAX_TOOL_PAGES = 8;
/** Guard against a server streaming an unbounded line at us. */
const MAX_STDIO_LINE_BYTES = 4 * 1024 * 1024;

export type McpTool = {
  name: string;
  description?: string;
  inputSchema?: unknown;
};

export type JsonRpcMessage = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
};

/**
 * Both transports are reduced to "send a message, receive messages", which lets
 * the client speak the same JSON-RPC dialect over a pipe or over HTTP.
 */
export type McpTransport = {
  send: (message: JsonRpcMessage) => Promise<void>;
  close: () => void;
};

export type McpTransportHandlers = {
  onMessage: (message: JsonRpcMessage) => void;
  onClose: (reason: string) => void;
};

type McpError = Error & { code?: string };

function mcpError(code: string, message: string): McpError {
  const error = new Error(message) as McpError;
  error.code = code;
  return error;
}

/**
 * Environment for a stdio MCP server: the host's own env carries provider keys
 * and shell secrets, so only the values the caller declared cross over (D018).
 * `pluginId` is absent for a server the user configured directly, which has no
 * plugin identity to announce.
 */
export function mcpProcessEnv(
  pluginId: string | undefined,
  values: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {
    ...(pluginId ? { PI_PLUGIN_ID: pluginId } : {}),
    NODE_ENV: process.env.NODE_ENV ?? "production",
  };
  for (const key of ["PATH", "SystemRoot", "windir", "TEMP", "TMP", "TMPDIR", "LANG"]) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return { ...env, ...values };
}

/**
 * How much freedom a stdio command string has.
 *
 * `confined` is for plugin-declared servers: anything with a path separator must
 * resolve inside the plugin directory. `trusted` is for servers the user typed
 * into the MCP editor — they may name any binary on the machine, exactly as they
 * could in a terminal — but relative traversal is still refused so a stored
 * command means the same thing wherever it runs from.
 */
export type McpCommandPolicy = "confined" | "trusted";

/** Resolve the executable for a stdio server under the given policy. */
export function resolveMcpCommand(
  rootPath: string,
  command: string,
  policy: McpCommandPolicy = "confined",
): string {
  if (!/[\\/]/.test(command)) return command;
  if (policy === "trusted") {
    if (command.split(/[\\/]/).some((part) => part === "..")) {
      throw mcpError("INVALID_ARGUMENT", `mcp command must not contain "..": ${command}`);
    }
    if (!isAbsolute(command)) {
      throw mcpError("INVALID_ARGUMENT", `mcp command must be a name or an absolute path: ${command}`);
    }
    return command;
  }
  const root = resolve(rootPath);
  const target = resolve(root, command);
  const prefix = root.endsWith(sep) ? root : root + sep;
  if (target === root || !target.startsWith(prefix)) {
    throw mcpError("INVALID_ARGUMENT", `mcp command escapes the plugin directory: ${command}`);
  }
  return target;
}

function createStdioTransport(
  options: {
    rootPath: string;
    commandPolicy: McpCommandPolicy;
    command: string;
    args: string[];
    env: Record<string, string>;
    spawnImpl?: typeof nodeSpawn;
  },
  handlers: McpTransportHandlers,
): McpTransport {
  const spawnImpl = options.spawnImpl ?? nodeSpawn;
  const child: ChildProcess = spawnImpl(
    resolveMcpCommand(options.rootPath, options.command, options.commandPolicy),
    options.args,
    {
      cwd: options.rootPath,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      // Never route through a shell: arguments stay literal.
      shell: false,
    },
  );

  let closed = false;
  let buffer = "";
  let lastStderr = "";

  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    buffer += chunk;
    if (buffer.length > MAX_STDIO_LINE_BYTES) {
      buffer = "";
      handlers.onClose("mcp server sent an oversized message");
      child.kill();
      return;
    }
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) {
        try {
          handlers.onMessage(JSON.parse(line) as JsonRpcMessage);
        } catch {
          // Servers that log to stdout violate the transport, but a stray line
          // must not tear down a working session.
        }
      }
      index = buffer.indexOf("\n");
    }
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    lastStderr = String(chunk).trimEnd().slice(-500);
  });
  child.on("error", (error: Error) => {
    closed = true;
    handlers.onClose(error.message);
  });
  child.on("exit", (code) => {
    closed = true;
    handlers.onClose(
      `mcp server exited with code ${code ?? 0}${lastStderr ? `: ${lastStderr}` : ""}`,
    );
  });

  return {
    send: async (message) => {
      if (closed || !child.stdin?.writable) {
        throw mcpError("UNAVAILABLE", "mcp server is not running");
      }
      child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    close: () => {
      closed = true;
      child.kill();
    },
  };
}

function parseSseMessages(body: string): JsonRpcMessage[] {
  const out: JsonRpcMessage[] = [];
  for (const block of body.split(/\n\n/)) {
    const data = block
      .split(/\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("");
    if (!data) continue;
    try {
      out.push(JSON.parse(data) as JsonRpcMessage);
    } catch {
      // A partial event is not actionable; the request times out instead.
    }
  }
  return out;
}

function createHttpTransport(
  options: {
    url: string;
    headers: Record<string, string>;
    timeoutMs: number;
    fetchImpl?: typeof fetch;
    assertUrlAllowed?: (url: string) => void;
  },
  handlers: McpTransportHandlers,
): McpTransport {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw mcpError("UNSUPPORTED", "fetch is unavailable for remote mcp servers");
  }
  let closed = false;
  let sessionId: string | undefined;

  return {
    send: async (message) => {
      if (closed) throw mcpError("UNAVAILABLE", "mcp session is closed");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs);
      let response: Response;
      let url = options.url;
      try {
        for (let hop = 0; ; hop += 1) {
          options.assertUrlAllowed?.(url);
          response = await fetchImpl(url, {
            method: "POST",
            headers: {
              ...options.headers,
              "content-type": "application/json",
              accept: "application/json, text/event-stream",
              "mcp-protocol-version": MCP_PROTOCOL_VERSION,
              ...(sessionId ? { "mcp-session-id": sessionId } : {}),
            },
            body: JSON.stringify(message),
            redirect: "manual",
            signal: controller.signal,
          });
          if (response.status < 300 || response.status > 399) break;
          const location = response.headers.get("location");
          if (!location) break;
          if (hop >= MAX_MCP_REDIRECTS) {
            throw mcpError("HTTP_REDIRECT", `too many redirects: ${options.url}`);
          }
          let nextUrl: URL;
          try {
            nextUrl = new URL(location, url);
          } catch {
            throw mcpError("HTTP_REDIRECT", `invalid redirect from ${url}`);
          }
          if (nextUrl.protocol !== "http:" && nextUrl.protocol !== "https:") {
            throw mcpError("HTTP_REDIRECT", `unsupported redirect from ${url}`);
          }
          url = nextUrl.toString();
        }
      } finally {
        clearTimeout(timer);
      }
      const nextSession = response.headers.get("mcp-session-id");
      if (nextSession) sessionId = nextSession;
      if (!response.ok) {
        throw mcpError("HTTP_ERROR", `mcp server returned ${response.status}`);
      }
      const contentType = response.headers.get("content-type") ?? "";
      const body = await response.text();
      if (!body.trim()) return;
      const messages = contentType.includes("text/event-stream")
        ? parseSseMessages(body)
        : (() => {
            const parsed = JSON.parse(body) as JsonRpcMessage | JsonRpcMessage[];
            return Array.isArray(parsed) ? parsed : [parsed];
          })();
      for (const entry of messages) handlers.onMessage(entry);
    },
    close: () => {
      closed = true;
      handlers.onClose("mcp session closed");
    },
  };
}

export type McpServerClientOptions = {
  /** Owning plugin, when there is one. User-configured servers have none. */
  pluginId?: string;
  /** Working directory for a stdio server, and the `confined` sandbox root. */
  rootPath: string;
  /** Defaults to `confined`, the stricter plugin rule. */
  commandPolicy?: McpCommandPolicy;
  server: PluginMcpServerContrib;
  /** Resolved env (stdio) or headers (http); never inherited from the host. */
  values: Record<string, string>;
  audit?: (entry: Record<string, unknown>) => void;
  /** Audit `api` namespace: `plugin.mcp` for plugins, `mcp` for user servers. */
  auditScope?: string;
  connectTimeoutMs?: number;
  callTimeoutMs?: number;
  /** Test seams. */
  spawnImpl?: typeof nodeSpawn;
  fetchImpl?: typeof fetch;
  /** Optional per-request policy, used to re-check plugin redirects. */
  assertUrlAllowed?: (url: string) => void;
};

/**
 * One MCP server (spec 07 §3, ADR 0038) — declared by a plugin, or configured
 * by the user in the Extensions page.
 *
 * The client speaks the slice of MCP the desktop needs — `initialize`,
 * `tools/list`, `tools/call` — over stdio or streamable HTTP. It connects on
 * demand and reconnects after the peer dies, so a crashed server costs one
 * failed tool call rather than a stale tool list.
 */
export class McpServerClient {
  readonly serverId: string;
  readonly transportKind: "stdio" | "http";
  private opts: McpServerClientOptions;
  private transport: McpTransport | null = null;
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private nextId = 1;
  private tools: McpTool[] = [];
  private connecting: Promise<McpTool[]> | null = null;

  constructor(options: McpServerClientOptions) {
    this.opts = options;
    this.serverId = options.server.id;
    this.transportKind = options.server.transport;
  }

  /** Tools discovered by the last successful handshake. */
  getTools(): McpTool[] {
    return this.tools;
  }

  isConnected(): boolean {
    return this.transport !== null;
  }

  async connect(): Promise<McpTool[]> {
    if (this.transport) return this.tools;
    if (this.connecting) return this.connecting;
    this.connecting = this.handshake().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  async callTool(toolName: string, args: unknown): Promise<unknown> {
    await this.connect();
    const started = Date.now();
    try {
      const result = (await this.request(
        "tools/call",
        { name: toolName, arguments: args ?? {} },
        this.opts.callTimeoutMs ?? MCP_CALL_TIMEOUT_MS,
      )) as { content?: unknown; isError?: boolean } | null;
      if (result && typeof result === "object" && result.isError) {
        throw mcpError("TOOL_FAILED", describeMcpContent(result.content) || "mcp tool failed");
      }
      this.audit(true, toolName, Date.now() - started);
      return result ?? null;
    } catch (error) {
      this.audit(false, toolName, Date.now() - started, error);
      throw error;
    }
  }

  close(): void {
    const transport = this.transport;
    this.transport = null;
    this.tools = [];
    transport?.close();
    this.failPending(mcpError("UNAVAILABLE", "mcp session closed"));
  }

  private async handshake(): Promise<McpTool[]> {
    const timeoutMs = this.opts.connectTimeoutMs ?? MCP_CONNECT_TIMEOUT_MS;
    const transport = this.createTransport(timeoutMs);
    this.transport = transport;
    try {
      await this.request(
        "initialize",
        {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "PI-Desktop", version: "1" },
        },
        timeoutMs,
      );
      await transport.send({ jsonrpc: "2.0", method: "notifications/initialized" });
      this.tools = await this.listTools(timeoutMs);
      this.opts.audit?.({
        pluginId: this.opts.pluginId,
        api: this.auditApi("connect"),
        ok: true,
        serverId: this.serverId,
        transport: this.transportKind,
        toolCount: this.tools.length,
        ts: Date.now(),
      });
      return this.tools;
    } catch (error) {
      this.transport = null;
      this.tools = [];
      transport.close();
      this.failPending(mcpError("UNAVAILABLE", "mcp handshake failed"));
      this.opts.audit?.({
        pluginId: this.opts.pluginId,
        api: this.auditApi("connect"),
        ok: false,
        serverId: this.serverId,
        transport: this.transportKind,
        errorCode: (error as McpError).code ?? "MCP_CONNECT_FAILED",
        message: (error as Error).message,
        ts: Date.now(),
      });
      throw error;
    }
  }

  private createTransport(timeoutMs: number): McpTransport {
    const handlers: McpTransportHandlers = {
      onMessage: (message) => this.receive(message),
      onClose: (reason) => {
        this.transport = null;
        this.tools = [];
        this.failPending(mcpError("UNAVAILABLE", reason));
      },
    };
    if (this.opts.server.transport === "stdio") {
      return createStdioTransport(
        {
          rootPath: this.opts.rootPath,
          commandPolicy: this.opts.commandPolicy ?? "confined",
          command: String(this.opts.server.command ?? ""),
          args: this.opts.server.args ?? [],
          env: mcpProcessEnv(this.opts.pluginId, this.opts.values),
          spawnImpl: this.opts.spawnImpl,
        },
        handlers,
      );
    }
    return createHttpTransport(
      {
        url: String(this.opts.server.url ?? ""),
        headers: this.opts.values,
        timeoutMs,
        fetchImpl: this.opts.fetchImpl,
        assertUrlAllowed: this.opts.assertUrlAllowed,
      },
      handlers,
    );
  }

  private async listTools(timeoutMs: number): Promise<McpTool[]> {
    const collected: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
      const result = (await this.request(
        "tools/list",
        cursor ? { cursor } : {},
        timeoutMs,
      )) as { tools?: unknown; nextCursor?: unknown } | null;
      const tools = Array.isArray(result?.tools) ? result?.tools : [];
      for (const raw of tools as Array<Record<string, unknown>>) {
        const name = typeof raw?.name === "string" ? raw.name.trim() : "";
        if (!name) continue;
        if (collected.length >= MAX_MCP_TOOLS_PER_SERVER) {
          this.opts.audit?.({
            pluginId: this.opts.pluginId,
            api: this.auditApi("tools.truncated"),
            ok: false,
            errorCode: "LIMIT_EXCEEDED",
            serverId: this.serverId,
            limit: MAX_MCP_TOOLS_PER_SERVER,
            ts: Date.now(),
          });
          return collected;
        }
        collected.push({
          name,
          description: typeof raw.description === "string" ? raw.description : undefined,
          inputSchema: raw.inputSchema,
        });
      }
      const next = typeof result?.nextCursor === "string" ? result.nextCursor : "";
      if (!next || next === cursor) return collected;
      cursor = next;
    }
    return collected;
  }

  private request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const transport = this.transport;
    if (!transport) {
      return Promise.reject(mcpError("UNAVAILABLE", "mcp server is not connected"));
    }
    const id = this.nextId++;
    return new Promise<unknown>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectPromise(mcpError("TIMEOUT", `mcp ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer });
      void transport.send({ jsonrpc: "2.0", id, method, params }).catch((error: Error) => {
        const entry = this.pending.get(id);
        if (!entry) return;
        this.pending.delete(id);
        clearTimeout(entry.timer);
        rejectPromise(error);
      });
    });
  }

  private receive(message: JsonRpcMessage): void {
    if (message.id !== undefined && message.id !== null && message.method) {
      // The desktop exposes no server-initiated capabilities; answering keeps
      // the peer from waiting on a reply that will never come.
      void this.transport
        ?.send({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: "method not supported" },
        })
        .catch(() => undefined);
      return;
    }
    if (typeof message.id !== "number") return;
    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) {
      entry.reject(
        mcpError("MCP_ERROR", message.error.message || `mcp error ${message.error.code ?? ""}`),
      );
      return;
    }
    entry.resolve(message.result ?? null);
  }

  private failPending(error: Error): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  private auditApi(suffix: string): string {
    return `${this.opts.auditScope ?? "plugin.mcp"}.${suffix}`;
  }

  private audit(ok: boolean, toolName: string, durationMs: number, error?: unknown): void {
    this.opts.audit?.({
      pluginId: this.opts.pluginId,
      api: this.auditApi("call"),
      ok,
      serverId: this.serverId,
      transport: this.transportKind,
      tool: toolName,
      durationMs,
      ...(ok
        ? {}
        : {
            errorCode: (error as McpError)?.code ?? "MCP_CALL_FAILED",
            message: (error as Error)?.message,
          }),
      ts: Date.now(),
    });
  }
}

/** Flatten MCP content blocks into a short message for error surfaces. */
export function describeMcpContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string") {
        return (block as { text: string }).text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .slice(0, 500);
}
