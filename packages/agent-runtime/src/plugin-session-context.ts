/**
 * Bounded, compaction-aware projection of a session transcript for plugins.
 *
 * Plugins never receive the raw UiMessage dump: subagent rows are omitted, an
 * in-flight call of the plugin's own tool is stripped, compaction summaries
 * replace pre-checkpoint history, and tool results plus total size are capped.
 */

import type { ContextCompactionRecord, UiMessage } from "@pi-desktop/shared";

export const PLUGIN_LLM_CONTEXT_MAX_CHARS = 200_000;
export const PLUGIN_TOOL_RESULT_MAX_CHARS = 8_000;

export type PluginLlmMessage = {
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  toolName?: string;
};

function stringifyToolResult(value: unknown, maxChars: number): string {
  if (value == null) return "";
  if (typeof value === "string") {
    return value.length > maxChars ? `${value.slice(0, maxChars)}\n…` : value;
  }
  try {
    const text = JSON.stringify(value);
    return text.length > maxChars ? `${text.slice(0, maxChars)}\n…` : text;
  } catch {
    return String(value).slice(0, maxChars);
  }
}

function toPluginMessage(
  message: UiMessage,
  maxToolResultChars: number,
): PluginLlmMessage | null {
  if (message.parentToolCallId) return null;
  if (message.role === "assistant") {
    if (message.status === "error" || message.status === "aborted") return null;
    const content = (message.content ?? "").trim();
    if (!content) return null;
    return { role: "assistant", content };
  }
  if (message.role === "user") {
    const content = (message.content ?? "").trim();
    if (!content) return null;
    return { role: "user", content };
  }
  if (message.role === "tool") {
    const content = stringifyToolResult(message.toolResult ?? message.content, maxToolResultChars);
    if (!content && !message.toolName) return null;
    return {
      role: "tool",
      content,
      ...(message.toolName ? { toolName: message.toolName } : {}),
    };
  }
  if (message.role === "system") {
    const content = (message.content ?? "").trim();
    if (!content) return null;
    return { role: "system", content };
  }
  return null;
}

/**
 * Project durable transcript messages into the plugin-facing LLM context.
 */
export function pluginLlmContextFromTranscript(
  messages: readonly UiMessage[],
  options: {
    compaction?: ContextCompactionRecord | null;
    stripToolName?: string;
    maxChars?: number;
    maxToolResultChars?: number;
  } = {},
): { messages: PluginLlmMessage[]; truncated: boolean } {
  const maxChars = options.maxChars ?? PLUGIN_LLM_CONTEXT_MAX_CHARS;
  const maxToolResultChars = options.maxToolResultChars ?? PLUGIN_TOOL_RESULT_MAX_CHARS;
  let source = messages.filter((message) => !message.parentToolCallId);

  const throughId = options.compaction?.throughMessageId;
  const summary = options.compaction?.summary?.trim();
  if (summary && throughId) {
    const index = source.findIndex((message) => message.id === throughId);
    if (index >= 0) {
      source = source.slice(index + 1);
    }
  }

  if (options.stripToolName) {
    for (let index = source.length - 1; index >= 0; index--) {
      const row = source[index];
      if (row?.role !== "tool" || row.toolName !== options.stripToolName) continue;
      if (row.toolStatus === "running" || row.status === "streaming") {
        source = [...source.slice(0, index), ...source.slice(index + 1)];
      }
      break;
    }
  }

  const projected: PluginLlmMessage[] = [];
  if (summary) {
    const tokens = options.compaction?.tokensBefore;
    projected.push({
      role: "system",
      content:
        tokens != null
          ? `Conversation summary (${tokens} tokens before checkpoint):\n${summary}`
          : `Conversation summary:\n${summary}`,
    });
  }
  for (const message of source) {
    const next = toPluginMessage(message, maxToolResultChars);
    if (next) projected.push(next);
  }

  let truncated = false;
  let total = projected.reduce((sum, message) => sum + message.content.length, 0);
  while (projected.length > 1 && total > maxChars) {
    const removed = projected.splice(summary ? 1 : 0, 1)[0];
    total -= removed?.content.length ?? 0;
    truncated = true;
  }
  if (projected.length === 1 && total > maxChars) {
    const only = projected[0];
    if (only) {
      only.content = `${only.content.slice(0, maxChars)}\n…`;
      truncated = true;
    }
  }
  return { messages: projected, truncated };
}

/** Flatten plugin messages into one user-facing transcript for a tools-less completion. */
export function serializePluginLlmContext(messages: readonly PluginLlmMessage[]): string {
  return messages
    .map((message) => {
      if (message.role === "tool") {
        return `### Tool ${message.toolName ?? "unknown"}\n${message.content}`;
      }
      const heading = message.role.charAt(0).toUpperCase() + message.role.slice(1);
      return `### ${heading}\n${message.content}`;
    })
    .join("\n\n");
}

export const PLUGIN_COMPLETE_DEFAULT_TAIL =
  "Please respond to the request.";
