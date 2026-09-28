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

export type ContextCapacityView = {
  usedTokens: number;
  remainingTokens: number;
  contextWindow: number;
  usedPercent: number;
  percentLabel: string;
};

export function contextCapacityView(usedTokens: number, contextWindow: number): ContextCapacityView {
  const used = Math.max(0, Math.round(usedTokens));
  const remaining = Math.max(0, contextWindow - used);
  const percent = Math.min(100, used / contextWindow * 100);
  return {
    usedTokens: used,
    remainingTokens: remaining,
    contextWindow,
    usedPercent: percent,
    percentLabel: used === 0 ? "0%" : percent < 1 ? "<1%" :
      used < contextWindow && percent >= 99.5 ? ">99%" : `${Math.round(percent)}%`,
  };
}

export type ContextBreakdownRow = ContextCategory & {
  sharePercent: number;
  shareLabel: string;
};

// Pi-Context's system tools, Skills, MCP, commands, bundles, and custom agents
// are a sub-breakdown of System prompt, not extra context on top of it.
const SYSTEM_DETAIL_KEYS = new Set<ContextCategoryKey>([
  "systemTools", "skills", "mcpTools", "commands", "bundles", "customAgents",
]);

export function contextSnapshotView(snapshot: ContextPanelSnapshot): {
  capacity: ContextCapacityView;
  categoryEstimateTokens: number;
  estimateMismatch: boolean;
  active: ContextBreakdownRow[];
  systemDetails: ContextBreakdownRow[];
  inactive: ContextCategory[];
  deferred: ContextCategory[];
} {
  const categories = snapshot.categories.filter((category) => category.key !== "free");
  const topLevel = categories.filter((category) =>
    !category.deferred && !SYSTEM_DETAIL_KEYS.has(category.key),
  );
  const details = categories.filter((category) => SYSTEM_DETAIL_KEYS.has(category.key));
  const categoryEstimateTokens = topLevel.reduce((sum, category) => sum + category.tokens, 0);
  const systemPromptTokens = topLevel.find((category) => category.key === "systemPrompt")?.tokens ?? 0;
  const detailTokens = details.reduce((sum, category) => sum + category.tokens, 0);
  const capacity = contextCapacityView(
    snapshot.totalTokens ?? categoryEstimateTokens,
    snapshot.contextWindow,
  );
  const withShare = (items: ContextCategory[], denominator: number): ContextBreakdownRow[] =>
    items.filter((category) => category.tokens > 0).map((category) => {
      const share = denominator > 0 ? Math.min(100, category.tokens / denominator * 100) : 0;
      return {
        ...category,
        sharePercent: share,
        shareLabel: share > 0 && share < 1 ? "<1%" : `${Math.round(share)}%`,
      };
    });
  return {
    capacity,
    categoryEstimateTokens,
    estimateMismatch: snapshot.totalTokens !== null && categoryEstimateTokens > 0 &&
      Math.abs(snapshot.totalTokens - categoryEstimateTokens) >
        Math.max(5, snapshot.totalTokens * 0.1),
    active: withShare(topLevel, categoryEstimateTokens),
    systemDetails: withShare(details, systemPromptTokens || detailTokens),
    inactive: categories.filter((category) => !category.deferred && category.tokens === 0),
    deferred: categories.filter((category) => category.deferred),
  };
}
