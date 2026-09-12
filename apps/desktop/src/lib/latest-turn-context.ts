import type {
  ContextCompactionMark,
  MessageUsage,
  ModelInfo,
  ProviderPublic,
  UiMessage,
} from "@pi-desktop/shared";
import {
  assistantTurnResponseDuration,
  assistantTurnResponseOutputIsEstimated,
  assistantTurnResponseOutputTokens,
  assistantTurnTools,
  assistantTurnUsage,
  buildTranscriptEntries,
  type AssistantTurnEntry,
} from "./assistant-turns";
import { latestMessageUsage, resolveContextWindow } from "./context-usage";

export type LatestTurnContextInspector = {
  usage: MessageUsage;
  turnUsage: MessageUsage;
  contextWindow: number;
  tools: UiMessage[];
  responseDurationMs?: number;
  responseOutputTokens?: number;
  responseOutputEstimated: boolean;
};

/**
 * The composer inspector always mirrors the newest assistant turn that
 * reported usage, so a later streaming turn without totals does not steal
 * the previous ring's tools or throughput.
 */
export function latestTurnContextInspector(
  messages: UiMessage[],
  providerModels: Record<string, ModelInfo[]>,
  providers: ProviderPublic[],
  compactions: readonly ContextCompactionMark[] = [],
): LatestTurnContextInspector | undefined {
  // Delegate rows carry their own usage; remaining capacity is a parent-session
  // number, so those snapshots must not steal the composer ring.
  const parentMessages = messages.filter((message) => !message.parentToolCallId);
  const latestUsage = latestMessageUsage(parentMessages);
  if (!latestUsage) return undefined;

  const turns = buildTranscriptEntries(messages, compactions).entries.filter(
    (entry): entry is AssistantTurnEntry => entry.kind === "assistant-turn",
  );
  const latestTurn =
    [...turns].reverse().find((turn) => assistantTurnUsage(turn)) ??
    turns.at(-1);
  const latestUsageMessage = [...parentMessages]
    .reverse()
    .find((message) => message.usage);

  return {
    // Occupancy and provider cache/input/output use this last request.
    // turnUsage remains the visual-turn sum for completed-turn speed.
    usage: latestUsage,
    turnUsage:
      (latestTurn ? assistantTurnUsage(latestTurn) : undefined) ?? latestUsage,
    contextWindow: resolveContextWindow(
      latestUsageMessage?.providerId,
      latestUsageMessage?.modelId,
      providerModels,
      providers,
    ),
    tools: latestTurn ? assistantTurnTools(latestTurn) : [],
    responseDurationMs: latestTurn
      ? assistantTurnResponseDuration(latestTurn)
      : undefined,
    responseOutputTokens: latestTurn
      ? assistantTurnResponseOutputTokens(latestTurn)
      : undefined,
    responseOutputEstimated: latestTurn
      ? assistantTurnResponseOutputIsEstimated(latestTurn)
      : false,
  };
}
