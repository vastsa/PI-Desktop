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
    canResume: () => true, foregroundRevision: warming.foregroundRevision, idleEligible: true, refresh,
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

  it("discards a tool-use candidate when its turn settles without a wait", async () => {
    const warming = new IdleCacheWarming(() => true);
    const refresh = vi.fn(async () => response(4_096));
    warming.setWaitingAllowed(true);
    arm(warming, refresh, model, { ...response(0, 4_096), stopReason: "toolUse" });
    warming.setWaiting(true);
    await vi.advanceTimersByTimeAsync(interval);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("applies the active-turn savings threshold only while waiting", async () => {
    const modelWithCost = { ...model, cost: { input: 3, cacheRead: 0.3, cacheWrite: 3.75, output: 15 } };
    for (const waiting of [false, true]) {
      const warming = new IdleCacheWarming(() => true);
      warming.setForeground(true);
      warming.setWaitingAllowed(true);
      const refresh = vi.fn(async () => response(20_000));
      warming.remember({
        model: modelWithCost, options: {}, startedAt: Date.now(), result: response(20_000),
        metered: true, oauth: false, canResume: () => true,
        foregroundRevision: warming.foregroundRevision, idleEligible: true, refresh,
      });
      if (waiting) warming.setWaiting(true);
      else warming.settle();
      await vi.advanceTimersByTimeAsync(interval);
      expect(refresh).toHaveBeenCalledTimes(waiting ? 1 : 0);
      warming.clear();
    }
  });

  it("sends no refresh if a delegation wait ends before the first due time", async () => {
    const warming = new IdleCacheWarming(() => true);
    const refresh = vi.fn(async () => response(4_096));
    warming.setWaitingAllowed(true);
    warming.setWaiting(true);
    arm(warming, refresh);
    await vi.advanceTimersByTimeAsync(interval - 1);
    warming.setWaiting(false);
    await vi.advanceTimersByTimeAsync(windowMs);
    expect(refresh).not.toHaveBeenCalled();
  });

  it.each(["wait exit", "window permission loss"])(
    "keeps an in-flight refresh across view changes and aborts it on %s",
    async (stop) => {
      const warming = new IdleCacheWarming(() => true);
      const refresh = vi.fn((signal: AbortSignal) => new Promise<AssistantMessage>((resolve) => {
        signal.addEventListener("abort", () => resolve(response(0)), { once: true });
      }));
      warming.setForeground(true);
      warming.setWaitingAllowed(true);
      warming.setWaiting(true);
      arm(warming, refresh);
      await vi.advanceTimersByTimeAsync(interval);
      const signal = refresh.mock.calls[0][0];
      warming.setForeground(false);
      expect(signal.aborted).toBe(false);
      if (stop === "wait exit") warming.setWaiting(false);
      else warming.setWaitingAllowed(false);
      expect(signal.aborted).toBe(true);
      await vi.advanceTimersByTimeAsync(windowMs);
      expect(refresh).toHaveBeenCalledTimes(1);
    },
  );

  it("bounds background waiting to six refreshes and stops when the desktop disallows it", async () => {
    const warming = new IdleCacheWarming(() => true);
    const refresh = vi.fn(async () => response(4_096));
    warming.setWaitingAllowed(true);
    warming.setWaiting(true);
    arm(warming, refresh);
    await vi.advanceTimersByTimeAsync(windowMs);
    expect(refresh).toHaveBeenCalledTimes(6);

    arm(warming, refresh);
    warming.setWaitingAllowed(false);
    await vi.advanceTimersByTimeAsync(interval);
    expect(refresh).toHaveBeenCalledTimes(6);
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

  it("uses the OpenAI Responses default only on the official endpoint", async () => {
    const warming = new IdleCacheWarming(() => true);
    const refresh = vi.fn(async () => response(4_096));
    const openAiResponses: Model<"openai-responses"> = {
      ...model, api: "openai-responses", baseUrl: "https://api.openai.com/v1",
      compat: { supportsExplicitPromptCacheMode: true },
    };

    warming.setWaitingAllowed(true);
    warming.setWaiting(true);
    arm(warming, refresh, openAiResponses);
    await vi.advanceTimersByTimeAsync(interval);
    expect(refresh).not.toHaveBeenCalled();

    arm(warming, refresh, { ...openAiResponses, baseUrl: "https://provider.invalid/v1" });
    await vi.advanceTimersByTimeAsync(interval);
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
