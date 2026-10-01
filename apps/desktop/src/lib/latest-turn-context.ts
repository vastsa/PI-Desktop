import type {
  ContextCompactionMark,
  MessageUsage,
  ModelInfo,
  ProviderPublic,
  UiMessage,
} from "@pi-desktop/shared";
import { resolveContextWindow } from "./context-usage";
import { getSessionMessageSnapshot } from "./session-transcript-updates";
import { getTranscriptProjection } from "./transcript-projection";
import { getAssistantTurnSummary } from "./transcript-summary";

export type LatestTurnContextInspector = {
  usage: MessageUsage;
  turnUsage: MessageUsage;
  contextWindow: number;
  tools: UiMessage[];
  responseDurationMs?: number;
  responseOutputTokens?: number;
  responseOutputEstimated: boolean;
};

const inspectors = new WeakMap<object, LatestTurnContextInspector>();

function sameUsage(previous: MessageUsage, next: MessageUsage): boolean {
  return previous === next || (
    Object.keys(previous).length === Object.keys(next).length &&
    Object.keys(next).every((key) => previous[key as keyof MessageUsage] === next[key as keyof MessageUsage])
  );
}

/**
 * The composer mirrors the newest parent turn with usage, not a later live turn
 * without totals. It shares the transcript projection instead of rebuilding it.
 */
export function latestTurnContextInspector(
  messages: UiMessage[],
  providerModels: Record<string, ModelInfo[]>,
  providers: ProviderPublic[],
  compactions?: readonly ContextCompactionMark[],
): LatestTurnContextInspector | undefined {
  let latestUsageMessage: UiMessage | undefined;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!message.parentToolCallId && message.usage) {
      latestUsageMessage = message;
      break;
    }
  }
  const latestUsage = latestUsageMessage?.usage;
  if (!latestUsage) return undefined;

  const { entries } = getTranscriptProjection(messages, compactions);
  let latestTurn: ReturnType<typeof getAssistantTurnSummary> | undefined;
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.kind !== "assistant-turn") continue;
    const summary = getAssistantTurnSummary(entry);
    latestTurn ??= summary;
    if (summary.usage) {
      latestTurn = summary;
      break;
    }
  }
  const result: LatestTurnContextInspector = {
    usage: latestUsage,
    turnUsage: latestTurn?.usage ?? latestUsage,
    contextWindow: resolveContextWindow(
      latestUsageMessage?.providerId,
      latestUsageMessage?.modelId,
      providerModels,
      providers,
    ),
    tools: latestTurn?.tools ?? [],
    responseDurationMs: latestTurn?.responseDurationMs,
    responseOutputTokens: latestTurn?.responseOutputTokens,
    responseOutputEstimated: latestTurn?.responseOutputEstimated ?? false,
  };
  const owner = getSessionMessageSnapshot(messages).owner;
  const previous = inspectors.get(owner);
  if (previous && previous.usage === result.usage &&
    sameUsage(previous.turnUsage, result.turnUsage) &&
    previous.contextWindow === result.contextWindow &&
    previous.responseDurationMs === result.responseDurationMs &&
    previous.responseOutputTokens === result.responseOutputTokens &&
    previous.responseOutputEstimated === result.responseOutputEstimated &&
    previous.tools.length === result.tools.length &&
    previous.tools.every((tool, index) => tool === result.tools[index])
  ) return previous;
  inspectors.set(owner, result);
  return result;
}
