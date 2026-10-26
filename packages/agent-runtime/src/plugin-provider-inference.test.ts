import { afterEach, expect, it, vi } from "vitest";
import { buildProviderModel, createProviderModels, type RuntimeProviderConfig } from "./provider-binding.js";

afterEach(() => vi.useRealTimers());

it("ends promptly on abort while open is pending and closes an invocation returned late", async () => {
  vi.useFakeTimers();
  let resolveOpen: (value: unknown) => void = () => undefined;
  const opening = new Promise<unknown>(resolve => { resolveOpen = resolve; });
  const calls: Record<string, unknown>[] = [];
  const provider: RuntimeProviderConfig = {
    id: "plugin:fixture.provider:gateway", name: "Fixture", modelId: "chat", apiKey: "",
    authKind: "none", supportsReasoning: false, supportedThinkingLevels: ["off"],
    pluginInference: {
      pluginId: "fixture.provider", contributionId: "gateway", runtimeId: "generation-1",
      version: 1, chat: true, images: false,
    },
    invokeProviderInference: async params => {
      calls.push(params);
      if (params.operation === "open") return opening;
      if (params.operation === "close") return { closed: true };
      throw new Error("No pull is allowed after abort");
    },
  };
  const controller = new AbortController();
  const model = buildProviderModel(provider);
  const stream = createProviderModels(provider, model).streamSimple(model, { messages: [] }, { signal: controller.signal });
  const ended = vi.fn();
  const result = stream.result().then(value => { ended(value); return value; });
  await vi.advanceTimersByTimeAsync(0);
  expect(calls.map(call => call.operation)).toEqual(["open"]);
  controller.abort();
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(ended).toHaveBeenCalledOnce();
    expect((await result).stopReason).toBe("aborted");
  } finally {
    resolveOpen({ invocationId: "late-invocation" });
    await vi.advanceTimersByTimeAsync(0);
    await result;
  }
  expect(calls.map(call => call.operation)).toEqual(["open", "close"]);
  expect(calls[1].invocationId).toBe("late-invocation");
});
