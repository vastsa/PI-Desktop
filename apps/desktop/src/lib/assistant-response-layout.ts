import { hostedSearchRounds, withoutReasoningReplayPlaceholder, type UiMessage } from "@pi-desktop/shared";
import type { AssistantActivityItem, AssistantTurnPart } from "./assistant-turns";

type Progress = Extract<AssistantTurnPart, { kind: "message" }>;
type Step = Progress | Extract<AssistantActivityItem, { kind: "thinking" | "hostedSearch" }>;
type OrderedResponse = { reply: UiMessage; steps: Step[] };
const responses = new WeakMap<UiMessage, OrderedResponse | undefined>();

/** Interpret only a complete layout for this snapshot; abbreviated/older rows use the legacy projection. */
function readLayout(message: UiMessage): OrderedResponse | undefined {
  const layout = message.responseLayout;
  if (!Array.isArray(layout) || !layout.length) return undefined;
  const rounds = new Map(hostedSearchRounds(message.hostedSearch).map(round => [round.id, round]));
  const thinking = message.thinking ?? "";
  let thought = 0, text = 0, answer = "";
  const steps: Step[] = [];
  for (const [index, block] of layout.entries()) {
    if (!block || typeof block !== "object") return undefined;
    if (block.type === "search") {
      if (typeof block.id !== "string" || !block.id) return undefined;
      const round = rounds.get(block.id);
      if (!round) return undefined;
      steps.push({ kind: "hostedSearch", message, round });
      rounds.delete(round.id);
      continue;
    }
    if (!Number.isSafeInteger(block.length) || block.length < 0) return undefined;
    const status = message.status === "streaming" && index < layout.length - 1 ? "complete" : message.status;
    if (block.type === "thinking") {
      const slice = thinking.slice(thought, thought + block.length);
      thought += block.length;
      if (withoutReasoningReplayPlaceholder(slice).trim()) {
        steps.push({ kind: "thinking", sourceMessageId: message.id, message: {
          id: `${message.id}:thinking:${index}`, role: "assistant", createdAt: message.createdAt,
          status, content: "", thinking: slice,
        } });
      }
    } else if (block.type === "text" || block.type === "commentary") {
      const slice = message.content.slice(text, text + block.length);
      text += block.length;
      if (block.type === "text") answer += slice;
      else if (slice.trim()) steps.push({ kind: "message", sourceMessageId: message.id, message: {
        id: `${message.id}:commentary:${index}`, role: "assistant", createdAt: message.createdAt, status, content: slice,
      } });
    } else return undefined;
  }
  if (rounds.size || text !== message.content.length || thought !== thinking.length) return undefined;
  return { reply: answer === message.content ? message : { ...message, content: answer }, steps };
}

export function projectResponseLayout(message: UiMessage): OrderedResponse | undefined {
  if (!message.responseLayout) return undefined;
  if (!responses.has(message)) responses.set(message, readLayout(message));
  return responses.get(message);
}

type ActivityPart = Extract<AssistantTurnPart, { kind: "activity" }>;
const activityParts = new WeakMap<ActivityPart, AssistantTurnPart[] | undefined>();

/** Replace the original per-message thinking/search slots in place. Keep neighbouring tools in their group;
 * a progress paragraph breaks it. Canonical turn entries remain untouched for history, metadata and navigation. */
export function orderedActivityParts(part: ActivityPart): AssistantTurnPart[] | undefined {
  if (activityParts.has(part)) return activityParts.get(part);
  let result: AssistantTurnPart[] | undefined;
  let items: AssistantActivityItem[] = [];
  let previous: UiMessage | undefined;
  for (const [index, item] of part.items.entries()) {
    const ordered = item.kind !== "tool" && projectResponseLayout(item.message);
    if (!ordered) {
      if (result) items.push(item);
      continue;
    }
    if (!result) { result = []; items = part.items.slice(0, index); }
    // The canonical builder emits this row's aggregate thinking and then all its rounds, consecutively.
    if (previous === item.message) continue;
    previous = item.message;
    for (const step of ordered.steps) {
      if (step.kind !== "message") { items.push(step); continue; }
      if (items.length) { result.push({ kind: "activity", items }); items = []; }
      result.push(step);
    }
  }
  if (result && items.length) result.push({ ...part, items });
  activityParts.set(part, result);
  return result;
}
