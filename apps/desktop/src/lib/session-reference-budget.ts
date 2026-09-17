import {
  estimateSessionReferenceTokens,
  modelIdsMatch,
  type ContextCompactionMark,
  type ModelInfo,
  type ProviderPublic,
  type SessionSummary,
  type UiMessage,
} from "@pi-desktop/shared";
import { contextOccupancyTokens, resolveContextWindow } from "./context-usage";
import { latestTurnContextInspector } from "./latest-turn-context";
import { normalizeSessionReferenceBudgetPercent } from "./session-reference-preferences";

export type SessionReferenceBudgetInput = {
  session: Pick<SessionSummary, "providerId" | "modelId">;
  providers: ProviderPublic[];
  providerModels: Record<string, ModelInfo[]>;
  messages: UiMessage[];
  compactions?: readonly ContextCompactionMark[];
  /** Current request including response annotation wrappers, but not references. */
  currentInput: string;
  percent?: number;
};

function positive(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.ceil(value) : 0;
}

function visibleTokens(messages: UiMessage[]): number {
  return estimateSessionReferenceTokens(messages.map((message) =>
    [message.content, message.thinking, message.toolArgs ? JSON.stringify(message.toolArgs) : "",
      message.toolResult ? JSON.stringify(message.toolResult) : ""].filter(Boolean).join("\n"),
  ).join("\n"));
}

/**
 * A conservative renderer estimate, not a tokenizer or the runtime context guard.
 * The TARGET binding owns the window (resolveContextWindow falls back to 128,000),
 * even when the latest usage was produced by a different model. No fixed token cap.
 */
export function calculateSessionReferenceBudget(input: SessionReferenceBudgetInput) {
  const { session, providers, providerModels } = input;
  const contextWindow = resolveContextWindow(session.providerId, session.modelId, providerModels, providers);
  const provider = providers.find((item) => item.id === session.providerId);
  const binding = provider?.models?.find((item) => session.modelId && modelIdsMatch(item.id, session.modelId));
  const outputReserve = Math.min(Math.floor(contextWindow / 2),
    positive(binding?.maxTokens) || positive(provider?.maxOutputTokens) || Math.ceil(contextWindow * 0.1));
  const systemReserve = Math.ceil(contextWindow * 0.1);
  const checkpoint = input.compactions?.at(-1);

  const parentMessages = input.messages.filter((message) => !message.parentToolCallId);
  const boundary = checkpoint ? parentMessages.findIndex((message) => message.id === checkpoint.throughMessageId) : -1;
  const messages = boundary >= 0 ? parentMessages.slice(boundary + 1) : parentMessages;
  const visibleEstimate = visibleTokens(messages) + positive(checkpoint?.summaryTokens);
  const inspector = latestTurnContextInspector(messages, providerModels, providers, input.compactions);
  const usageIndex = messages.findLastIndex((message) => Boolean(message.usage));
  const usedTokens = inspector
    ? Math.max(visibleEstimate, contextOccupancyTokens(inspector.usage) + visibleTokens(messages.slice(usageIndex + 1)))
    : visibleEstimate;

  const currentInputEstimate = estimateSessionReferenceTokens(input.currentInput);
  const availableTokens = Math.max(0, contextWindow - outputReserve - systemReserve - usedTokens - currentInputEstimate);
  const percent = normalizeSessionReferenceBudgetPercent(input.percent);
  return {
    contextWindow, outputReserve, systemReserve, usedTokens, currentInputEstimate,
    availableTokens, percent, budgetTokens: Math.floor(availableTokens * percent / 100),
    estimated: true as const,
    usageSource: inspector ? "reported" as const : "visible-estimate" as const,
  };
}
