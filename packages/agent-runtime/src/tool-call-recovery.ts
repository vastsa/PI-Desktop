import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { LocalRequestError, localRequestErrorDetails, type AssistantMessage, type ToolCall } from "@earendil-works/pi-ai";
import { validateHostedSearchMessages } from "@earendil-works/pi-ai/utils/hosted-search";

function wireId(id: unknown): string | undefined {
  return typeof id === "string" ? id.split("|", 1)[0] : undefined;
}

function validIdentity(id: unknown, name: unknown): boolean {
  return Boolean(wireId(id)?.trim()) &&
    typeof name === "string" && name.trim().length > 0;
}

export function isValidToolCall(call: ToolCall): boolean {
  if (!validIdentity(call.id, call.name)) return false;
  try {
    validateHostedSearchMessages([{ role: "assistant", content: [call] } as AssistantMessage]);
    return true;
  } catch (error) {
    if (!localRequestErrorDetails(error)) throw error;
    return false;
  }
}

/** Reject the whole unexecuted batch, without inventing a tool name, id or arguments. */
export function rejectMalformedToolCalls(message: AssistantMessage): AssistantMessage {
  if (message.stopReason === "error" || message.stopReason === "aborted" ||
    !message.content.some((block) => block.type === "toolCall" && !isValidToolCall(block))) return message;
  const error = new LocalRequestError("context-validation");
  return {
    ...message,
    content: message.content.filter((block) => block.type !== "toolCall"),
    stopReason: "error",
    errorMessage: error.message,
    errorDetails: localRequestErrorDetails(error),
  };
}

/** Repair only the model projection; preserve the transcript and completed sibling calls. */
export function recoverMalformedToolCalls(messages: AgentMessage[]): AgentMessage[] {
  const rejected = new Map<string | undefined, Set<unknown>>();
  let changed = false;
  const recovered: AgentMessage[] = [];
  for (const message of messages) {
    if (message.role === "assistant" && Array.isArray(message.content)) {
      const content = message.content.filter((block) => {
        if (block.type !== "toolCall") return true;
        const id = wireId(block.id);
        if (isValidToolCall(block)) {
          rejected.get(id)?.delete(block.name);
          return true;
        }
        const names = rejected.get(id) ?? new Set<unknown>();
        names.add(block.name);
        rejected.set(id, names);
        return false;
      });
      if (content.length !== message.content.length) {
        changed = true;
        if (content.length) recovered.push({ ...message, content });
        continue;
      }
    } else if (message.role === "toolResult" && (
      !validIdentity(message.toolCallId, message.toolName) ||
      rejected.get(wireId(message.toolCallId))?.has(message.toolName)
    )) {
      changed = true;
      continue;
    }
    recovered.push(message);
  }
  return changed ? recovered : messages;
}
