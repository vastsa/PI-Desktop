import { describe, expect, it } from "vitest";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { accountModelStream } from "./request-usage.js";
import { usageFromPi } from "./agent-messages.js";
import { addUsage, type MessageUsage } from "@pi-desktop/shared";

function response(): AssistantMessage {
  return { role: "assistant", content: [], api: "openai-completions", provider: "openai", model: "physical",
    usage: { input: 12, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 1 };
}

describe("physical request accounting", () => {
  it.each([[0, 0], [0, 4], [9, 0]])("retains cache read/write %j/%j through accounting and replay", async (cacheRead, cacheWrite) => {
    const reports: MessageUsage[] = [];
    const stream = accountModelStream({ id: "physical", provider: "openai" }, () => {
      const inner = createAssistantMessageEventStream();
      const message = response();
      Object.assign(message.usage, { cacheRead, cacheWrite, totalTokens: 15 + cacheRead + cacheWrite });
      inner.push({ type: "done", reason: "stop", message });
      inner.end();
      return inner;
    }, { onUsage: (usage) => reports.push(usage) });
    for await (const _event of stream) { /* Consume the actual Pi stream. */ }
    const replayed = usageFromPi((await stream.result()).usage);
    expect(reports).toHaveLength(1);
    for (const usage of [reports[0], replayed, addUsage(reports[0], replayed)]) {
      expect(usage).toMatchObject({ cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite,
        totalTokens: 15 + cacheRead + cacheWrite });
    }
  });

  it.each([undefined, NaN, -1])("keeps invalid or absent cache usage unknown: %s", (value) => {
    const message = response();
    for (const key of ["cacheRead", "cacheWrite"] as const) {
      if (value === undefined) Reflect.deleteProperty(message.usage, key);
      else message.usage[key] = value;
    }
    const usage = usageFromPi(message.usage);
    expect(usage).toBeDefined();
    expect(usage?.cacheReadTokens).toBeUndefined();
    expect(usage?.cacheWriteTokens).toBeUndefined();
  });

  it("reports once across iteration and result and preserves unknown price through replay", async () => {
    const reports: MessageUsage[] = [];
    const stream = accountModelStream({ id: "physical", provider: "openai" }, () => {
      const inner = createAssistantMessageEventStream();
      inner.push({ type: "done", reason: "stop", message: response() });
      inner.end();
      return inner;
    }, { providerId: "account-1", onUsage: (usage) => reports.push(usage) });
    for await (const _event of stream) { /* Consume the actual Pi stream. */ }
    const result = await stream.result();
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ providerId: "account-1", modelId: "physical", usageOrigin: "pi", costStatus: "unknown" });
    expect(reports[0]?.cost).toBeUndefined();
    expect(usageFromPi(result.usage)?.operationId).toBe(reports[0]?.operationId);
    expect(addUsage(reports[0], usageFromPi(result.usage))?.totalTokens).toBe(15);
  });

  it("preserves known free pricing with explicit resolved-model provenance", async () => {
    const stream = accountModelStream({ id: "free", provider: "openai" }, () => {
      const inner = createAssistantMessageEventStream();
      inner.push({ type: "done", reason: "stop", message: response() }); inner.end(); return inner;
    }, { costStatus: "estimated" });
    const usage = usageFromPi((await stream.result()).usage);
    expect(usage?.costStatus).toBe("estimated");
    expect(usage?.cost?.total).toBe(0);
  });

  it("allocates a distinct identity to each paid retry, including failed attempts", async () => {
    const reports: MessageUsage[] = [];
    for (const failed of [true, false]) {
      const stream = accountModelStream({ id: "physical", provider: "openai" }, () => {
        const inner = createAssistantMessageEventStream();
        const message = response();
        if (failed) { message.stopReason = "error"; inner.push({ type: "error", reason: "error", error: message }); }
        else inner.push({ type: "done", reason: "stop", message });
        inner.end(); return inner;
      }, { onUsage: (usage) => reports.push(usage) });
      await stream.result();
    }
    expect(new Set(reports.map((usage) => usage.operationId)).size).toBe(2);
    expect(addUsage(reports[0], reports[1])?.totalTokens).toBe(30);
  });
});

it("does not turn unknown native rates into a zero-dollar request", async () => {
  const stream = accountModelStream({ id: "live-only", provider: "openai" }, () => {
    const inner = createAssistantMessageEventStream();
    inner.push({ type: "done", reason: "stop", message: response() }); inner.end(); return inner;
  }, { costStatus: "estimated", nativeCost: { input: NaN, output: NaN, cacheRead: NaN, cacheWrite: NaN } });
  expect(usageFromPi((await stream.result()).usage)?.costStatus).toBe("unknown");
});

describe("provider-billed cost (Pi 1.5 totalFromProvider)", () => {
  function billed(totalFromProvider: boolean | undefined): AssistantMessage {
    const message = response();
    message.usage.cost = { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.0042,
      ...(totalFromProvider === undefined ? {} : { totalFromProvider }) };
    return message;
  }
  function run(message: AssistantMessage, options: Parameters<typeof accountModelStream>[2] = {}) {
    const reports: MessageUsage[] = [];
    const stream = accountModelStream({ id: "openrouter/model", provider: "openrouter" }, () => {
      const inner = createAssistantMessageEventStream();
      inner.push({ type: "done", reason: "stop", message }); inner.end(); return inner;
    }, { ...options, onUsage: (usage) => reports.push(usage) });
    return { stream, reports };
  }

  it("records a provider-billed total as reported, even when catalog rates are unknown", async () => {
    const { stream, reports } = run(billed(true), {
      costStatus: "estimated", nativeCost: { input: NaN, output: NaN, cacheRead: NaN, cacheWrite: NaN },
    });
    const result = await stream.result();
    expect(reports[0]).toMatchObject({ costStatus: "reported", cost: { total: 0.0042 } });
    // The persisted cost keeps the five numeric fields only.
    expect(Object.keys(reports[0]?.cost ?? {}).sort()).toEqual(["cacheRead", "cacheWrite", "input", "output", "total"]);
    // Replaying history back into Pi keeps the billed marker.
    expect(result.usage.cost.totalFromProvider).toBe(true);
    expect(usageFromPi(result.usage)?.costStatus).toBe("reported");
  });

  it.each([false, undefined])("keeps a catalog total (totalFromProvider=%s) estimated", async (flag) => {
    const { stream, reports } = run(billed(flag), { nativeCost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } });
    const result = await stream.result();
    expect(reports[0]).toMatchObject({ costStatus: "estimated", cost: { total: 0.0042 } });
    expect(result.usage.cost.totalFromProvider).toBeUndefined();
  });

  it("marks a combined total reported only when every part was billed", async () => {
    const a = run(billed(true)); await a.stream.result();
    const b = run(billed(false), { nativeCost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }); await b.stream.result();
    const c = run(billed(true)); await c.stream.result();
    expect(addUsage(a.reports[0], b.reports[0])?.costStatus).toBe("estimated");
    expect(addUsage(a.reports[0], c.reports[0])?.costStatus).toBe("reported");
  });
});
