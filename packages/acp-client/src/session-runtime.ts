/**
 * A desktop session whose turns are executed by an external ACP agent.
 *
 * This is the counterpart to `DesktopAgentRuntime`: same control surface, same
 * normalized output contract, but the work is done by somebody else's program.
 * That means the session owns an agent process and an external session id, and
 * that the agent â€” not the host â€” decides the model, the provider and the
 * prompt assembly.
 *
 * Two things this deliberately does not do:
 *
 * - It does not restate the agent's identity. The `User-Agent`,
 *   `x-opencode-client` and `x-opencode-session` headers belong to the agent;
 *   the host only sends its own for its own requests.
 * - It does not synthesise host features the agent has no equivalent for. There
 *   is no manual compaction, no approved-plan execution and no steering; the
 *   status reports that rather than pretending.
 */

import type { AgentEventEnvelope, AgentStatus, Mode } from "@pi-desktop/shared"

import { AcpClient, spawnAcpProcess } from "./client.ts"
import { AcpEventTranslator } from "./translate.ts"
import type { AcpConfigOption, AcpContentBlock, AcpPromptResult } from "./types.ts"

export type AcpAgentConfig = {
  /** Executable name or path, e.g. `opencode`. */
  command: string
  args: string[]
  /** Working directory the agent session is scoped to. */
  cwd: string
  /**
   * Model to select once the session is open. Agents advertise their picker in
   * `session/new`; this is the `configId: "model"` value.
   */
  modelId?: string
  /** Client name reported in `initialize`. */
  clientName?: string
  clientVersion?: string
  /** Stderr sink. Agent diagnostics are noisy and unauthenticated. */
  onStderr?: (chunk: string) => void
}

export type AcpRuntimeHooks = {
  /**
   * Where normalized events go. In the sidecar this is `notify("agent.event", …)`.
   * Events must reach the durable pipeline as they happen: buffering a whole
   * turn would lose everything if the agent died mid-turn.
   */
  emit: (envelope: AgentEventEnvelope) => void
  /**
   * Answer an agent permission request. The host owns the approval UI, so the
   * agent cannot decide this itself. Return the chosen option id.
   */
  requestPermission: (params: {
    sessionId: string
    toolCall: { toolCallId: string; title?: string; kind?: string }
    options: { optionId: string; name: string; kind: string }[]
  }) => Promise<string | undefined>
  /**
   * Read a file on the agent's behalf. Routed through the host so the existing
   * containment and audit rules still apply; the sidecar does not read the
   * user's disk directly.
   */
  readTextFile?: (path: string) => Promise<string>
  writeTextFile?: (path: string, content: string) => Promise<void>
}

export type AcpSessionRuntimeOptions = AcpAgentConfig & {
  /** The host's durable session id. This is what the UI and ledger know. */
  sessionId: string
  hooks: AcpRuntimeHooks
  /** Injection seam for tests. */
  client?: AcpClient
}

export class AcpSessionRuntime {
  readonly sessionId: string

  private readonly options: AcpSessionRuntimeOptions
  private readonly client: AcpClient
  /**
   * Built up front and re-pointed per turn. A translator has to exist before
   * the first turn so that anything the agent leaves open is still closable,
   * even if the session fails during `initialize`.
   */
  private readonly translator: AcpEventTranslator

  /** The agent's own session id, mapped to our durable one. */
  private externalSessionId: string | undefined
  private configOptions: AcpConfigOption[] = []
  private currentTurnId: string | undefined
  private running = false
  private disposed = false
  private offline: { code: number | null; signal?: string } | undefined

  constructor(options: AcpSessionRuntimeOptions) {
    this.options = options
    this.sessionId = options.sessionId
    this.translator = new AcpEventTranslator({ sessionId: options.sessionId })
    this.client =
      options.client ??
      new AcpClient({
        spawn: () => spawnAcpProcess(options.command, options.args, options.cwd),
        clientName: options.clientName ?? "pi-desktop",
        clientVersion: options.clientVersion,
        capabilities: {
          readTextFile: Boolean(options.hooks.readTextFile),
          writeTextFile: Boolean(options.hooks.writeTextFile),
        },
        // A desktop process must not hang on a wedged agent, but a turn may run
        // for minutes, so only the control calls are bounded.
        requestTimeoutMs: 30_000,
        onStderr: options.onStderr,
      })

    this.client.setHandlers({
      requestPermission: async (params) => {
        const optionId = await options.hooks.requestPermission({
          sessionId: params.sessionId,
          toolCall: { toolCallId: params.toolCall.toolCallId, title: params.toolCall.title, kind: params.toolCall.kind },
          options: params.options,
        })
        return optionId
          ? { outcome: { outcome: "selected" as const, optionId } }
          : { outcome: { outcome: "cancelled" as const } }
      },
      ...(options.hooks.readTextFile
        ? { readTextFile: (p) => options.hooks.readTextFile!(p.path).then((content) => ({ content })) }
        : {}),
      ...(options.hooks.writeTextFile
        ? { writeTextFile: (p) => options.hooks.writeTextFile!(p.path, p.content) }
        : {}),
    })

    this.client.onProcessExit((info) => {
      this.offline = info
    })
  }

  // -- session lifecycle ----------------------------------------------------

  /**
   * Spawn the agent, negotiate, and open an external session.
   *
   * Called lazily on first use so starting a chat does not immediately cost a
   * process. Safe to call repeatedly: the session is opened once.
   */
  async ensureSession(): Promise<void> {
    if (this.externalSessionId) return

    await this.client.initialize()
    const session = await this.client.newSession({ cwd: this.options.cwd, mcpServers: [] })
    this.externalSessionId = session.sessionId
    this.configOptions = session.configOptions ?? []

    if (this.options.modelId) {
      this.configOptions = await this.client.setConfigOption({
        sessionId: session.sessionId,
        configId: "model",
        value: this.options.modelId,
      })
    }
  }

  /** The model the agent is on, as reported in its own config options. */
  currentModel(): string | undefined {
    return AcpClient.currentModel(this.configOptions)
  }

  /** The full picker the agent advertised, for the composer's model menu. */
  availableModels(): { value: string; name?: string; description?: string }[] {
    return this.configOptions.find((o) => o.category === "model")?.options ?? []
  }

  // -- turns ----------------------------------------------------------------

  /**
   * Run one turn. Resolves as soon as the turn is admitted, matching the pi
   * runtime's contract; the work continues in the background and reports
   * through `hooks.emit`.
   */
  async prompt(text: string, turnId: string): Promise<{ turnId: string }> {
    if (this.disposed) throw new Error("ACP session runtime is disposed")
    await this.ensureSession()

    const external = this.externalSessionId as string
    this.currentTurnId = turnId
    this.running = true
    // One translator per session, re-pointed per turn: keeping it alive across
    // turns is what lets `finish` close anything the agent left open.
    this.translator.setTurnId(turnId)

    const blocks: AcpContentBlock[] = [{ type: "text", text }]
    void this.runTurn(blocks)
    return { turnId }
  }

  private async runTurn(blocks: AcpContentBlock[]): Promise<void> {
    const translator = this.translator
    const emit = this.options.hooks.emit
    const external = this.externalSessionId as string
    let result: AcpPromptResult | undefined
    let failure: { code: string; message: string } | undefined

    try {
      const stream = this.client.prompt({ sessionId: external, prompt: blocks })
      for (;;) {
        const step = await stream.next()
        if (step.done) {
          result = step.value
          break
        }
        for (const envelope of translator.translate({ sessionId: external, update: step.value })) {
          emit(envelope)
        }
      }
    } catch (err) {
      const code = (err as { code?: number } | undefined)?.code
      failure = {
        code: code !== undefined ? String(code) : "ACP_TURN_FAILED",
        message: err instanceof Error ? err.message : String(err),
      }
    }

    for (const envelope of translator.finish(result, failure)) emit(envelope)
    this.running = false
    this.currentTurnId = undefined
  }

  /**
   * Stop the turn. ACP's `session/cancel` is a notification, so this does not
   * wait for the agent to acknowledge â€” the turn still ends when the pending
   * prompt answers.
   */
  async abort(): Promise<void> {
    if (this.externalSessionId && this.running) {
      await this.client.cancel(this.externalSessionId)
    }
  }

  /**
   * The pi runtime stops at a turn boundary; ACP has no such hook. Reporting
   * "not requested" is honest, where faking a stop would leave the user
   * watching a turn they think they ended.
   */
  requestGracefulStop(): { requested: boolean } {
    return { requested: false }
  }

  getStatus(): AgentStatus {
    return {
      sessionId: this.sessionId,
      isRunning: this.running,
      ...(this.currentTurnId ? { currentTurnId: this.currentTurnId } : {}),
      ...(this.currentModel() ? { modelId: this.currentModel() } : {}),
      pendingToolConfirmations: 0,
    }
  }

  /** True once the agent process is gone; the UI shows this as offline. */
  isOffline(): boolean {
    return this.offline !== undefined
  }

  /**
   * The configuration this runtime was built with. A host that wants to reuse
   * the session has to be able to tell whether the agent definition still
   * matches what was launched.
   */
  config(): { command: string; args: string[]; cwd: string; modelId?: string } {
    return {
      command: this.options.command,
      args: this.options.args,
      cwd: this.options.cwd,
      ...(this.options.modelId ? { modelId: this.options.modelId } : {}),
    }
  }

  /**
   * The agent's own session id, once a session has been opened. Kept separate
   * from ours: a restart of the sidecar loses ours but not the agent's.
   */
  getExternalSessionId(): string | undefined {
    return this.externalSessionId
  }

  getMode(): Mode {
    // Modes are a pi-agent concept (permission tiers the host enforces). An
    // external agent enforces its own, so the session reports the default.
    return "default" as Mode
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    if (this.externalSessionId) {
      await this.client.closeSession(this.externalSessionId).catch(() => undefined)
    }
    this.client.close()
    this.externalSessionId = undefined
  }
}

