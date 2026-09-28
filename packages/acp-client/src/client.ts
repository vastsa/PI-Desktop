/**
 * ACP client: drives an external agent that speaks the Agent Client Protocol
 * over JSON-RPC on stdio (for example `opencode acp`).
 *
 * The transport is injected so the session/streaming logic can be tested
 * without spawning anything. `spawnAcpProcess` is the real one.
 *
 * Why this exists in the desktop app: the app's own turns all run on pi-ai.
 * An ACP agent is a second, independent backend â€” it owns its own models and
 * its own credentials, and the host only supplies the session surface, the
 * filesystem and the permission prompts.
 */

import { spawn } from "node:child_process"
import type {
  AcpClientCapabilities,
  AcpConfigOption,
  AcpContentBlock,
  AcpInitializeParams,
  AcpInitializeResult,
  AcpListSessionsResult,
  AcpNewSessionParams,
  AcpNewSessionResult,
  AcpPromptParams,
  AcpPromptResult,
  AcpReadTextFileParams,
  AcpReadTextFileResult,
  AcpRequestPermissionParams,
  AcpRequestPermissionResult,
  AcpSessionSummary,
  AcpSessionUpdate,
  AcpSessionUpdateNotification,
  AcpSetConfigOptionParams,
  AcpSetConfigOptionResult,
  AcpWriteTextFileParams,
} from "./types.ts"
import { ACP_PROTOCOL_VERSION } from "./types.ts"
import { resolveAcpExecutable } from "./resolve.ts"

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/** Minimal child-process surface the client needs. */
export type AcpProcessLike = {
  stdin: { write(chunk: string): unknown; end(): unknown } | null
  stdout: { setEncoding(enc: string): void; on(event: "data", cb: (chunk: string) => void): unknown } | null
  stderr: { setEncoding(enc: string): void; on(event: "data", cb: (chunk: string) => void): unknown } | null
  on(event: "exit" | "error", cb: (code: number | null, signal?: string) => void): unknown
  kill(signal?: unknown): unknown
}

export type AcpTransport = {
  send(line: string): void
  onMessage(cb: (line: string) => void): void
  onExit(cb: (info: { code: number | null; signal?: string }) => void): void
  onStderr(cb: (chunk: string) => void): void
  close(): void
}

export type AcpSpawner = () => AcpTransport

/**
 * Spawn an ACP agent. `shell` stays false on purpose: the desktop app passes
 * user-configured command lines through here and must not hand them to a shell.
 */
export function spawnAcpProcess(command: string, args: string[], cwd?: string): AcpTransport {
  // An npm-installed CLI on Windows is a `.cmd` shim that `spawn` cannot run
  // without a shell, so resolve it to the real binary first.
  const resolved = resolveAcpExecutable(command)
  const child: AcpProcessLike = spawn(resolved.command, [...resolved.prefixArgs, ...args], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
    windowsHide: true,
  })
  return {
    send(line) {
      child.stdin?.write(line + "\n")
    },
    onMessage(cb) {
      child.stdout?.setEncoding("utf8")
      child.stdout?.on("data", cb)
    },
    onExit(cb) {
      child.on("exit", (code, signal) => cb({ code, signal }))
    },
    onStderr(cb) {
      child.stderr?.setEncoding("utf8")
      child.stderr?.on("data", cb)
    },
    close() {
      child.kill()
    },
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC plumbing
// ---------------------------------------------------------------------------

type JsonRpcId = number | string

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; method: string }

export class AcpRpcError extends Error {
  code: number
  data?: unknown
  constructor(method: string, code: number, message: string, data?: unknown) {
    super(`${method} failed (${code}): ${message}`)
    this.name = "AcpRpcError"
    this.code = code
    this.data = data
  }
}

export class AcpClosedError extends Error {
  constructor(info: { code: number | null; signal?: string }) {
    super(`ACP agent exited (code=${info.code}${info.signal ? `, signal=${info.signal}` : ""})`)
    this.name = "AcpClosedError"
  }
}

/** Single-consumer async queue used to hand `session/update` events to a turn. */
class AsyncQueue<T> {
  private items: T[] = []
  private closed = false
  private failure: Error | undefined
  private waiter: (() => void) | null = null

  push(item: T) {
    this.items.push(item)
    this.wake()
  }

  close(failure?: Error) {
    if (this.closed) return
    this.closed = true
    this.failure = failure
    this.wake()
  }

  private wake() {
    const w = this.waiter
    this.waiter = null
    w?.()
  }

  async *drain(): AsyncGenerator<T, void, undefined> {
    for (;;) {
      while (this.items.length > 0) yield this.items.shift() as T
      if (this.closed) {
        if (this.failure) throw this.failure
        return
      }
      await new Promise<void>((resolve) => {
        this.waiter = resolve
      })
    }
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export type AcpClientOptions = {
  spawn: AcpSpawner
  /** Name reported to the agent in `initialize`. */
  clientName?: string
  clientVersion?: string
  /** Capabilities advertised in `initialize`. */
  capabilities?: AcpClientCapabilities
  /** Hook for the host's own logging; agent stderr lands here. */
  onStderr?: (chunk: string) => void
  /**
   * Per-request timeout in ms, applied to every request this client makes.
   * `session/prompt` is exempt: a turn legitimately runs for minutes. Omit for
   * no timeout, which suits a CLI but not a long-lived desktop process.
   */
  requestTimeoutMs?: number
  /**
   * When the consumer stops reading a turn before it ends, send
   * `session/cancel` so the agent stops working. Defaults to false: the wire
   * protocol does not tie a consumer's attention span to the turn, and only the
   * host knows whether abandoning a turn means "stop" or "look elsewhere".
   */
  cancelOnEarlyExit?: boolean
}

export type AcpClientHandlers = {
  readTextFile?: (params: AcpReadTextFileParams) => Promise<AcpReadTextFileResult> | AcpReadTextFileResult
  writeTextFile?: (params: AcpWriteTextFileParams) => Promise<void> | void
  requestPermission?: (
    params: AcpRequestPermissionParams,
  ) => Promise<AcpRequestPermissionResult> | AcpRequestPermissionResult
}

export class AcpClient {
  private readonly pending = new Map<JsonRpcId, Pending>()
  private readonly updateListeners = new Set<(n: AcpSessionUpdateNotification) => void>()
  private readonly notificationListeners = new Set<(method: string, params: unknown) => void>()
  private readonly exitListeners = new Set<(info: { code: number | null; signal?: string }) => void>()
  private handlers: AcpClientHandlers = {}
  private nextId = 1
  private lineBuffer = ""
  /**
   * Guard against a runaway agent turning stdout into memory pressure. 8 MiB is
   * far above any legitimate single ACP frame (a large tool result is the
   * biggest realistic one) and well below anything that would hurt the host.
   */
  private static readonly MAX_LINE_BYTES = 8 * 1024 * 1024
  private closedInfo: { code: number | null; signal?: string } | null = null
  private started = false

  private readonly options: AcpClientOptions
  private readonly transport: AcpTransport

  constructor(options: AcpClientOptions) {
    this.options = options
    this.transport = options.spawn()
  }

  // -- lifecycle ------------------------------------------------------------

  /**
   * Spawn-safe setup: wire the transport and run `initialize`. Safe to call
   * once per client; a second call is a no-op.
   */
  async initialize(): Promise<AcpInitializeResult> {
    if (this.started) throw new Error("AcpClient.initialize called twice")
    this.started = true
    this.transport.onMessage((chunk) => this.onData(chunk))
    this.transport.onExit((info) => this.onExit(info))
    this.transport.onStderr((chunk) => this.options.onStderr?.(chunk))

    const params: AcpInitializeParams = {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: this.options.capabilities ?? {
        readTextFile: false,
        writeTextFile: false,
      },
      clientInfo: { name: this.options.clientName ?? "pi-desktop", version: this.options.clientVersion },
    }
    const result = (await this.request("initialize", params)) as AcpInitializeResult
    this.initializeResult = result
    // A future agent that speaks a different major version may answer, and
    // silently proceeding would surface much later as odd event shapes.
    if (typeof result.protocolVersion === "number" && result.protocolVersion !== ACP_PROTOCOL_VERSION) {
      throw new AcpRpcError(
        "initialize",
        -32602,
        `agent negotiated protocol v${result.protocolVersion}, this client speaks v${ACP_PROTOCOL_VERSION}`,
      )
    }
    return result
  }

  /** Which agent we ended up talking to, for logs and settings screens. */
  agentName(): string {
    return this.initializeResult?.agentInfo?.name ?? "unknown"
  }

  private initializeResult: AcpInitializeResult | undefined

  onExitInfo(): { code: number | null; signal?: string } | null {
    return this.closedInfo
  }

  /**
   * Observe the agent process going away. Hosts need this to take a session
   * offline instead of leaving a turn that will never answer.
   */
  onProcessExit(cb: (info: { code: number | null; signal?: string }) => void): () => void {
    this.exitListeners.add(cb)
    // A caller that subscribes after the process died still gets told.
    if (this.closedInfo) cb(this.closedInfo)
    return () => this.exitListeners.delete(cb)
  }

  close() {
    this.transport.close()
  }

  // -- events ---------------------------------------------------------------

  onSessionUpdate(cb: (n: AcpSessionUpdateNotification) => void): () => void {
    this.updateListeners.add(cb)
    return () => this.updateListeners.delete(cb)
  }

  onNotification(cb: (method: string, params: unknown) => void): () => void {
    this.notificationListeners.add(cb)
    return () => this.notificationListeners.delete(cb)
  }

  /** Install the host-side implementations the agent may call into. */
  setHandlers(handlers: AcpClientHandlers) {
    this.handlers = handlers
  }

  // -- requests -------------------------------------------------------------

  async authenticate(methodId: string): Promise<unknown> {
    return this.request("authenticate", { methodId })
  }

  async newSession(params: AcpNewSessionParams): Promise<AcpNewSessionResult> {
    return (await this.request("session/new", params)) as AcpNewSessionResult
  }

  async listSessions(): Promise<AcpSessionSummary[]> {
    const res = (await this.request("session/list", {})) as AcpListSessionsResult
    return res.sessions ?? []
  }

  async loadSession(sessionId: string, cwd?: string): Promise<unknown> {
    return this.request("session/load", cwd ? { sessionId, cwd } : { sessionId })
  }

  async resumeSession(sessionId: string): Promise<unknown> {
    return this.request("session/resume", { sessionId })
  }

  async closeSession(sessionId: string): Promise<unknown> {
    return this.request("session/close", { sessionId })
  }

  /**
   * Switch a session setting â€” in practice the model. The agent's parameter is
   * `configId`; sending `optionId` gets `-32602 Invalid params`.
   */
  async setConfigOption(params: AcpSetConfigOptionParams): Promise<AcpConfigOption[]> {
    const res = (await this.request("session/set_config_option", params)) as AcpSetConfigOptionResult
    return res.configOptions ?? []
  }

  /**
   * The model id a session is currently on, from options the agent already gave
   * us. There is no read-only counterpart to `setConfigOption` on the wire, so
   * this never sends a request: pass the `configOptions` that `newSession` or
   * `setConfigOption` returned.
   */
  static currentModel(options: readonly AcpConfigOption[] | undefined): string | undefined {
    return options?.find((o) => o.category === "model" || o.id === "model")?.currentValue
  }

  /**
   * Send a prompt and yield every `session/update` the agent emits.
   *
   * The generator's return value is the agent's own turn result — `stopReason`
   * and usage — which the caller needs to close a turn out correctly. It ends
   * when the agent answers and throws if the turn failed. Abandoning it early
   * yields `undefined`, since there is no result to report.
   */
  async *prompt(params: AcpPromptParams): AsyncGenerator<AcpSessionUpdate, AcpPromptResult | undefined, undefined> {
    const queue = new AsyncQueue<AcpSessionUpdate>()
    const off = this.onSessionUpdate((n) => {
      if (n.sessionId === params.sessionId) queue.push(n.update)
    })

    let result: AcpPromptResult | undefined
    const turn = this.requestTurn("session/prompt", params)
      .then((res) => {
        result = res as AcpPromptResult
        queue.close()
      })
      .catch((err: unknown) => {
        queue.close(err instanceof Error ? err : new Error(String(err)))
        throw err
      })

    let consumedToEnd = false
    try {
      for await (const update of queue.drain()) yield update
      consumedToEnd = true
      return result
    } finally {
      off()
      // A turn the consumer walked away from is still running on the agent's
      // side; leave it billing unless the consumer is allowed to cancel.
      if (!consumedToEnd && this.options.cancelOnEarlyExit && !this.closedInfo) {
        void this.cancel(params.sessionId).catch(() => undefined)
      }
      // Swallow a late rejection so an abandoned turn cannot become an
      // unhandled rejection after the consumer already moved on.
      turn.catch(() => undefined)
    }
  }

  /**
   * Stop the in-flight turn.
   *
   * ACP defines `session/cancel` as a notification, so this resolves as soon
   * as the frame is written — it is not an acknowledgement. The turn itself
   * ends when the pending `session/prompt` answers with a `stopReason`.
   */
  async cancel(sessionId: string): Promise<void> {
    if (this.closedInfo) return
    this.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } })
  }

  // -- internals ------------------------------------------------------------

  private send(obj: unknown) {
    this.transport.send(JSON.stringify(obj))
  }

  request(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    if (this.closedInfo) return Promise.reject(new AcpClosedError(this.closedInfo))
    const id = this.nextId++
    return new Promise<unknown>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const settle = (fn: () => void) => {
        if (timer) clearTimeout(timer)
        fn()
      }
      if (timeoutMs && timeoutMs > 0) {
        const handle = setTimeout(() => {
          this.pending.delete(id)
          settle(() => reject(new AcpRpcError(method, -32000, `no response within ${timeoutMs}ms`)))
        }, timeoutMs)
        timer = handle
        // A pending request must not hold the process open on its own.
        handle.unref?.()
      }
      this.pending.set(id, {
        resolve: (v) => settle(() => resolve(v)),
        reject: (e) => settle(() => reject(e)),
        method,
      })
      this.send({ jsonrpc: "2.0", id, method, params })
    })
  }

  /** Turn requests are long-lived by nature and must not inherit the timeout. */
  private requestTurn(method: string, params: unknown): Promise<unknown> {
    return this.request(method, params, 0)
  }

  private onData(chunk: string) {
    this.lineBuffer += chunk
    for (;;) {
      const idx = this.lineBuffer.indexOf("\n")
      if (idx === -1) {
        if (this.lineBuffer.length > AcpClient.MAX_LINE_BYTES) {
          // Refuse to keep buffering. The agent is misbehaving; failing loudly
          // beats an unbounded string in the desktop process.
          this.close()
        }
        return
      }
      const line = this.lineBuffer.slice(0, idx).trim()
      this.lineBuffer = this.lineBuffer.slice(idx + 1)
      if (!line) continue
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(line)
      } catch {
        continue // agents can print banners on stdout; ignore non-JSON lines
      }
      void this.route(msg)
    }
  }

  private async route(msg: Record<string, unknown>) {
    const id = msg.id as JsonRpcId | undefined
    const method = msg.method as string | undefined

    if (id !== undefined && method !== undefined) {
      await this.handleAgentRequest(id, method, msg.params)
      return
    }
    if (method !== undefined) {
      if (method === "session/update") {
        const n = msg.params as AcpSessionUpdateNotification
        for (const cb of [...this.updateListeners]) cb(n)
      } else {
        for (const cb of [...this.notificationListeners]) cb(method, msg.params)
      }
      return
    }
    if (id !== undefined) {
      const entry = this.pending.get(id)
      if (!entry) return
      this.pending.delete(id)
      if (msg.error) {
        const e = msg.error as { code?: number; message?: string; data?: unknown }
        entry.reject(new AcpRpcError(entry.method, e.code ?? -32603, e.message ?? "unknown error", e.data))
      } else {
        entry.resolve(msg.result)
      }
    }
  }

  /** The agent calling back into the host: filesystem and permission prompts. */
  private async handleAgentRequest(id: JsonRpcId, method: string, params: unknown) {
    const respond = (result: unknown) => this.send({ jsonrpc: "2.0", id, result })
    const fail = (code: number, message: string) => this.send({ jsonrpc: "2.0", id, error: { code, message } })

    try {
      switch (method) {
        case "session/request_permission": {
          const handler = this.handlers.requestPermission
          if (!handler) return fail(-32601, "pi-desktop does not handle session/request_permission")
          respond(await handler(params as AcpRequestPermissionParams))
          return
        }
        case "fs/read_text_file": {
          const handler = this.handlers.readTextFile
          if (!handler) return fail(-32601, "pi-desktop does not handle fs/read_text_file")
          respond(await handler(params as AcpReadTextFileParams))
          return
        }
        case "fs/write_text_file": {
          const handler = this.handlers.writeTextFile
          if (!handler) return fail(-32601, "pi-desktop does not handle fs/write_text_file")
          await handler(params as AcpWriteTextFileParams)
          respond({})
          return
        }
        default:
          return fail(-32601, `pi-desktop does not handle ${method}`)
      }
    } catch (err) {
      fail(-32603, err instanceof Error ? err.message : String(err))
    }
  }

  private onExit(info: { code: number | null; signal?: string }) {
    this.closedInfo = info
    for (const cb of [...this.exitListeners]) cb(info)
    const err = new AcpClosedError(info)
    for (const [, entry] of this.pending) entry.reject(err)
    this.pending.clear()
  }
}





