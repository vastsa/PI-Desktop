import type { MessageUsage, MessageUsageCost, UsageOperation, UsageProvenance } from "./types/messages.js";

const tokenKeys = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens", "totalTokens"] as const;
const costKeys = ["input", "output", "cacheRead", "cacheWrite", "total"] as const;

/** Attribute old token-only rows at ingress, before either persistence or rollup. */
export function withUsageIdentity(
  usage: MessageUsage | undefined,
  identity: UsageProvenance & { operationId: string },
): MessageUsage | undefined {
  if (!usage || usage.operationId || usage.operations?.length) return usage;
  return { ...identity, ...usage, operationId: identity.operationId, aggregation: "operation" };
}

function sumCounts(values: MessageUsage[]): MessageUsage {
  const result: MessageUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  for (const value of values) {
    for (const key of tokenKeys) {
      if (value[key] !== undefined) result[key] = (result[key] ?? 0) + value[key];
    }
  }
  return result;
}

function atomicRecords(usage: MessageUsage): UsageOperation[] {
  if (usage.operations?.length) return usage.operations;
  if (!usage.operationId) return [];
  const { operations: _operations, aggregation: _aggregation, ...record } = usage;
  return [{ ...record, operationId: usage.operationId }];
}

/** Legacy totals can coexist with a ledger, but cannot be retrospectively attributed. */
function unattributed(usage: MessageUsage, records: UsageOperation[]): MessageUsage | undefined {
  if (!records.length) return usage;
  if (usage.aggregation !== "aggregate") return undefined;
  const attributed = sumCounts(records);
  const remaining = sumCounts([usage]);
  for (const key of tokenKeys) {
    if (remaining[key] !== undefined) remaining[key] = Math.max(0, remaining[key] - (attributed[key] ?? 0));
  }
  return tokenKeys.some((key) => (remaining[key] ?? 0) > 0) ? remaining : undefined;
}

function hasKnownCost(value: MessageUsage): boolean {
  return value.costStatus !== "unknown" && !!value.cost && costKeys.every(key => Number.isFinite(value.cost![key]) && value.cost![key] >= 0);
}

function sumCosts(values: MessageUsage[]): Pick<MessageUsage, "cost" | "costStatus"> {
  // Incomplete totals are unknown, not a misleading partial dollar amount.
  // The individually known costs remain available on the atomic records.
  if (values.some((value) => !hasKnownCost(value))) {
    return { costStatus: "unknown" };
  }
  const cost: MessageUsageCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  for (const value of values) {
    for (const key of costKeys) cost[key] += value.cost![key];
  }
  if (costKeys.some(key => !Number.isFinite(cost[key]))) return { costStatus: "unknown" };
  return {
    cost,
    costStatus: values.every((value) => value.costStatus === "reported") ? "reported" : "estimated",
  };
}

/**
 * Union physical operations, then derive totals. Child reports and a parent's
 * aggregate may both arrive (and replay); a physical request is counted once.
 * Legacy records without identities retain their historical additive behavior.
 */
export function addUsage(total: MessageUsage | undefined, next: MessageUsage | undefined): MessageUsage | undefined {
  if (!next) return total;
  if (!total) return next;
  const left = atomicRecords(total);
  const right = atomicRecords(next);
  const legacy = [unattributed(total, left), unattributed(next, right)].filter(
    (value): value is MessageUsage => value !== undefined,
  );
  const operations = new Map<string, UsageOperation>();
  for (const record of [...left, ...right]) {
    const previous = operations.get(record.operationId);
    // A late partial snapshot must not replace an already-complete report.
    if (!previous || record.totalTokens > previous.totalTokens ||
      (record.totalTokens === previous.totalTokens && (
        !hasKnownCost(previous) ||
        (hasKnownCost(record) && record.costStatus === "reported")
      ))) operations.set(record.operationId, record);
  }
  const values = [...legacy, ...operations.values()];
  const counts = sumCounts(values);
  const hasCostMetadata = values.some((value) => value.cost || value.costStatus);
  return {
    ...counts,
    ...(hasCostMetadata ? sumCosts(values) : {}),
    ...(operations.size ? { aggregation: "aggregate" as const, operations: [...operations.values()] } : {}),
  };
}
