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
