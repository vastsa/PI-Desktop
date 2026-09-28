/**
 * ACP → PI-Desktop event translation.
 *
 * The desktop renderer only ever consumes normalized `AgentEvent`s; it has no
 * concept of an external agent. So everything ACP sends is folded into that
 * contract here, immediately below the sidecar boundary. An ACP object must
 * never reach main or the renderer — that would bypass the durable event
 * pipeline, and a transcript row that is only written at the end of a turn is
 * exactly what the pipeline exists to prevent.
 *
 * The hard part is that ACP streams *deltas* while `AgentEvent` wants a
 * snapshot on `message_start` and append-only text on `message_update`. The
 * accumulator below is therefore stateful: it has to remember what it has
 * already emitted, keyed by the agent's own ids.
 *
 * Unknown `sessionUpdate` values are ignored, not fatal. Agents add variants,
 * and a turn that dies on an unrecognised block is worse than a transcript
 * that is missing one.
 */

import type { AgentEvent, AgentEventEnvelope, AppError, MessageUsage, UiMessage } from "@pi-desktop/shared"
import type {
  AcpAgentMessageChunk,
  AcpAgentThoughtChunk,
  AcpPlanUpdate,
  AcpPromptResult,
  AcpPromptUsage,
  AcpSessionUpdate,
  AcpSessionUpdateNotification,
  AcpToolCallUpdate,
} from "./types.ts"

export type AcpTranslatorOptions = {
  /** The host's durable session id. Emitted on every envelope. */
  sessionId: string
  /** The host's turn id, once the turn has been admitted. */
  turnId?: string
  /** Clock injection keeps timestamps testable. */
  now?: () => number
  /** Reported on assistant rows so the UI can name the producer. */
  modelId?: string
  providerId?: string
}

type OpenMessage = {
  id: string
  role: "assistant"
  text: string
  thinking: string
  createdAt: string
}

const textOf = (block: unknown): string => {
  const b = block as { type?: string; text?: string } | null
  if (!b) return ""
  if (b.type === "text" || b.type === "image") return b.text ?? ""
  if (b.type === "resource") return (b as { resource?: { text?: string } }).resource?.text ?? ""
  return ""
}

/** ACP's own ids are not always populated; the transcript still needs stable ones. */
let fallbackSeq = 0
const fallbackId = (prefix: string) => `${prefix}_acp_${++fallbackSeq}`

export class AcpEventTranslator {
  private options: AcpTranslatorOptions
  private readonly now: () => number

  /** assistant message currently streaming, by ACP messageId */
  private readonly openMessages = new Map<string, OpenMessage>()
  /** active assistant message when the agent omits a messageId */
  private current: OpenMessage | undefined
  /** tool calls already announced, so `tool_update` does not re-open them */
  private readonly openTools = new Map<string, { name: string; args: unknown }>()
  private readonly completedMessages: string[] = []

  constructor(options: AcpTranslatorOptions) {
    this.options = options
    this.now = options.now ?? Date.now
  }

  /** Re-point the envelopes at a new turn. The host assigns one per prompt. */
  setTurnId(turnId: string | undefined) {
    this.options = { ...this.options, turnId }
  }

  /**
   * Fold one ACP notification into zero or more desktop events.
   *
   * Returns an array because a single ACP update can be meaningful in more
   * than one way (a finishing tool call closes a tool row and, on the last
   * one, ends the turn).
   */
  translate(notification: AcpSessionUpdateNotification): AgentEventEnvelope[] {
    const out: AgentEventEnvelope[] = []
    const push = (event: AgentEvent) => out.push(this.envelope(event))
    const update = notification.update

    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        if (isAssistantChunk(update)) this.assistantChunk(push, update, "text")
        break

      case "agent_thought_chunk":
        if (isAssistantChunk(update)) this.assistantChunk(push, update, "thinking")
        break

      case "tool_call":
      case "tool_call_update":
        if (isToolCallUpdate(update)) this.toolUpdate(push, update)
        break

      case "plan":
        if (isPlanUpdate(update)) this.planChunk(push, update)
        break

      case "usage_update":
      case "available_commands_update":
      case "current_mode_update":
        // No lossless `AgentEvent` variant exists for these yet. They are
        // observational; dropping them is better than inventing a mapping the
        // renderer would have to special-case.
        break

      default:
        break
    }

    return out
  }

  /**
   * Close the turn out. The agent's own result is used where it exists: a
   * refusal is an error, and everything else is a normal end.
   */
  finish(result?: AcpPromptResult, error?: AppError): AgentEventEnvelope[] {
    const out: AgentEventEnvelope[] = []
    const push = (event: AgentEvent) => out.push(this.envelope(event))
    const usage = toMessageUsage(result?.usage)

    // Any message still streaming has to be closed or the transcript keeps a
    // row stuck in "streaming" forever. Usage lands on the last row, which is
    // the one the turn is billed to.
    const drained = [...this.drainOpenMessages()]
    if (usage && drained.length > 0) {
      const last = drained[drained.length - 1]
      if (last.type === "message_end") last.message = { ...last.message, usage }
    }
    for (const event of drained) push(event)

    for (const toolCallId of this.openTools.keys()) {
      push({ type: "tool_end", toolCallId, result: null, isError: true })
    }
    this.openTools.clear()

    if (error) {
      push({ type: "error", error })
    } else if (result && isRefusal(result.stopReason)) {
      push({ type: "error", error: { code: "refusal", message: `agent stopped: ${result.stopReason}` } })
    }

    push({ type: "turn_end" })
    push({ type: "agent_end", messageIds: [...this.completedMessages] })
    return out
  }

  // -- internals ------------------------------------------------------------

  private envelope(event: AgentEvent): AgentEventEnvelope {
    return {
      sessionId: this.options.sessionId,
      turnId: this.options.turnId,
      ts: this.now(),
      event,
    }
  }

  /**
   * `messageId` lives on the update, not on the content block. Reading it off
   * the block meant every chunk looked like a new message, so one reply became
   * one transcript row per chunk.
   */
  private assistantChunk(
    push: (e: AgentEvent) => void,
    update: AcpAgentMessageChunk | AcpAgentThoughtChunk,
    channel: "text" | "thinking",
  ) {
    const text = (update.content as { text?: string } | undefined)?.text ?? ""
    if (!text) return

    const key = "messageId" in update ? update.messageId : undefined
    let open = key ? this.openMessages.get(key) : this.current
    if (!open) {
      open = {
        id: key ?? fallbackId("msg"),
        role: "assistant",
        text: "",
        thinking: "",
        createdAt: new Date(this.now()).toISOString(),
      }
      // Always registered, keyed by the id we will emit. An agent that omits
      // `messageId` still gets a tracked message, so `finish` can close it
      // instead of leaving a transcript row stuck in "streaming".
      this.openMessages.set(open.id, open)
      this.current = open
      // The snapshot opens empty; the first chunk arrives as a delta, so the
      // renderer applies it exactly once and a consumer that only ever sees
      // `message_start` is not misled into thinking the reply is blank.
      push({
        type: "message_start",
        message: this.snapshot(open),
      })
    }

    if (channel === "text") open.text += text
    else open.thinking += text

    // Append-only: the renderer applies this onto the live row.
    push({
      type: "message_update",
      message: this.snapshot(open),
      stream: "delta",
      ...(channel === "text" ? { deltaText: text } : { deltaThinking: text }),
    })
  }

  private toolUpdate(push: (e: AgentEvent) => void, update: AcpToolCallUpdate) {
    const id = update.toolCallId || fallbackId("tool")

    if (!this.openTools.has(id)) {
      this.openTools.set(id, { name: update.title ?? id, args: update.rawInput })
      push({
        type: "tool_start",
        toolCallId: id,
        toolName: update.title ?? id,
        args: update.rawInput ?? null,
      })
    }

    if (update.status === "completed" || update.status === "failed") {
      this.openTools.delete(id)
      push({
        type: "tool_end",
        toolCallId: id,
        result: update.rawOutput ?? contentToText(update.content) ?? null,
        isError: update.status === "failed",
      })
    } else if (update.sessionUpdate === "tool_call_update") {
      push({
        type: "tool_update",
        toolCallId: id,
        ...(update.content ? { partialResult: contentToText(update.content) } : {}),
      })
    }
  }

  /**
   * `planning_state` describes a host-owned plan *proposal* — a thing the app
   * negotiates with the user and then executes. An ACP `plan` is the agent
   * narrating what it is about to do, which is a different thing with a
   * different shape, and forcing it into that event would fabricate a
   * proposal the host never made.
   *
   * So a plan is rendered as assistant content instead: visible in the
   * transcript, honest about its origin, and it does not invent a proposal
   * the approval flow would then act on. Mapping it onto the real planning UI
   * is open work.
   */
  private planChunk(push: (e: AgentEvent) => void, update: AcpPlanUpdate) {
    const lines = (update.entries ?? [])
      .map((e) => `- [${checkbox(e.status)}] ${e.content}`)
      .join("\n")
    if (!lines) return
    this.assistantChunk(
      push,
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `${lines}\n` } },
      "text",
    )
  }

  private snapshot(open: OpenMessage): UiMessage {
    return {
      id: open.id,
      role: "assistant",
      content: open.text,
      thinking: open.thinking || undefined,
      createdAt: open.createdAt,
      status: "streaming",
      ...(this.options.modelId ? { modelId: this.options.modelId } : {}),
      ...(this.options.providerId ? { providerId: this.options.providerId } : {}),
    }
  }

  private *drainOpenMessages(): Generator<AgentEvent> {
    for (const [key, open] of [...this.openMessages]) {
      this.openMessages.delete(key)
      this.completedMessages.push(open.id)
      yield {
        type: "message_end",
        message: { ...this.snapshot(open), status: "complete" },
      }
    }
    this.current = undefined
  }
}

function contentToText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined
  const text = content.map(textOf).filter(Boolean).join("\n")
  return text || undefined
}

/**
 * `AcpSessionUpdate` keeps an open variant so a future agent block does not
 * break compilation, which means the switch alone cannot narrow. These guards
 * put the narrowing back without giving up forward compatibility.
 */
function isAssistantChunk(
  update: AcpSessionUpdate,
): update is AcpAgentMessageChunk | AcpAgentThoughtChunk {
  return (
    (update.sessionUpdate === "agent_message_chunk" || update.sessionUpdate === "agent_thought_chunk") &&
    typeof (update as { content?: unknown }).content === "object" &&
    (update as { content?: unknown }).content !== null
  )
}

function isToolCallUpdate(update: AcpSessionUpdate): update is AcpToolCallUpdate {
  return (
    (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") &&
    typeof (update as AcpToolCallUpdate).toolCallId === "string"
  )
}

function isPlanUpdate(update: AcpSessionUpdate): update is AcpPlanUpdate {
  return update.sessionUpdate === "plan" && Array.isArray((update as AcpPlanUpdate).entries)
}

function isRefusal(stopReason: string | undefined): boolean {
  return stopReason === "refusal" || stopReason === "cancelled"
}

function checkbox(status: string | undefined): string {
  if (!status) return " "
  if (/done|complete|completed/i.test(status)) return "x"
  if (/progress|in_progress|running/i.test(status)) return "~"
  return " "
}

/** ACP usage and the desktop's `MessageUsage` line up field for field. */
function toMessageUsage(usage: AcpPromptUsage | undefined): MessageUsage | undefined {
  if (!usage) return undefined
  return {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    totalTokens: usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
    ...(usage.cachedReadTokens !== undefined ? { cacheReadTokens: usage.cachedReadTokens } : {}),
    ...(usage.cachedWriteTokens !== undefined ? { cacheWriteTokens: usage.cachedWriteTokens } : {}),
    ...(usage.thoughtTokens !== undefined ? { reasoningTokens: usage.thoughtTokens } : {}),
  }
}
