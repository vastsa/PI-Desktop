import { describe, expect, it } from "vitest";
import { addUsage, withUsageIdentity, type MessageUsage } from "./types.js";

const parent: MessageUsage = {
  inputTokens: 200,
  outputTokens: 80,
  totalTokens: 280,
};

const subagent: MessageUsage = {
  inputTokens: 100,
  outputTokens: 50,
  cacheReadTokens: 10,
  totalTokens: 160,
};

describe("addUsage", () => {
  it("returns the other side when one argument is missing", () => {
    expect(addUsage(undefined, parent)).toEqual(parent);
    expect(addUsage(parent, undefined)).toEqual(parent);
    expect(addUsage(undefined, undefined)).toBeUndefined();
  });

  it("sums required fields and optional cache/reasoning when either side has them", () => {
    expect(addUsage(parent, subagent)).toEqual({
      inputTokens: 300,
      outputTokens: 130,
      cacheReadTokens: 10,
      totalTokens: 440,
    });
  });

  const operation = (operationId: string, usage = parent): MessageUsage => ({
    ...usage, operationId, usageOrigin: "pi", aggregation: "operation",
    providerId: "physical-account", modelId: "physical-model",
    cost: { input: 0.2, output: 0.1, cacheRead: 0, cacheWrite: 0, total: 0.3 },
    costStatus: "estimated",
  });

  it("deduplicates replayed message_end and parent turn_end by physical operation", () => {
    const first = operation("parent");
    const child = operation("child", subagent);
    const rollup = addUsage(first, child);
    const replay = addUsage(addUsage(rollup, child), rollup);
    expect(replay).toEqual(rollup);
    expect(replay?.totalTokens).toBe(440);
    expect(replay?.cost?.total).toBe(0.6);
    expect(replay?.operations).toHaveLength(2);
  });

  it("counts classifier, image requests and nested delegates independently, not artifacts", () => {
    const records = ["classifier", "image-request-1", "image-request-1", "image-request-2", "nested-delegate"];
    const usage = records.reduce<MessageUsage | undefined>((acc, id) => addUsage(acc, operation(id)), undefined);
    expect(usage?.totalTokens).toBe(4 * parent.totalTokens);
    expect(usage?.operations?.map((item) => item.operationId)).toEqual([
      "classifier", "image-request-1", "image-request-2", "nested-delegate",
    ]);
    expect(addUsage(usage, JSON.parse(JSON.stringify(usage)))).toEqual(usage);
  });

  it("retains known costs on operations when one request's price is unknown", () => {
    const unknown = withUsageIdentity(subagent, { operationId: "unknown", costStatus: "unknown" });
    const usage = addUsage(operation("known"), unknown);
    expect(usage?.costStatus).toBe("unknown");
    expect(usage?.cost).toBeUndefined();
    expect(usage?.operations?.[0].cost?.total).toBe(0.3);
    expect(addUsage(usage, unknown)).toEqual(usage);
  });

  it("preserves legacy token-only totals when mixed with attributed aggregates", () => {
    const known = operation("new");
    const usage = addUsage(parent, known);
    expect(addUsage(usage, known)?.totalTokens).toBe(560);
    expect(usage?.costStatus).toBe("unknown");
    expect(usage?.cost).toBeUndefined();
  });

  it("attributes legacy messages once and never overwrites a physical identity", () => {
    const legacy = withUsageIdentity(parent, { operationId: "message-id", usageOrigin: "legacy" });
    expect(addUsage(legacy, legacy)?.totalTokens).toBe(parent.totalTokens);
    expect(withUsageIdentity(legacy, { operationId: "tool-parent" })).toBe(legacy);
    const aggregate = addUsage(legacy, operation("another"));
    expect(withUsageIdentity(aggregate, { operationId: "tool-parent" })).toBe(aggregate);
  });

  it("does not replace complete reports with late partial snapshots", () => {
    const complete = operation("request");
    const partial = operation("request", { inputTokens: 1, outputTokens: 1, totalTokens: 2 });
    expect(addUsage(complete, partial)?.totalTokens).toBe(280);
    expect(addUsage(partial, complete)?.totalTokens).toBe(280);
    expect(addUsage(complete, operation("paid-retry"))?.totalTokens).toBe(560);
  });
});

it("an equal-token replay cannot erase a known operation cost", () => {
  const known: MessageUsage = { ...parent, operationId: "request", costStatus: "reported",
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 } };
  const unknown: MessageUsage = { ...parent, operationId: "request", costStatus: "unknown" };
  for (const [a, b] of [[known, unknown], [unknown, known]]) {
    const result = addUsage(a, b);
    expect(result?.costStatus).toBe("reported");
    expect(result?.cost?.total).toBe(3);
  }
});

it("malformed prices and overflowing cost totals remain unknown", () => {
  const priced = (operationId: string, total: number): MessageUsage => ({ inputTokens: 1, outputTokens: 0, totalTokens: 1,
    operationId, costStatus: "reported", cost: { input: total, output: 0, cacheRead: 0, cacheWrite: 0, total } });
  for (const value of [NaN, Infinity, -1, Number.MAX_VALUE]) {
    const result = addUsage(priced("a", value), priced("b", value));
    expect(result?.costStatus).toBe("unknown");
    expect(result?.cost).toBeUndefined();
  }
});
