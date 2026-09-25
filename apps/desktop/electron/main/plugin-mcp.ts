import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { isAbsolute, resolve, sep } from "node:path";
import type { PluginMcpServerContrib } from "@pi-desktop/plugin-sdk";
import { minimalChildEnv } from "./child-process-env.ts";
import {
  MCP_STDIO_HOST_ENV_KEYS,
  decodeMcpStderr,
  resolveMcpStdioLaunch,
} from "./mcp-stdio-launch.ts";
import { userLookupPath } from "./user-login-path.ts";

/** MCP revision we advertise during the handshake. */
export const MCP_PROTOCOL_VERSION = "2025-06-18";
/** Discovery must finish inside this budget or the server is skipped. */
export const MCP_CONNECT_TIMEOUT_MS = 10_000;
/** Kept under the plugin tool budget so the MCP error wins the race. */
export const MCP_CALL_TIMEOUT_MS = 100_000;
/**
 * Protocol bound, not a prompt budget: MCP tools reach the model as on-demand
 * entries behind `ToolSearch` rather than as an always-present list, so the
 * only thing that needs a ceiling is a server streaming forever. Sized like
 * Codex's per-server MCP catalog bound; a real catalog never approaches it.
 */
export const MAX_MCP_TOOLS_PER_SERVER = 2_048;
/** Keep an MCP endpoint from bouncing requests through an unbounded chain. */
const MAX_MCP_REDIRECTS = 5;
/** `tools/list` pages one server may span before its handshake is refused. */
const MAX_TOOL_PAGES = 100;
/** A whole `tools/list` traversal must finish inside this budget. */
export const MCP_TOOL_DISCOVERY_TIMEOUT_MS = 30_000;
/** Guard against a server streaming an unbounded line at us. */
const MAX_STDIO_LINE_BYTES = 4 * 1024 * 1024;
/** Guard against a remote MCP server streaming an unbounded response body. */
const MAX_HTTP_RESPONSE_BYTES = 4 * 1024 * 1024;

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
  send: (message: JsonRpcMessage, timeoutMs?: number, signal?: AbortSignal) => Promise<void>;
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
 *
 * PATH is the login-shell PATH (ADR 0045 / D600), not the Finder/Dock GUI
 * PATH, so a market-installed `uvx`/`npx` server can spawn (issue #571). The
 * identity variables cross for the same reason the toolchain ones do: the child
 * is third-party code that resolves `~` through `$HOME` (issue #717). Windows
 * also needs `PATHEXT` / `ComSpec` / `FNM_DIR` so official Node and fnm shims
 * resolve (issue #789).
 */
export function mcpProcessEnv(
  pluginId: string | undefined,
  values: Record<string, string>,
  hostEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {
    ...(pluginId ? { PI_PLUGIN_ID: pluginId } : {}),
    NODE_ENV: hostEnv.NODE_ENV ?? process.env.NODE_ENV ?? "production",
  };
  if (hostEnv === process.env) {
    Object.assign(env, minimalChildEnv());
    for (const key of MCP_STDIO_HOST_ENV_KEYS) {
      if (env[key]) continue;
      const value = process.env[key];
      if (value) env[key] = value;
    }
    const path = userLookupPath(process.env.PATH ?? "");
    if (path) env.PATH = path;
  } else {
    for (const key of MCP_STDIO_HOST_ENV_KEYS) {
      const value = hostEnv[key];
      if (value) env[key] = value;
    }
    if (!env.PATH && env.Path) env.PATH = env.Path;
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
  const resolved = resolveMcpCommand(options.rootPath, options.command, options.commandPolicy);
  const launch = resolveMcpStdioLaunch({
    command: resolved,
    args: options.args,
    env: options.env,
    hostEnv: {
      ...process.env,
      PATH: options.env.PATH ?? process.env.PATH,
    },
  });
  const child: ChildProcess = spawnImpl(launch.command, launch.args, {
    cwd: options.rootPath,
    env: launch.env,
    stdio: ["pipe", "pipe", "pipe"],
    // Arguments stay literal. Known launchers rewrite to a PE binary; remaining
    // Windows `.cmd` shims go through `cmd.exe /d /s /c` with quoted args.
    shell: false,
    windowsHide: launch.windowsHide,
    windowsVerbatimArguments: launch.windowsVerbatimArguments,
  });

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
  child.stderr?.on("data", (chunk: Buffer | string) => {
    lastStderr = decodeMcpStderr(
      chunk,
      process.platform,
      Boolean(launch.windowsVerbatimArguments),
    )
      .trimEnd()
      .slice(-500);
  });
  child.on("error", (error: Error) => {
    closed = true;
    const code = (error as NodeJS.ErrnoException).code;
    handlers.onClose(
      code === "ENOENT"
        ? `command not found: ${options.command}. Install it or add it to PATH.`
        : error.message,
    );
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


async function readBoundedHttpBody(response: Response): Promise<string> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_HTTP_RESPONSE_BYTES) {
    try {
      await response.body?.cancel();
    } catch {
      // The response is already rejected; cancellation is best effort.
    }
    throw mcpError("LIMIT_EXCEEDED", "mcp server response is too large");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      bytes += value.byteLength;
      if (bytes > MAX_HTTP_RESPONSE_BYTES) {
        await reader.cancel();
        throw mcpError("LIMIT_EXCEEDED", "mcp server response is too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

function headersForMcpRequest(
  headers: Record<string, string>,
  initialUrl: string,
  currentUrl: string,
): Record<string, string> {
  if (new URL(initialUrl).origin === new URL(currentUrl).origin) return { ...headers };
  return {};
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
  const activeControllers = new Set<AbortController>();

  return {
    send: async (message, timeoutMs = options.timeoutMs, signal) => {
      if (closed) throw mcpError("UNAVAILABLE", "mcp session is closed");
      const controller = new AbortController();
      const abort = () => controller.abort();
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
      activeControllers.add(controller);
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let url = options.url;
      try {
        for (let hop = 0; ; hop += 1) {
          options.assertUrlAllowed?.(url);
          const requestHeaders = headersForMcpRequest(options.headers, options.url, url);
          const currentOrigin = new URL(url).origin;
          const initialOrigin = new URL(options.url).origin;
          const response = await fetchImpl(url, {
            method: "POST",
            headers: {
              ...requestHeaders,
              "content-type": "application/json",
              accept: "application/json, text/event-stream",
              "mcp-protocol-version": MCP_PROTOCOL_VERSION,
              ...(currentOrigin === initialOrigin && sessionId
                ? { "mcp-session-id": sessionId }
                : {}),
            },
            body: JSON.stringify(message),
            redirect: "manual",
            signal: controller.signal,
          });
          if (response.status >= 300 && response.status <= 399) {
            const location = response.headers.get("location");
            try {
              await response.body?.cancel();
            } catch {
              // The redirect body is not part of the MCP response.
            }
            if (!location) {
              throw mcpError("HTTP_REDIRECT", "redirect without a location header");
            }
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
            if (nextUrl.origin !== initialOrigin) sessionId = undefined;
            url = nextUrl.toString();
            continue;
          }
          if (!response.ok) {
            try {
              await response.body?.cancel();
            } catch {
              // The status is sufficient for the structured MCP error.
            }
            throw mcpError("HTTP_ERROR", `mcp server returned ${response.status}`);
          }
          const nextSession = response.headers.get("mcp-session-id");
          if (nextSession && new URL(url).origin === initialOrigin) sessionId = nextSession;
          // Notifications and client responses have no JSON-RPC reply. Some
          // servers include a plain-text "Accepted" body with their HTTP 202.
          if (response.status === 202 && (message.method === undefined || message.id === undefined)) {
            try {
              await response.body?.cancel();
            } catch {
              // The acknowledgement body is not part of the MCP response.
            }
            return;
          }
          const contentType = response.headers.get("content-type") ?? "";
          const body = await readBoundedHttpBody(response);
          if (!body.trim()) return;
          const messages = contentType.includes("text/event-stream")
            ? parseSseMessages(body)
            : (() => {
                const parsed = JSON.parse(body) as JsonRpcMessage | JsonRpcMessage[];
                return Array.isArray(parsed) ? parsed : [parsed];
              })();
          for (const entry of messages) handlers.onMessage(entry);
          return;
        }
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        activeControllers.delete(controller);
      }
    },
    close: () => {
      closed = true;
      for (const controller of activeControllers) controller.abort();
      activeControllers.clear();
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
  /** Budget for the whole `tools/list` traversal, however many pages it spans. */
  discoveryTimeoutMs?: number;
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

  async callTool(toolName: string, args: unknown, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) throw mcpError("TOOL_ABORTED", "mcp tool call aborted");
    const connecting = this.connect();
    if (signal) {
      let rejectAbort!: (error: Error) => void;
      const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
      const abort = () => rejectAbort(mcpError("TOOL_ABORTED", "mcp tool call aborted"));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      try {
        await Promise.race([connecting, aborted]);
      } finally {
        signal.removeEventListener("abort", abort);
      }
    } else {
      await connecting;
    }
    if (signal?.aborted) throw mcpError("TOOL_ABORTED", "mcp tool call aborted");
    const started = Date.now();
    try {
      const result = (await this.request(
        "tools/call",
        { name: toolName, arguments: args ?? {} },
        this.opts.callTimeoutMs ?? MCP_CALL_TIMEOUT_MS,
        signal,
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

  /** Probe a live connection without changing its discovered tool catalog. */
  async ping(timeoutMs = 5_000): Promise<void> {
    await this.request("ping", {}, timeoutMs);
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

  /**
   * Read the server's whole catalog.
   *
   * The tool count is bounded only by the protocol guards below, because the
   * model never receives this as a list: MCP tools land in the on-demand
   * catalog behind `ToolSearch`, and the prompt block that advertises them is
   * what truncates. What has to stay bounded is the traversal itself — pages,
   * items, cursors, and total time — and a server that exceeds any of those is
   * refused rather than silently contributing a prefix of its catalog.
   */
  private async listTools(timeoutMs: number): Promise<McpTool[]> {
    const collected: McpTool[] = [];
    const seenCursors = new Set<string>();
    const deadline =
      Date.now() + (this.opts.discoveryTimeoutMs ?? MCP_TOOL_DISCOVERY_TIMEOUT_MS);
    let cursor: string | undefined;
    for (let page = 0; ; page += 1) {
      if (page >= MAX_TOOL_PAGES) {
        throw mcpError(
          "LIMIT_EXCEEDED",
          `mcp tools/list exceeded ${MAX_TOOL_PAGES} pages (${collected.length} tools so far)`,
        );
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw mcpError(
          "TIMEOUT",
          `mcp tools/list did not finish inside its budget (${collected.length} tools so far)`,
        );
      }
      const result = (await this.request(
        "tools/list",
        cursor ? { cursor } : {},
        Math.min(timeoutMs, remaining),
      )) as { tools?: unknown; nextCursor?: unknown } | null;
      const tools = Array.isArray(result?.tools) ? result?.tools : [];
      for (const raw of tools as Array<Record<string, unknown>>) {
        const name = typeof raw?.name === "string" ? raw.name.trim() : "";
        if (!name) continue;
        if (collected.length >= MAX_MCP_TOOLS_PER_SERVER) {
          throw mcpError(
            "LIMIT_EXCEEDED",
            `mcp server advertises more than ${MAX_MCP_TOOLS_PER_SERVER} tools`,
          );
        }
        collected.push({
          name,
          description: typeof raw.description === "string" ? raw.description : undefined,
          inputSchema: raw.inputSchema,
        });
      }
      const next = result?.nextCursor;
      // Absent and empty both mean "that was the last page"; anything else has
      // to be a cursor this client can follow, so a malformed one is refused
      // rather than mistaken for the end of a catalog.
      if (next === undefined || next === null || next === "") return collected;
      if (typeof next !== "string") {
        throw mcpError("INVALID_RESPONSE", "mcp server returned a non-string tools/list cursor");
      }
      if (seenCursors.has(next)) {
        throw mcpError("INVALID_RESPONSE", "mcp server repeated a tools/list cursor");
      }
      seenCursors.add(next);
      cursor = next;
    }
  }

  private request(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    const transport = this.transport;
    if (!transport) {
      return Promise.reject(mcpError("UNAVAILABLE", "mcp server is not connected"));
    }
    if (signal?.aborted) return Promise.reject(mcpError("TOOL_ABORTED", "mcp tool call aborted"));
    const id = this.nextId++;
    return new Promise<unknown>((resolvePromise, rejectPromise) => {
      const removeAbort = () => signal?.removeEventListener("abort", abort);
      const abort = () => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer);
        removeAbort();
        rejectPromise(mcpError("TOOL_ABORTED", "mcp tool call aborted"));
        void transport.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: "cancelled" } }).catch(() => undefined);
      };
      const timer = setTimeout(() => {
        this.pending.delete(id);
        removeAbort();
        rejectPromise(mcpError("TIMEOUT", `mcp ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => { removeAbort(); resolvePromise(value); },
        reject: (error) => { removeAbort(); rejectPromise(error); },
        timer,
      });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      void transport.send({ jsonrpc: "2.0", id, method, params }, timeoutMs, signal).catch((error: Error) => {
        const entry = this.pending.get(id);
        if (!entry) return;
        this.pending.delete(id);
        clearTimeout(entry.timer);
        entry.reject(error);
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
