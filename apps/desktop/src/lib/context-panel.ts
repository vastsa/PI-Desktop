import type { MessageUsage } from "@pi-desktop/shared";
import { calculateContextUsage } from "./context-usage.ts";

export const CONTEXT_SNAPSHOT_STATUS_KEY = "event:context:snapshot";

export type ContextCategoryKey =
  | "messages"
  | "systemPrompt"
  | "systemTools"
  | "skills"
  | "mcpTools"
  | "mcpDeferred"
  | "commands"
  | "memoryFiles"
  | "customAgents"
  | "bundles"
  | "free";

export type ContextCategory = {
  key: ContextCategoryKey;
  label: string;
  tokens: number;
  percent: number;
  deferred?: boolean;
  count?: number;
};

export type ContextPanelSnapshot = {
  at: number;
  modelId: string;
  modelName: string;
  provider: string;
  contextWindow: number;
  totalTokens: number | null;
  categories: ContextCategory[];
  expanded: ContextCategoryKey | null;
  unknownTotal: boolean;
};

const CATEGORY_KEYS = new Set<ContextCategoryKey>([
  "messages",
  "systemPrompt",
  "systemTools",
  "skills",
  "mcpTools",
  "mcpDeferred",
  "commands",
  "memoryFiles",
  "customAgents",
  "bundles",
  "free",
]);

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function parseContextSnapshotStatus(
  text: string | undefined,
): ContextPanelSnapshot | null {
  if (!text) return null;
  try {
    const value = JSON.parse(text) as Partial<ContextPanelSnapshot>;
    if (
      !finiteNonNegative(value.at) ||
      typeof value.modelId !== "string" ||
      typeof value.modelName !== "string" ||
      typeof value.provider !== "string" ||
      !finiteNonNegative(value.contextWindow) ||
      value.contextWindow === 0 ||
      (value.totalTokens !== null && !finiteNonNegative(value.totalTokens)) ||
      typeof value.unknownTotal !== "boolean" ||
      !Array.isArray(value.categories)
    ) {
      return null;
    }
    for (const category of value.categories) {
      if (
        !category ||
        typeof category !== "object" ||
        !CATEGORY_KEYS.has(category.key) ||
        typeof category.label !== "string" ||
        !finiteNonNegative(category.tokens) ||
        !finiteNonNegative(category.percent)
      ) {
        return null;
      }
    }
    if (
      value.expanded !== null &&
      (typeof value.expanded !== "string" || !CATEGORY_KEYS.has(value.expanded))
    ) {
      return null;
    }
    return value as ContextPanelSnapshot;
  } catch {
    return null;
  }
}

export function fallbackContextSnapshot(
  usage: MessageUsage,
  contextWindow: number,
): ContextPanelSnapshot {
  const context = calculateContextUsage(usage, contextWindow);
  return {
    at: Date.now(),
    modelId: "",
    modelName: "",
    provider: "",
    contextWindow,
    totalTokens: context.usedTokens,
    categories: [
      {
        key: "messages",
        label: "Messages",
        tokens: context.usedTokens,
        percent: context.usedPercent,
      },
      {
        key: "free",
        label: "Free",
        tokens: context.remainingTokens,
        percent: context.remainingPercent,
      },
    ],
    expanded: null,
    unknownTotal: false,
  };
}
