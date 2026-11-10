import type { ContextCompactionMark, MessageUsage, UiMessage } from "@pi-desktop/shared";
import { contextOccupancyTokens, toolTokenUsage } from "./context-usage";

export const CONTEXT_CATEGORIES = ["system", "schemas", "user", "injected", "assistant", "tools"] as const;
export type ContextCategory = (typeof CONTEXT_CATEGORIES)[number];
export type ContextHistoryItem = { id: string; label: string; content: string; tokens: number };
export type ContextHistoryGroup = { category: ContextCategory; items: ContextHistoryItem[]; tokens: number };
export type ContextRequest = {
  message: UiMessage & { usage: MessageUsage };
  index: number;
  turn: number;
  step: number;
  compactions: ContextCompactionMark[];
};

export function contextText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  return JSON.stringify(value, null, 2) ?? "";
}

/**
 * Rough token estimate for recorded text, not a tokenizer.
 *
 * One CJK/Hangul/Kana character costs about one token, everything else about a
 * quarter. A flat `length / 4` would undercount CJK text roughly fourfold, and
 * the browser compares categories against each other — so that bias would not
 * cancel out: it would inflate the ASCII-heavy system prompt and tool schemas
 * and shrink Chinese user text, tool output, and reasoning.
 */
const WIDE_SCRIPT = /[\u1100-\u11FF\u2E80-\u303F\u3040-\u30FF\u3130-\u318F\u3400-\u4DBF\u4E00-\u9FFF\uA960-\uA97F\uAC00-\uD7AF\uF900-\uFAFF\uFF00-\uFFEF]/u;
const NARROW_SCRIPT_COST = 0.25;

function estimate(text: string): number {
  let cost = 0;
  for (const character of text) {
    cost += WIDE_SCRIPT.test(character) ? 1 : NARROW_SCRIPT_COST;
  }
  return Math.ceil(cost);
}

/** Internal system rows can arrive after the user row they precede. */
export function contextHistoryMessages(messages: readonly UiMessage[]): UiMessage[] {
  const parent = messages.filter(
    (message) =>
      !message.parentToolCallId && !(message as UiMessage & { nestedParentToolCallId?: string }).nestedParentToolCallId,
  );
  const ordered = parent.filter((message) => !message.modelSystem);
  const seen = new Set<string>();
  for (const message of parent) {
    if (!message.modelSystem || seen.has(message.modelSystem.messageJson)) continue;
    seen.add(message.modelSystem.messageJson);
    const before = ordered.findIndex((row) => row.id === message.modelSystem?.beforeMessageId);
    const after = ordered.findIndex((row) => row.id === message.modelSystem?.afterMessageId);
    let index = before >= 0 ? before : after >= 0 ? after + 1 : ordered.length;
    if (before < 0) while (ordered[index]?.modelSystem) index++;
    ordered.splice(index, 0, message);
  }
  return ordered;
}

export function contextRequests(
  messages: readonly UiMessage[],
  compactions: readonly ContextCompactionMark[] = [],
): ContextRequest[] {
  const requests: ContextRequest[] = [];
  const indexes = new Map(messages.map((message, index) => [message.id, index]));
  let turn = 0;
  let step = 0;
  let previousIndex = -1;
  messages.forEach((message, index) => {
    if (message.role === "user" && !message.steering) {
      turn++;
      step = 0;
    }
    if (message.role !== "assistant" || !message.usage) return;
    if (turn === 0) turn = 1;
    requests.push({
      message: message as ContextRequest["message"],
      index,
      turn,
      step: ++step,
      compactions: compactions.filter((mark) => {
        const boundary = indexes.get(mark.throughMessageId);
        return boundary !== undefined && boundary >= previousIndex && boundary < index;
      }),
    });
    previousIndex = index;
  });
  return requests;
}

/** Recorded inputs, not a reconstruction of the provider's compacted prompt. */
export function contextHistoryGroups(messages: readonly UiMessage[]): ContextHistoryGroup[] {
  const groups = CONTEXT_CATEGORIES.map((category) => ({ category, items: [] as ContextHistoryItem[], tokens: 0 }));
  const add = (category: ContextCategory, id: string, label: string, content: string, tokens = estimate(content)) => {
    if (!content) return;
    const group = groups.find((candidate) => candidate.category === category)!;
    group.items.push({ id, label, content, tokens });
    group.tokens += tokens;
  };
  for (const message of messages) {
    const { id, content, modelSystem } = message;
    if (modelSystem) {
      try {
        const record: unknown = JSON.parse(modelSystem.messageJson);
        if (!record || typeof record !== "object") continue;
        const system = record as Record<string, unknown>;
        if (typeof system.content === "string") add("system", id, "", system.content);
        if (system.sections && typeof system.sections === "object") {
          for (const [name, value] of Object.entries(system.sections)) {
            if (typeof value === "string")
              add(name === "runtime" ? "system" : "injected", `${id}:${name}`, name, value);
          }
        }
        if (Array.isArray(system.toolsAdded)) {
          for (const [index, tool] of system.toolsAdded.entries()) {
            if (tool && typeof tool === "object" && typeof tool.name === "string") {
              add("schemas", `${id}:tool:${index}`, tool.name, contextText(tool));
            }
          }
        }
      } catch {
        /* An old or malformed record cannot describe its contents. */
      }
    } else if (message.role === "tool") {
      const usage = toolTokenUsage(message);
      add(
        "tools",
        id,
        message.toolName ?? "",
        contextText({ arguments: message.toolArgs, result: message.toolResult ?? content }),
        usage.totalTokens,
      );
    } else if (message.role === "assistant") {
      add("assistant", id, message.modelId ?? "", [message.thinking, content].filter(Boolean).join("\n\n"));
    } else {
      add(message.role === "user" ? "user" : "injected", id, "", content);
    }
  }
  return groups;
}

export type UsageSegment = { key: "input" | "cacheRead" | "cacheWrite" | "output"; tokens: number };
export function contextUsageSegments(usage: MessageUsage): UsageSegment[] {
  return (
    [
      ["input", usage.inputTokens],
      ["cacheRead", usage.cacheReadTokens],
      ["cacheWrite", usage.cacheWriteTokens],
      ["output", usage.outputTokens],
    ] as const
  ).map(([key, value]) => ({
    key,
    tokens: typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0,
  }));
}

export function contextTrendPoints(requests: readonly ContextRequest[], byTurn: boolean) {
  const selected = byTurn ? requests.filter((request, index) => requests[index + 1]?.turn !== request.turn) : requests;
  return selected.map((request, index) => ({
    request: byTurn
      ? {
          ...request,
          compactions: requests
            .filter((candidate) => candidate.turn === request.turn)
            .flatMap((candidate) => candidate.compactions),
        }
      : request,
    total: contextOccupancyTokens(request.message.usage),
    delta:
      contextOccupancyTokens(request.message.usage) -
      (index ? contextOccupancyTokens(selected[index - 1].message.usage) : 0),
  }));
}
