import assert from "node:assert/strict";
import { register } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createInstance } from "i18next";
import { catalogs } from "@pi-desktop/i18n";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const {
  formatUsd,
  subscriptionProviderIds,
  summarizeUsageCost,
  turnProviderCosts,
  usageCostView,
} = await import("../src/lib/usage-cost.ts");
const { usageCostText } = await import(
  "../src/features/chat/context-usage/usage-cost-text.ts"
);

const i18n = createInstance();
await i18n.init({
  lng: "en",
  resources: { en: { translation: catalogs.en }, "zh-CN": { translation: catalogs["zh-CN"] } },
  interpolation: { escapeValue: false },
});
const t = i18n.t.bind(i18n);

const cost = (total) => ({ input: total, output: 0, cacheRead: 0, cacheWrite: 0, total });
const op = (operationId, providerId, costStatus, total) => ({
  operationId,
  providerId,
  inputTokens: 10,
  outputTokens: 2,
  totalTokens: 12,
  costStatus,
  ...(total === undefined ? {} : { cost: cost(total) }),
});
const providers = [
  { id: "api", authKind: "api_key", vendorKey: "openai" },
  { id: "claude-max", authKind: "oauth", vendorKey: "anthropic" },
  { id: "kimi", authKind: "api_key", vendorKey: "kimi-coding" },
];
const subscriptions = subscriptionProviderIds(providers);
const view = (usageOrBuckets) =>
  usageCostView(summarizeUsageCost(
    Array.isArray(usageOrBuckets) ? usageOrBuckets : turnProviderCosts(usageOrBuckets),
    subscriptions,
  ));

test("OAuth accounts and Kimi Coding count as subscriptions, API keys do not", () => {
  assert.deepEqual([...subscriptions].sort(), ["claude-max", "kimi"]);
});

test("USD keeps request-sized precision without rounding a real charge to zero", () => {
  assert.equal(formatUsd(0, "en"), "$0.00");
  assert.equal(formatUsd(0.0004, "en"), "<$0.001");
  assert.equal(formatUsd(0.0423, "en"), "$0.042");
  assert.equal(formatUsd(0.5, "en"), "$0.50");
  assert.equal(formatUsd(12.345, "en"), "$12.35");
  assert.equal(formatUsd(Number.NaN, "en"), "$0.00");
});

test("a provider-billed turn reads as an exact amount", () => {
  const usage = { aggregation: "aggregate", inputTokens: 20, outputTokens: 4, totalTokens: 24,
    operations: [op("a", "api", "reported", 0.02), op("b", "api", "reported", 0.01)] };
  const result = view(usage);
  assert.deepEqual(result, { kind: "billed", amount: 0.03, qualifier: "exact", unpricedRequests: 0 });
  assert.deepEqual(usageCostText(result, t, "en"), {
    text: "$0.03",
    help: "Billed amount reported by the provider.",
  });
});

test("a catalog estimate is marked as approximate", () => {
  const text = usageCostText(view(op("a", "api", "estimated", 0.042)), t, "en");
  assert.equal(text.text, "≈$0.042");
  assert.equal(text.help, "Estimated from the model's list prices.");
});

test("a request without a price turns the total into a lower bound", () => {
  const usage = { aggregation: "aggregate", inputTokens: 20, outputTokens: 4, totalTokens: 24,
    operations: [op("a", "api", "reported", 0.2), op("b", "api", "unknown")] };
  const text = usageCostText(view(usage), t, "en");
  assert.equal(text.text, "≥$0.20");
  assert.match(text.help, /\(1\)/);
});

test("subscription usage is named, with its API-price equivalent as context", () => {
  const text = usageCostText(view(op("a", "claude-max", "estimated", 1.5)), t, "en");
  assert.equal(text.text, "Subscription");
  assert.match(text.help, /About \$1\.50 at API prices/);
  const zh = usageCostText(view(op("a", "claude-max", "estimated", 1.5)), i18n.getFixedT("zh-CN"), "zh-CN");
  assert.equal(zh.text, "订阅");
});

test("mixed pay-as-you-go and subscription usage bills only the former", () => {
  const result = view([
    { providerId: "api", total: 0.4, pricedRequests: 2, reportedRequests: 2, unpricedRequests: 0 },
    { providerId: "claude-max", total: 3, pricedRequests: 5, reportedRequests: 0, unpricedRequests: 0 },
  ]);
  assert.equal(result.amount, 0.4);
  assert.equal(result.subscriptionEquivalent, 3);
  const text = usageCostText(result, t, "en");
  assert.equal(text.text, "$0.40");
  assert.match(text.help, /Subscription usage is extra, about \$3\.00/);
});

test("unpriced and empty scopes say so instead of showing $0", () => {
  assert.deepEqual(view({ inputTokens: 5, outputTokens: 1, totalTokens: 6 }), { kind: "unknown" });
  assert.equal(usageCostText({ kind: "unknown" }, t, "en").text, "—");
  assert.deepEqual(view([]), { kind: "none" });
  assert.equal(usageCostText({ kind: "none" }, t, "en"), undefined);
});

test("every locale carries the cost copy", () => {
  const keys = [
    "usageCost", "usageCostTurn", "usageCostSession", "usageCostEstimated",
    "usageCostLowerBound", "usageCostUnknown", "usageCostSubscription",
    "usageCostReportedHelp", "usageCostEstimatedHelp", "usageCostLowerBoundHelp",
    "usageCostUnknownHelp", "usageCostSubscriptionHelp",
    "usageCostSubscriptionEquivalentHelp", "usageCostPlusSubscriptionHelp",
    "usageCostSessionError",
  ];
  for (const [locale, catalog] of Object.entries(catalogs)) {
    for (const key of keys) {
      assert.equal(typeof catalog.chat?.[key], "string", `${locale} chat.${key}`);
    }
  }
});
