/**
 * Agent Client Protocol (ACP) wire types.
 *
 * These are the shapes the desktop app actually has to speak. They were taken
 * from a live `opencode acp` handshake rather than from the protocol draft, so
 * field names here match what a real agent emits — including the one that is
 * easy to get wrong: session config is written with `configId`, not
 * `optionId`, and the agent answers `-32602 Invalid params` if you use the
 * draft's spelling.
 *
 * @see https://agentclientprotocol.com
 */

export const ACP_PROTOCOL_VERSION = 1

// ---------------------------------------------------------------------------
// Content blocks
// ---------------------------------------------------------------------------

export type AcpTextContent = { type: "text"; text: string }

export type AcpImageContent = {
  type: "image"
  mimeType: string
  data: string
}

export type AcpResourceContent = {
  type: "resource"
  resource: { uri: string; mimeType?: string; text?: string; blob?: string }
}

export type AcpContentBlock = AcpTextContent | AcpImageContent | AcpResourceContent

// ---------------------------------------------------------------------------
// Client capabilities (what we offer the agent)
// ---------------------------------------------------------------------------

export type AcpClientCapabilities = {
  /** `true` when the host implements `fs/read_text_file`. */
  readTextFile?: boolean
  /** `true` when the host implements `fs/write_text_file`. */
  writeTextFile?: boolean
  /** Terminal support is opt-in; the desktop host does not expose one yet. */
  terminal?: boolean
}

// ---------------------------------------------------------------------------
// initialize
// ---------------------------------------------------------------------------

export type AcpInitializeParams = {
  protocolVersion: number
  clientCapabilities?: AcpClientCapabilities
  clientInfo?: { name: string; version?: string }
}

export type AcpSessionCapabilities = {
  loadSession?: boolean
  close?: unknown
  delete?: unknown
  fork?: unknown
  list?: unknown
  resume?: unknown
}

export type AcpAgentCapabilities = {
  loadSession?: boolean
  promptCapabilities?: { image?: boolean; audio?: boolean; embeddedContext?: boolean }
  mcpCapabilities?: { http?: boolean; sse?: boolean }
  sessionCapabilities?: AcpSessionCapabilities
  _meta?: Record<string, unknown>
}

export type AcpAuthMethod = { id: string; name: string; description?: string }

export type AcpInitializeResult = {
  protocolVersion: number
  agentCapabilities?: AcpAgentCapabilities
  authMethods?: AcpAuthMethod[]
  agentInfo?: { name: string; version?: string }
  _meta?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Session config options (model picker, modes, ...)
// ---------------------------------------------------------------------------

export type AcpConfigOptionValue = { value: string; name?: string; description?: string }

export type AcpConfigOption = {
  id: string
  name?: string
  category?: "model" | "mode" | string
  type?: "select" | string
  currentValue?: string
  options?: AcpConfigOptionValue[]
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export type AcpNewSessionParams = { cwd: string; mcpServers?: unknown[] }

export type AcpNewSessionResult = { sessionId: string; configOptions?: AcpConfigOption[]; _meta?: unknown }

export type AcpSessionSummary = { sessionId: string; title?: string; updatedAt?: string; _meta?: unknown }

export type AcpListSessionsResult = { sessions: AcpSessionSummary[] }

export type AcpSetConfigOptionParams = {
  sessionId: string
  /** Not `optionId` — the agent rejects that spelling. */
  configId: string
  value: string
}

export type AcpSetConfigOptionResult = { configOptions?: AcpConfigOption[] }

// ---------------------------------------------------------------------------
// Prompt / streaming updates
// ---------------------------------------------------------------------------

export type AcpToolCallUpdate = {
  sessionUpdate: "tool_call" | "tool_call_update"
  toolCallId: string
  title?: string
  kind?: string
  status?: "pending" | "in_progress" | "completed" | "failed"
  content?: AcpContentBlock[]
  locations?: { path: string; line?: number }[]
  rawInput?: unknown
  rawOutput?: unknown
}

export type AcpAgentMessageChunk = {
  sessionUpdate: "agent_message_chunk"
  messageId?: string
  content: AcpContentBlock
}

export type AcpAgentThoughtChunk = {
  sessionUpdate: "agent_thought_chunk"
  content: AcpContentBlock
}

export type AcpPlanEntry = { content: string; priority?: "high" | "medium" | "low"; status?: string }

export type AcpPlanUpdate = {
  sessionUpdate: "plan"
  entries: AcpPlanEntry[]
}

export type AcpUsageUpdate = {
  sessionUpdate: "usage_update"
  used?: number
  size?: number
  cost?: { amount: number; currency: string }
}

export type AcpAvailableCommandsUpdate = {
  sessionUpdate: "available_commands_update"
  availableCommands: { name: string; description?: string; input?: unknown }[]
}

export type AcpCurrentModeUpdate = { sessionUpdate: "current_mode_update"; currentModeId: string }

export type AcpSessionUpdate =
  | AcpAgentMessageChunk
  | AcpAgentThoughtChunk
  | AcpToolCallUpdate
  | AcpPlanUpdate
  | AcpUsageUpdate
  | AcpAvailableCommandsUpdate
  | AcpCurrentModeUpdate
  | { sessionUpdate: string; [key: string]: unknown }

export type AcpSessionUpdateNotification = {
  sessionId: string
  update: AcpSessionUpdate
}

export type AcpPromptParams = { sessionId: string; prompt: AcpContentBlock[] }

export type AcpStopReason = "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled" | string

export type AcpPromptUsage = {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  cachedReadTokens?: number
  cachedWriteTokens?: number
  thoughtTokens?: number
}

export type AcpPromptResult = { stopReason: AcpStopReason; usage?: AcpPromptUsage; _meta?: unknown }

// ---------------------------------------------------------------------------
// Agent -> client calls
// ---------------------------------------------------------------------------

export type AcpPermissionOption = {
  optionId: string
  name: string
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always" | string
}

export type AcpRequestPermissionParams = {
  sessionId: string
  toolCall: AcpToolCallUpdate
  options: AcpPermissionOption[]
}

export type AcpRequestPermissionResult = {
  outcome: { outcome: "selected"; optionId: string } | { outcome: "cancelled" }
}

export type AcpReadTextFileParams = { sessionId?: string; path: string; line?: number; limit?: number }

export type AcpReadTextFileResult = { content: string }

export type AcpWriteTextFileParams = { sessionId?: string; path: string; content: string }

export type AcpWriteTextFileResult = Record<string, never>
