import {
  OAUTH_AUTH_KIND,
  type MessageUsage,
  type ProviderPublic,
  type ProviderUsageCost,
} from "@pi-desktop/shared";

/**
 * Pay-as-you-go spend and subscription usage are reported apart: a catalog
 * price on a subscription account is a reference figure, not money spent.
 */
export type UsageCostSummary = {
  /** USD of priced pay-as-you-go requests. */
  billed: number;
  billedRequests: number;
  /** True when any priced pay-as-you-go total is a catalog estimate. */
  billedEstimated: boolean;
  /** Pay-as-you-go requests without a usable price; `billed` is a lower bound. */
  unpricedRequests: number;
  /** Catalog-equivalent USD of subscription requests. */
  subscriptionEquivalent: number;
  subscriptionRequests: number;
};

export type UsageCostView =
  | { kind: "none" }
  | { kind: "unknown" }
  | { kind: "subscription"; equivalent?: number }
  | {
      kind: "billed";
      amount: number;
      qualifier: "exact" | "estimated" | "lowerBound";
      /** Pay-as-you-go requests left out of `amount` for want of a price. */
      unpricedRequests: number;
      /** Catalog-equivalent of subscription requests in the same scope. */
      subscriptionEquivalent?: number;
    };

const COST_KEYS = ["input", "output", "cacheRead", "cacheWrite", "total"] as const;

/** Mirrors Pi's footer: OAuth accounts and Kimi Coding are subscription-backed. */
export function subscriptionProviderIds(providers: readonly ProviderPublic[]): Set<string> {
  return new Set(
    providers
      .filter((provider) =>
        provider.authKind === OAUTH_AUTH_KIND || provider.vendorKey === "kimi-coding")
      .map((provider) => provider.id),
  );
}

function knownCost(usage: MessageUsage): number | undefined {
  if (usage.costStatus === "unknown" || !usage.cost) return undefined;
  const cost = usage.cost;
  if (!COST_KEYS.every((key) => Number.isFinite(cost[key]) && cost[key] >= 0)) return undefined;
  return cost.total;
}

/** Per-provider buckets of one turn's ledger, shaped like the session rollup. */
export function turnProviderCosts(usage: MessageUsage | undefined): ProviderUsageCost[] {
  if (!usage) return [];
  const records: MessageUsage[] = usage.operations?.length
    ? usage.operations
    : [usage];
  const buckets = new Map<string | undefined, ProviderUsageCost>();
  for (const record of records) {
    const providerId = record.providerId || undefined;
    const bucket = buckets.get(providerId) ?? {
      ...(providerId ? { providerId } : {}),
      total: 0,
      pricedRequests: 0,
      reportedRequests: 0,
      unpricedRequests: 0,
    };
    const total = knownCost(record);
    if (total === undefined) {
      bucket.unpricedRequests += 1;
    } else {
      bucket.total += total;
      bucket.pricedRequests += 1;
      if (record.costStatus === "reported") bucket.reportedRequests += 1;
    }
    buckets.set(providerId, bucket);
  }
  return [...buckets.values()];
}

export function summarizeUsageCost(
  buckets: readonly ProviderUsageCost[],
  subscriptionIds: ReadonlySet<string>,
): UsageCostSummary {
  const summary: UsageCostSummary = {
    billed: 0,
    billedRequests: 0,
    billedEstimated: false,
    unpricedRequests: 0,
    subscriptionEquivalent: 0,
    subscriptionRequests: 0,
  };
  for (const bucket of buckets) {
    const total = Number.isFinite(bucket.total) && bucket.total > 0 ? bucket.total : 0;
    if (bucket.providerId && subscriptionIds.has(bucket.providerId)) {
      summary.subscriptionEquivalent += total;
      summary.subscriptionRequests += bucket.pricedRequests + bucket.unpricedRequests;
      continue;
    }
    summary.billed += total;
    summary.billedRequests += bucket.pricedRequests;
    summary.unpricedRequests += bucket.unpricedRequests;
    if (bucket.reportedRequests < bucket.pricedRequests) summary.billedEstimated = true;
  }
  return summary;
}

export function usageCostView(summary: UsageCostSummary): UsageCostView {
  const subscriptionEquivalent = summary.subscriptionEquivalent > 0
    ? summary.subscriptionEquivalent
    : undefined;
  if (summary.billedRequests > 0) {
    return {
      kind: "billed",
      amount: summary.billed,
      qualifier: summary.unpricedRequests > 0
        ? "lowerBound"
        : summary.billedEstimated ? "estimated" : "exact",
      unpricedRequests: summary.unpricedRequests,
      ...(subscriptionEquivalent !== undefined ? { subscriptionEquivalent } : {}),
    };
  }
  if (summary.unpricedRequests > 0) return { kind: "unknown" };
  if (summary.subscriptionRequests > 0) {
    return { kind: "subscription", ...(subscriptionEquivalent !== undefined ? { equivalent: subscriptionEquivalent } : {}) };
  }
  return { kind: "none" };
}

/**
 * USD with enough precision for single requests: sub-dollar amounts keep a
 * third decimal ($0.042), larger ones use cents. Nonzero amounts below a tenth
 * of a cent read as "<$0.001" instead of a misleading "$0.000".
 */
export function formatUsd(amount: number, locale?: string): string {
  const value = Number.isFinite(amount) && amount > 0 ? amount : 0;
  const format = (minimum: number, maximum: number, number: number) =>
    new Intl.NumberFormat(locale, {
      style: "currency",
      currency: "USD",
      currencyDisplay: "narrowSymbol",
      minimumFractionDigits: minimum,
      maximumFractionDigits: maximum,
    }).format(number);
  if (value === 0) return format(2, 2, 0);
  if (value < 0.001) return `<${format(3, 3, 0.001)}`;
  if (value < 1) return format(2, 3, value);
  return format(2, 2, value);
}
