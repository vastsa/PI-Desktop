import type { RacpItemSummary } from "@pi-desktop/shared";

const MAX_SUMMARY_LENGTH = 480;

export type ProjectedTurnResult = { text: string; sourceMessageId: string } | undefined;

/** Find user-facing root-agent output without including tools or subagents. */
export function findTurnResult(
  items: RacpItemSummary[],
  turnId: string,
): ProjectedTurnResult {
  const messages = items
    .filter((item) => item.turnId === turnId && item.itemType === "message" && item.status === "completed")
    .filter((item) => !item.parentToolCallId && !item.agentName)
    .map((item) => ({ item, message: asMessage(item.content) }))
    .filter((entry): entry is { item: RacpItemSummary; message: { role: "assistant"; content: string } } =>
      entry.message?.role === "assistant" && typeof entry.message.content === "string",
    )
    .sort((left, right) => left.item.createdAt.localeCompare(right.item.createdAt) || (left.item.sequence ?? 0) - (right.item.sequence ?? 0));

  const latest = messages.at(-1);
  const text = latest ? summarizeText(latest.message.content) : "";
  if (!latest || !text) return undefined;
  return { text, sourceMessageId: latest.item.id };
}

/** Project only the final assistant message from the exact terminal Host turn. */
export function projectTurnResultSummary(
  items: RacpItemSummary[],
  turnId: string,
  status: "completed" | "failed" | "interrupted" | "canceled",
): string {
  const projected = findTurnResult(items, turnId);
  if (projected) return projected.text;
  switch (status) {
    case "completed": return "Task completed. See the bound work session for details.";
    case "failed": return "The task failed. Error details are available in the bound work session.";
    case "interrupted": return "The task was interrupted. Review the work session for changes already made.";
    case "canceled": return "The task was canceled. Review the work session for changes already made.";
  }
}

function asMessage(value: unknown): { role: string; content: unknown } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const message = value as { role?: unknown; content?: unknown };
  return typeof message.role === "string" ? { role: message.role, content: message.content } : null;
}

function summarizeText(value: string): string {
  const withoutCode = value.replace(/```[\s\S]*?```/g, " ");
  const lines = withoutCode
    .split(/\r?\n/u)
    .filter((line) => !/^\s*\|/u.test(line) && !/^\s*[-*]\s*\|/u.test(line));
  const compact = lines.join(" ").replace(/\s+/gu, " ").trim();
  return Array.from(compact).slice(0, MAX_SUMMARY_LENGTH).join("").trim();
}
