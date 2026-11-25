import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { IdleCacheWarming } from "./idle-cache-warming.js";

const interval = 270_000;
const windowMs = 1_800_000;
const model: Model<"openai-completions"> = {
  id: "custom-model", name: "Custom model", provider: "custom",
  api: "openai-completions", baseUrl: "https://provider.invalid/v1",
  reasoning: false, input: ["text"], contextWindow: 8_192, maxTokens: 1_024,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function response(cacheRead: number, cacheWrite = 0, input = 0): AssistantMessage {
  return {
    role: "assistant", api: model.api, provider: model.provider, model: model.id,
    content: [], stopReason: "stop", timestamp: Date.now(),
    usage: {
      input, output: 1, cacheRead, cacheWrite, totalTokens: 1 + input + cacheRead + cacheWrite,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

function arm(
  warming: IdleCacheWarming,
  refresh: (signal: AbortSignal) => Promise<AssistantMessage>,
  requestModel: Model<Api> = model,
  result = response(0, 4_096),
) {
  warming.remember({
    model: requestModel, options: {}, startedAt: Date.now(), result, metered: false, oauth: false,
    canResume: () => true, foregroundRevision: warming.foregroundRevision, refresh,
  });
  warming.settle();
}

describe("foreground prompt-cache warming", () => {
  beforeEach(() => vi.useFakeTimers({ now: 0 }));
  afterEach(() => vi.useRealTimers());

  it("runs at most six times at the unknown-TTL interval after opt-in", async () => {
    const warming = new IdleCacheWarming(() => true);
    const refresh = vi.fn(async () => response(4_096));
    arm(warming, refresh);
    await vi.advanceTimersByTimeAsync(1_000);
    warming.setForeground(true);
    await vi.advanceTimersByTimeAsync(interval - 1_001);
    expect(refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(windowMs);
    expect(refresh).toHaveBeenCalledTimes(6);
  });

  it("switches foreground conversations without extending the original schedule", async () => {
    const first = new IdleCacheWarming(() => true);
    const second = new IdleCacheWarming(() => true);
    const refreshFirst = vi.fn(async () => response(4_096));
    const refreshSecond = vi.fn(async () => response(4_096));
    first.setForeground(true);
    arm(first, refreshFirst);
    arm(second, refreshSecond);
    await vi.advanceTimersByTimeAsync(interval - 1);
    first.setForeground(false);
    second.setForeground(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(refreshFirst).not.toHaveBeenCalled();
    expect(refreshSecond).toHaveBeenCalledTimes(1);
    second.setForeground(false);
    first.setForeground(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(refreshFirst).toHaveBeenCalledTimes(1);
    first.clear();
  });

  it("never revives a candidate after the dispatch deadline", async () => {
    const warming = new IdleCacheWarming(() => true);
    const refresh = vi.fn(async () => response(4_096));
    arm(warming, refresh);
    await vi.advanceTimersByTimeAsync(301_000);
    warming.setForeground(true);
    await vi.advanceTimersByTimeAsync(windowMs);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("aborts in-flight work on focus loss", async () => {
    const warming = new IdleCacheWarming(() => true);
    const refresh = vi.fn((signal: AbortSignal) => new Promise<AssistantMessage>((resolve) => {
      signal.addEventListener("abort", () => resolve(response(0)), { once: true });
    }));
    warming.setForeground(true);
    arm(warming, refresh);
    await vi.advanceTimersByTimeAsync(interval);
    expect(refresh).toHaveBeenCalledTimes(1);
    warming.setForeground(false);
    expect(refresh.mock.calls[0][0].aborted).toBe(true);
    warming.setForeground(true);
    await vi.advanceTimersByTimeAsync(windowMs);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("stops on a miss and skips unknown caches without evidence and known long caches", async () => {
    const warming = new IdleCacheWarming(() => true);
    const refresh = vi.fn(async () => response(0, 4_096));
    warming.setForeground(true);
    arm(warming, refresh);
    await vi.advanceTimersByTimeAsync(windowMs);
    expect(refresh).toHaveBeenCalledTimes(1);
    arm(warming, refresh, model, response(0, 0, 4_096));
    await vi.advanceTimersByTimeAsync(windowMs);
    arm(warming, refresh, { ...model, promptCache: { short: 3_600 } });
    await vi.advanceTimersByTimeAsync(windowMs);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("skips adapters that would omit the maximum output token limit", async () => {
    const warming = new IdleCacheWarming(() => true);
    const refresh = vi.fn(async () => response(4_096));
    warming.setForeground(true);
    arm(warming, refresh, { ...model, api: "openai-codex-responses" });
    await vi.advanceTimersByTimeAsync(windowMs);
    arm(warming, refresh, { ...model, api: "openai-responses", compat: { supportsMaxOutputTokens: false } });
    await vi.advanceTimersByTimeAsync(windowMs);
    expect(refresh).not.toHaveBeenCalled();
  });
});
