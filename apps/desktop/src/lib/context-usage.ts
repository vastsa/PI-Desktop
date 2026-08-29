import { modelIdsMatch } from "@pi-desktop/shared";
import type {
  MessageUsage,
  ModelInfo,
  ProviderPublic,
  ToolTokenUsage,
  UiMessage,
} from "@pi-desktop/shared";

export const DEFAULT_CONTEXT_WINDOW = 128_000;

function positiveTokenCount(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : 0;
}

export function usageTokenTotal(usage: MessageUsage): number {
  const reportedTotal = positiveTokenCount(usage.totalTokens);
  if (reportedTotal > 0) return reportedTotal;
  return positiveTokenCount(usage.inputTokens) + positiveTokenCount(usage.outputTokens);
}

export function latestMessageUsage(messages: UiMessage[]): MessageUsage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].usage) return messages[index].usage;
  }
  return undefined;
}

function modelContextWindow(model: ModelInfo | undefined): number | undefined {
  const value = positiveTokenCount(model?.contextWindow);
  return value > 0 ? value : undefined;
}

function providerContextWindow(provider: ProviderPublic | undefined): number | undefined {
  const value = positiveTokenCount(provider?.contextWindow);
  return value > 0 ? value : undefined;
}

export function resolveContextWindow(
  providerId: string | undefined,
  modelId: string | undefined,
  providerModels: Record<string, ModelInfo[]>,
  providers: ProviderPublic[],
): number {
  const catalogModel = modelId
    ? providerId
      ? providerModels[providerId]?.find((model) => modelIdsMatch(model.modelId, modelId))
      : Object.values(providerModels)
          .flat()
          .find((model) => modelIdsMatch(model.modelId, modelId))
    : undefined;
  const catalogWindow = modelContextWindow(catalogModel);
  if (catalogWindow) return catalogWindow;

  const providerWindow = providerContextWindow(
    providers.find((provider) => provider.id === providerId),
  );
  return providerWindow ?? DEFAULT_CONTEXT_WINDOW;
}

export type ContextUsage = {
  usedTokens: number;
  remainingTokens: number;
  usedRatio: number;
  remainingRatio: number;
  usedPercent: number;
  remainingPercent: number;
};

export function calculateContextUsage(
  usage: MessageUsage,
  contextWindow: number,
): ContextUsage {
  const safeWindow = positiveTokenCount(contextWindow) || DEFAULT_CONTEXT_WINDOW;
  const usedTokens = usageTokenTotal(usage);
  const usedRatio = Math.min(1, usedTokens / safeWindow);
  const remainingRatio = 1 - usedRatio;
  const usedPercent = Math.round(usedRatio * 100);

  return {
    usedTokens,
    remainingTokens: Math.max(0, safeWindow - usedTokens),
    usedRatio,
    remainingRatio,
    usedPercent,
    remainingPercent: 100 - usedPercent,
  };
}

function serializedLength(value: unknown): number {
  if (typeof value === "string") return value.length;
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return String(value).length;
  }
}

/**
 * Estimate the context footprint of a historical tool row when it predates
 * runtime-provided usage metadata. The runtime uses the same four characters
 * per token heuristic for its durable estimate.
 */
export function estimateToolTokenUsage(
  message: Pick<UiMessage, "toolName" | "toolArgs" | "toolResult" | "content">,
): ToolTokenUsage {
  const argumentChars = serializedLength({
    tool: message.toolName ?? "",
    arguments: message.toolArgs ?? null,
  });
  const resultChars = serializedLength(
    message.toolResult ?? message.content ?? "",
  );
  const argumentTokens = Math.ceil(argumentChars / 4);
  const resultTokens = Math.ceil(resultChars / 4);

  return {
    argumentTokens,
    resultTokens,
    totalTokens: argumentTokens + resultTokens,
    estimated: true,
  };
}

export function toolTokenUsage(message: UiMessage): ToolTokenUsage {
  return message.toolUsage ?? estimateToolTokenUsage(message);
}

export type ToolTokenUsageSummary = {
  toolName?: string;
  callCount: number;
  argumentTokens: number;
  resultTokens: number;
  totalTokens: number;
  durationMs?: number;
  estimated: true;
};

function toolDuration(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

/** Group repeated tool calls while preserving first-seen execution order. */
export function aggregateToolTokenUsage(
  messages: UiMessage[],
): ToolTokenUsageSummary[] {
  const groups = new Map<string, ToolTokenUsageSummary>();

  for (const message of messages) {
    const toolName = message.toolName?.trim() || undefined;
    const key = toolName ?? "__unknown_tool__";
    const usage = toolTokenUsage(message);
    const durationMs = toolDuration(message.toolDurationMs);
    const existing = groups.get(key);

    if (existing) {
      existing.callCount += 1;
      existing.argumentTokens += usage.argumentTokens;
      existing.resultTokens += usage.resultTokens;
      existing.totalTokens += usage.totalTokens;
      if (durationMs !== undefined) {
        existing.durationMs = (existing.durationMs ?? 0) + durationMs;
      }
      continue;
    }

    groups.set(key, {
      toolName,
      callCount: 1,
      argumentTokens: usage.argumentTokens,
      resultTokens: usage.resultTokens,
      totalTokens: usage.totalTokens,
      durationMs,
      estimated: true,
    });
  }

  return [...groups.values()];
}

export function calculateTokenRate(
  outputTokens: number,
  responseDurationMs: number | undefined,
): number | undefined {
  if (
    !Number.isFinite(outputTokens) ||
    outputTokens <= 0 ||
    !Number.isFinite(responseDurationMs) ||
    responseDurationMs === undefined ||
    responseDurationMs <= 0
  ) {
    return undefined;
  }
  return Math.round(outputTokens / (responseDurationMs / 1000));
}

/**
 * Estimate visible assistant output when an interrupted provider response does
 * not include final usage. This mirrors the runtime's durable fallback.
 */
export function estimateResponseOutputTokens(
  message: Pick<UiMessage, "content" | "thinking">,
): number | undefined {
  const visible = `${message.thinking ?? ""}${message.content ?? ""}`.trim();
  return visible ? Math.max(1, Math.ceil(Array.from(visible).length / 4)) : undefined;
}

/** Add the timing metadata needed to show throughput immediately after stop. */
export function settleStoppedAssistantMetrics(
  message: UiMessage,
  stoppedAtMs = Date.now(),
): UiMessage {
  const createdAtMs = Date.parse(message.createdAt);
  const responseDurationMs =
    message.responseDurationMs ??
    (Number.isFinite(createdAtMs) ? Math.max(1, stoppedAtMs - createdAtMs) : undefined);
  const responseOutputTokens =
    positiveTokenCount(message.usage?.outputTokens) > 0
      ? message.responseOutputTokens
      : message.responseOutputTokens ?? estimateResponseOutputTokens(message);

  return {
    ...message,
    responseDurationMs,
    responseOutputTokens,
  };
}

/**
 * Calculate the provider-reported prompt cache hit rate.
 * `inputTokens` is the uncached prompt portion and `cacheReadTokens` is the
 * portion served from cache, so cache writes do not affect this denominator.
 */
export function calculateCacheRate(
  inputTokens: number,
  cacheReadTokens: number | undefined,
): number | undefined {
  if (
    !Number.isFinite(inputTokens) ||
    inputTokens < 0 ||
    cacheReadTokens === undefined ||
    !Number.isFinite(cacheReadTokens) ||
    cacheReadTokens < 0
  ) {
    return undefined;
  }

  const promptTokens = inputTokens + cacheReadTokens;
  if (promptTokens <= 0) return undefined;
  return Math.round((cacheReadTokens / promptTokens) * 100);
}
