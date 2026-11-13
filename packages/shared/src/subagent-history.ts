import { normalizeSubagentName } from "./subagent-definition.js";
import type { UiMessage } from "./types/messages.js";

export type SubagentRecordedModel = { modelId: string; modelKey: string };
type ReplyAccount = { modelId: string; providerId: string };
export type SubagentReplyIndex = ReadonlyMap<string, ReadonlyMap<string, ReplyAccount>>;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}
const text = (value: unknown): string => typeof value === "string" ? value.trim() : "";

function modelIdFromKey(modelKey: string): string {
  const slash = modelKey.indexOf("/");
  return slash > 0 ? modelKey.slice(slash + 1) : "";
}

/** Legacy namespaced spellings are presentation-compatible Task starts. */
export function isSubagentTaskTool(name?: string): boolean {
  const bare = (name ?? "").split(".").at(-1)?.toLowerCase().replace(/[^a-z0-9]+/g, "");
  return bare === "task" || bare === "subagent";
}

/** Read old direct payloads and current result envelopes without changing rows. */
export function subagentTaskPayload(message: UiMessage): Record<string, unknown> | undefined {
  const result = record(message.toolResult);
  return record(result?.details) ?? result;
}

/** One bounded pass; neither parent replies nor other calls can supply identity. */
export function buildSubagentReplyIndex(messages: readonly UiMessage[]): SubagentReplyIndex {
  const calls = new Map<string, Map<string, ReplyAccount>>();
  for (const message of messages) {
    const modelId = text(message.modelId);
    if (message.role !== "assistant" || !message.parentToolCallId || !message.agentName || !modelId) continue;
    const agents = calls.get(message.parentToolCallId) ?? new Map<string, ReplyAccount>();
    agents.set(normalizeSubagentName(message.agentName), { modelId, providerId: text(message.providerId) });
    calls.set(message.parentToolCallId, agents);
  }
  return calls;
}

/**
 * A newer exact binding wins. Legacy echoed aliases can be made exact from
 * this call's own reply, but an old reply cannot retarget a recorded new model.
 * This is evidence only: the runtime still independently authorizes the account.
 */
export function subagentRecordedModel(
  message: UiMessage, replies: SubagentReplyIndex, agentName: string,
): SubagentRecordedModel {
  const details = subagentTaskPayload(message);
  const reply = replies.get(message.toolCallId ?? message.id)?.get(normalizeSubagentName(agentName));
  const requestedKey = text(record(message.toolArgs)?.model);
  const recordedKey = text(details?.modelKey);
  const modelId = text(details?.modelId) || modelIdFromKey(recordedKey) || reply?.modelId || "";
  const replyMatches = reply?.modelId.toLowerCase() === modelId.toLowerCase();
  const replyKey = replyMatches && reply?.providerId ? `${reply.providerId}/${modelId}` : "";
  const slash = requestedKey.indexOf("/");
  const requestedMatches = slash > 0 && requestedKey.slice(slash + 1).toLowerCase() === modelId.toLowerCase();
  const modelKey = recordedKey && recordedKey !== requestedKey ? recordedKey :
    replyKey || recordedKey || (requestedMatches ? requestedKey : "");
  return { modelId, modelKey };
}

/** Task continuation keeps its last known binding when legacy snapshots omit it. */
export function inheritSubagentRecordedModel(
  previous: SubagentRecordedModel, next: SubagentRecordedModel,
): SubagentRecordedModel {
  if (!next.modelId && !next.modelKey) return previous;
  const modelId = next.modelId || modelIdFromKey(next.modelKey);
  return { modelId, modelKey: next.modelKey ||
    (previous.modelId.toLowerCase() === modelId.toLowerCase() ? previous.modelKey : "") };
}
