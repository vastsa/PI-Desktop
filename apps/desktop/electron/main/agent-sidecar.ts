import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { HostProcess, ProcessExitHandler, StderrHandler } from "./host-process";
import { DEFAULT_RPC_TIMEOUT_MS, rpcTimeoutMs } from "@pi-desktop/shared";

// stderr lines kept per sidecar so an unexpected exit can be reported with the
// process's last words instead of a bare "agent sidecar exited".
const SIDECAR_STDERR_TAIL_LINES = 40;

export type SidecarNotificationHandler = (method: string, params: unknown) => void;

/** Result shape the sidecar's tool executor expects from tools.execute. */
export type LocalToolResult = {
  ok: boolean;
  content: unknown;
  isError?: boolean;
  errorCode?: string;
};

export type LocalToolHandler = (input: {
  sessionId: string;
  toolCallId: string;
  args: unknown;
}) => Promise<LocalToolResult>;

export type ProjectInstructionResolver = (input: {
  sessionId: string;
  path: string;
  /** Project root registered by Electron main for this session. */
  projectPath?: string;
}) => Promise<unknown>;

/**
 * Resolve request auth for a vendor account. Answered by main against the
 * signed-in pi-ai collection; the sidecar names a provider row, never a vendor
 * or a credential, and gets back only a short-lived `ModelAuth`.
 */
export type VendorAuthResolver = (input: {
  sessionId: string;
  providerId: string;
}) => Promise<unknown>;

// The sidecar runs model-directed code paths; it must not be able to pull
// secrets or mutate configuration through the parent proxy. Tight allowlist
// of host methods the agent loop legitimately needs.
//
// `provider.resolveAuth` is answered by main itself (never forwarded to
// host-core) and only for a provider row main bound to that same session, so
// it cannot reach a credential the session was not launched with.
const HOST_PROXY_ALLOWED = new Set([
  "tools.execute",
  "tools.abort",
  "tools.list",
  "session.get",
  "session.appendMessage",
  "session.appendCompaction",
  "session.replaceMessages",
  "workspace.get",
  "plans.enter",
  "plans.submit",
  "plans.pending",
  "plans.abort",
  "project.instructions.resolve",
  "provider.resolveAuth",
  "provider.resolveSubagentModel",
  "app.health",
]);

function resolveSidecarEntry(): string {
  const candidates = [
    join(process.resourcesPath || "", "agent-runtime/sidecar.js"),
    join(__dirname, "../../../agent-runtime/dist/sidecar.js"),
    join(__dirname, "../../../../packages/agent-runtime/dist/sidecar.js"),
  ];
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  return join(__dirname, "../../../../packages/agent-runtime/dist/sidecar.js");
}

export class AgentSidecar {
  private child: ChildProcessWithoutNullStreams;
  private pending = new Map<
    string,
    {
      resolve: (v: any) => void;
      reject: (e: Error) => void;
      timer?: ReturnType<typeof setTimeout>;
    }
  >();
  private handlers = new Set<SidecarNotificationHandler>();
  private exitHandlers = new Set<ProcessExitHandler>();
  private disposed = false;
  private closed = false;
  private exitNotified = false;
  private stderrTail: string[] = [];
  private host: HostProcess | null = null;
  private unsubscribeHost: (() => void) | null = null;
  private unsubscribeHostExit: (() => void) | null = null;
  private readline?: ReturnType<typeof createInterface>;
  // Tools served by Electron main itself (e.g. BrowserPreview drives the
  // work panel's WebContentsView) — host-core never sees these.
  private localTools = new Map<string, LocalToolHandler>();
  private localToolTimers = new Set<ReturnType<typeof setTimeout>>();
  private projectInstructionResolver: ProjectInstructionResolver | null = null;
  // The sidecar may request a path, but it never chooses the project root.
  // Electron main registers this binding from the host-owned session record
  // immediately before starting a runtime turn.
  private projectInstructionRoots = new Map<string, string>();
  private vendorAuthResolver: VendorAuthResolver | null = null;
  // Vendor-account rows this session was launched with. The sidecar can only
  // ask for auth it is already using, and a session that never bound an OAuth
  // row can ask for nothing at all.
  private vendorAuthBindings = new Map<string, Set<string>>();

  constructor(onStderr?: StderrHandler) {
    const entry = resolveSidecarEntry();
    this.child = spawn(process.execPath, [entry], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
      },
    });

    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (text: string) => {
      if (!text) return;
      this.recordStderr(text);
      if (onStderr) onStderr(text);
      else console.error(`[agent-sidecar] ${text.trimEnd()}`);
    });

    this.child.on("exit", (code, signal) => {
      this.closeTransport(new Error("agent sidecar exited"));
      this.notifyExit({ code, signal, intentional: this.disposed });
    });
    this.child.on("error", (error) => {
      this.closeTransport(error instanceof Error ? error : new Error(String(error)));
      this.notifyExit({ code: null, signal: null, intentional: this.disposed });
    });

    const rl = createInterface({ input: this.child.stdout });
    this.readline = rl;
    rl.on("line", (line) => void this.onLine(line));
  }

  private recordStderr(text: string) {
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      this.stderrTail.push(line);
      if (this.stderrTail.length > SIDECAR_STDERR_TAIL_LINES) {
        this.stderrTail.shift();
      }
    }
  }

  private closeTransport(error: Error) {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribeHost?.();
    this.unsubscribeHost = null;
    this.unsubscribeHostExit?.();
    this.unsubscribeHostExit = null;
    this.host = null;
    for (const [, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
    for (const timer of this.localToolTimers) clearTimeout(timer);
    this.localToolTimers.clear();
    this.handlers.clear();
    this.readline?.close();
    this.readline = undefined;
    this.child.removeAllListeners("exit");
    this.child.removeAllListeners("error");
    this.child.stderr.removeAllListeners("data");
  }

  private notifyExit(info: {
    code: number | null;
    signal: NodeJS.Signals | null;
    intentional: boolean;
  }) {
    if (this.exitNotified) return;
    this.exitNotified = true;
    // Snapshot the sidecar's last stderr lines: the dying process emits no
    // stdout, so they are the only context a crash report gets.
    const stderrTail = this.stderrTail.slice();
    for (const h of this.exitHandlers) h({ ...info, stderrTail });
    this.exitHandlers.clear();
  }

  private writeToChild(payload: string): boolean {
    if (this.closed || this.disposed) return false;
    if (this.child.stdin.destroyed || !this.child.stdin.writable) {
      const failure = new Error("agent sidecar stdin is unavailable");
      this.closeTransport(failure);
      this.notifyExit({ code: null, signal: null, intentional: this.disposed });
      return false;
    }
    try {
      this.child.stdin.write(payload, (error) => {
        if (error) {
          this.closeTransport(error);
          this.notifyExit({ code: null, signal: null, intentional: this.disposed });
        }
      });
      return true;
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.closeTransport(failure);
      this.notifyExit({ code: null, signal: null, intentional: this.disposed });
      return false;
    }
  }

  private async runLocalTool(
    handler: LocalToolHandler,
    input: Parameters<LocalToolHandler>[0],
  ): Promise<LocalToolResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        handler(input),
        new Promise<LocalToolResult>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error("main-local tool timeout"));
          }, DEFAULT_RPC_TIMEOUT_MS);
          this.localToolTimers.add(timer);
        }),
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
        this.localToolTimers.delete(timer);
      }
    }
  }

  onExit(handler: ProcessExitHandler): () => void {
    if (this.closed) return () => undefined;
    this.exitHandlers.add(handler);
    return () => this.exitHandlers.delete(handler);
  }

  /** Register a tool the sidecar can call that main handles locally. */
  setLocalTool(name: string, handler: LocalToolHandler): void {
    this.localTools.set(name, handler);
  }

  setProjectInstructionResolver(resolver: ProjectInstructionResolver): void {
    this.projectInstructionResolver = resolver;
  }

  setProjectInstructionRoot(sessionId: string, projectPath?: string): void {
    const id = sessionId.trim();
    if (!id) return;
    const root = projectPath?.trim();
    if (root) this.projectInstructionRoots.set(id, root);
    else this.projectInstructionRoots.delete(id);
  }

  clearProjectInstructionRoot(sessionId: string): void {
    this.projectInstructionRoots.delete(sessionId.trim());
  }

  setVendorAuthResolver(resolver: VendorAuthResolver): void {
    this.vendorAuthResolver = resolver;
  }

  /**
   * Bind the vendor-account rows a turn may sign requests with. Replaces the
   * session's previous set, so a row dropped from the launch payload — a model
   * switch or account removal — stops being resolvable on the next turn.
   */
  setVendorAuthBindings(
    sessionId: string,
    bindings: ReadonlyArray<{ providerId: string }>,
  ): void {
    const id = sessionId.trim();
    if (!id) return;
    const providerIds = new Set<string>();
    for (const binding of bindings) {
      const providerId = binding.providerId?.trim();
      if (providerId) providerIds.add(providerId);
    }
    if (providerIds.size > 0) this.vendorAuthBindings.set(id, providerIds);
    else this.vendorAuthBindings.delete(id);
  }

  clearVendorAuthBindings(sessionId: string): void {
    this.vendorAuthBindings.delete(sessionId.trim());
  }

  setHost(host: HostProcess) {
    if (this.closed) return;
    this.host = host;
    this.unsubscribeHost?.();
    this.unsubscribeHostExit?.();
    this.unsubscribeHost = host.onNotification((method, params) => {
      // Forward host notifications to sidecar. permissions.request stays out:
      // the renderer already gets it straight from wireHost, and bouncing it
      // through the sidecar delivered the dialog twice with the full args
      // payload re-serialized across two extra stdio hops.
      if (method === "permissions.request") return;
      const payload =
        JSON.stringify({
          jsonrpc: "2.0",
          method: "host.notification",
          params: { method, params },
        }) + "\n";
      this.writeToChild(payload);
    });
    this.unsubscribeHostExit = host.onExit(() => {
      this.unsubscribeHost?.();
      this.unsubscribeHost = null;
      this.unsubscribeHostExit = null;
      this.host = null;
    });
  }

  /**
   * Answer one `provider.resolveAuth` request. Refuses anything the session was
   * not launched with: the provider row has to be in this session's bindings,
   * which main rewrites on every turn.
   */
  private async resolveVendorAuth(
    params: Record<string, unknown>,
  ): Promise<unknown> {
    if (!this.vendorAuthResolver) {
      throw new Error("vendor account auth resolver unavailable");
    }
    const sessionId = String(params.sessionId ?? "").trim();
    const providerId = String(params.providerId ?? "").trim();
    const bound = this.vendorAuthBindings.get(sessionId)?.has(providerId);
    if (!bound) {
      throw Object.assign(
        new Error("provider is not bound to this session"),
        { code: -32000, data: { errorCode: "PROVIDER_NOT_BOUND" } },
      );
    }
    return this.vendorAuthResolver({ sessionId, providerId });
  }

  /**
   * On-demand subagent model resolution. The runtime calls this when the
   * parent agent passes a `model` override on Task that was not statically
   * pinned by any definition. Main resolves it against the user's configured
   * providers and the models.dev catalog, respecting the
   * `availableForSubagents` gate on each model binding.
   */
  private subagentModelResolver:
    | ((key: string) => Promise<unknown>)
    | null = null;

  setSubagentModelResolver(
    resolver: (key: string) => Promise<unknown>,
  ): void {
    this.subagentModelResolver = resolver;
  }

  private async resolveSubagentModel(
    params: Record<string, unknown>,
  ): Promise<unknown> {
    if (!this.subagentModelResolver) {
      throw new Error("subagent model resolver unavailable");
    }
    const key = String(params.key ?? "").trim();
    if (!key || !key.includes("/")) {
      throw Object.assign(
        new Error("invalid model key; expected 'provider/model'"),
        { code: -32602 },
      );
    }
    return this.subagentModelResolver(key);
  }

  private async onLine(line: string) {
    if (!line.trim()) return;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }

    // Reverse RPC from sidecar → host proxy
    if (msg.method === "host.proxy" && msg.id !== undefined) {
      try {
        const method = String(msg.params?.method || "");
        if (!HOST_PROXY_ALLOWED.has(method)) {
          throw Object.assign(
            new Error(`host method not allowed from sidecar: ${method}`),
            { code: -32601 },
          );
        }
        const params = (msg.params?.params ?? {}) as Record<string, unknown>;
        const requestedToolName = String(params.toolName ?? "");
        const planLocalTool =
          requestedToolName === "Skill" ||
          requestedToolName === "PluginCheck" ||
          requestedToolName === "PluginScaffold" ||
          requestedToolName === "PluginPack" ||
          requestedToolName.startsWith("plugin_");
        if (
          method === "tools.execute" &&
          params.mode === "plan" &&
          planLocalTool &&
          requestedToolName !== "BrowserPreview"
        ) {
          throw Object.assign(
            new Error(`${requestedToolName} is unavailable in Plan mode`),
            { code: -32000, data: { errorCode: "TOOL_DISABLED_IN_PLAN" } },
          );
        }
        if (method === "project.instructions.resolve") {
          if (!this.projectInstructionResolver) {
            throw new Error("project instruction resolver unavailable");
          }
          const sessionId = String(params.sessionId ?? "");
          const result = await this.projectInstructionResolver({
            sessionId,
            path: String(params.path ?? ""),
            projectPath: this.projectInstructionRoots.get(sessionId),
          });
          this.writeToChild(
            JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n",
          );
          return;
        }
        if (method === "provider.resolveAuth") {
          const result = await this.resolveVendorAuth(params);
          this.writeToChild(
            JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n",
          );
          return;
        }
        if (method === "provider.resolveSubagentModel") {
          const result = await this.resolveSubagentModel(params);
          this.writeToChild(
            JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n",
          );
          return;
        }
        // Main-local tools short-circuit before host-core (which doesn't
        // know them); everything else proxies through unchanged.
        const localTool =
          method === "tools.execute"
            ? this.localTools.get(requestedToolName)
            : undefined;
        if (localTool) {
          const toolName = requestedToolName;
          // Local tools can bypass host-core's permission boundary. Plan mode
          // therefore permits only the read-only BrowserPreview bridge; every
          // other main-local tool fails closed even if a stale runtime asks for
          // it directly.
          const result =
            params.mode === "plan" && toolName !== "BrowserPreview"
              ? {
                  ok: false,
                  isError: true,
                  errorCode: "TOOL_DISABLED_IN_PLAN",
                  content: `${toolName} is unavailable in Plan mode.`,
                }
              : await this.runLocalTool(localTool, {
                  sessionId: String(params.sessionId ?? ""),
                  toolCallId: String(params.toolCallId ?? ""),
                  args: params.args,
                });
          this.writeToChild(
            JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n",
          );
          return;
        }
        if (!this.host) throw new Error("host unavailable");
        const result = await this.host.call(method, params);
        this.writeToChild(
          JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n",
        );
      } catch (e: any) {
        this.writeToChild(
          JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            error: {
              code: e?.code ?? -32000,
              message: e instanceof Error ? e.message : String(e),
              data: e?.data,
            },
          }) + "\n",
        );
      }
      return;
    }

    if (msg.id !== undefined && msg.id !== null && msg.method === undefined) {
      const pending = this.pending.get(String(msg.id));
      if (pending) {
        this.pending.delete(String(msg.id));
        if (pending.timer) clearTimeout(pending.timer);
        if (msg.error) {
          const err = new Error(msg.error.message) as Error & {
            code?: number;
            data?: unknown;
          };
          err.code = msg.error.code;
          err.data = msg.error.data;
          pending.reject(err);
        } else {
          pending.resolve(msg.result);
        }
      }
      return;
    }

    if (msg.method) {
      for (const h of this.handlers) h(msg.method, msg.params);
    }
  }

  onNotification(handler: SidecarNotificationHandler): () => void {
    if (this.closed) return () => undefined;
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async call<T = unknown>(method: string, params: unknown = {}): Promise<T> {
    if (this.closed) throw new Error("agent sidecar is unavailable");
    const id = randomUUID();
    const timeoutMs = rpcTimeoutMs(method, params);
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (v: any) => void,
        reject,
      });
      const settle = (settleWith: (pending: {
        resolve: (v: any) => void;
        reject: (e: Error) => void;
        timer?: ReturnType<typeof setTimeout>;
      }) => void) => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        if (pending.timer) clearTimeout(pending.timer);
        settleWith(pending);
      };
      if (!this.writeToChild(payload)) {
        settle((pending) => pending.reject(new Error("agent sidecar stdin is unavailable")));
      }
      if (timeoutMs !== undefined) {
        const timer = setTimeout(() => {
          settle((pending) => pending.reject(new Error(`sidecar RPC timeout: ${method}`)));
        }, timeoutMs);
        const pending = this.pending.get(id);
        if (pending) pending.timer = timer;
      }
    });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.projectInstructionRoots.clear();
    this.vendorAuthBindings.clear();
    this.closeTransport(new Error("agent sidecar disposed"));
    this.exitHandlers.clear();
    this.child.kill();
  }
}
