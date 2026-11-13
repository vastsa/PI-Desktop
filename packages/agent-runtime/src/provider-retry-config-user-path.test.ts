import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream, type AssistantMessage, type Models } from "@earendil-works/pi-ai";
import { DesktopAgentRuntime, type RuntimeProviderConfig } from "./runtime.js";
import { providerRateLimitDelayMs, providerSetupRetryDelayMs, delayWithAbort } from "./provider-retry.js";

// Keep real runtime and subagent wiring; replace only the provider transport.
const transport = vi.hoisted(() => vi.fn<Models["streamSimple"]>());
vi.mock("./provider-binding.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./provider-binding.js")>();
  return { ...actual, createProviderModels: (...args: Parameters<typeof actual.createProviderModels>) => {
    const models = actual.createProviderModels(...args);
    models.streamSimple = transport;
    return models;
  } };
});
const provider: RuntimeProviderConfig = {
  id: "fixture", name: "Fixture", apiKey: "", authKind: "none",
  baseUrl: "http://127.0.0.1:1/v1", modelId: "fixture", supportsReasoning: false,
  supportedThinkingLevels: ["off"],
};
function response(failed: boolean) {
  const stream = createAssistantMessageEventStream();
  const message: AssistantMessage = {
    role: "assistant", api: "openai-completions", provider: "fixture", model: "fixture",
    timestamp: Date.now(), stopReason: failed ? "error" : "stop",
    ...(failed ? { errorMessage: "OpenAI API error (503): upstream unavailable" } : {}),
    content: failed ? [] : [{ type: "text", text: "Recovered response" }],
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
  queueMicrotask(() => {
    if (failed) stream.push({ type: "error", reason: "error", error: message });
    else stream.push({ type: "done", reason: "stop", message });
    stream.end(message);
  });
  return stream;
}
const runtimes: DesktopAgentRuntime[] = [];
function fixture(overrides: Partial<ConstructorParameters<typeof DesktopAgentRuntime>[0]> = {}) {
  const runtime = new DesktopAgentRuntime({
    sessionId: "retry-config", mode: "agent", provider, thinkingLevel: "off",
    commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
    subagents: [{ name: "worker", description: "Worker", tools: ["Read"], prompt: "Work.", source: "builtin" }],
    host: { async call<T>(method: string): Promise<T> {
      if (method === "tools.fileBatchCapabilities") return { version: 1, supported: false } as T;
      return undefined as T;
    }, onNotification: () => () => {} },
    onEvent: () => {}, ...overrides,
  });
  runtimes.push(runtime);
  return runtime;
}
beforeEach(() => { transport.mockReset(); });
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose();
  vi.useRealTimers();
});

describe("restored provider retry configuration", () => {
  it("honors a fixed interval for both schedules despite server retry-after", () => {
    for (const attempt of [1, 2, 20]) {
      expect(providerRateLimitDelayMs(attempt, { "retry-after": "1" }, 0, 0.9, { fixedDelayMs: 45_000 })).toBe(45_000);
      expect(providerSetupRetryDelayMs(attempt, 0, { "retry-after-ms": "100" }, 0, { fixedDelayMs: 45_000 })).toBe(45_000);
    }
    expect(providerSetupRetryDelayMs(2, 0, undefined, 0, { fixedDelayMs: 0 })).toBe(0);
  });

  it("honors the first wait and preserves the default schedules when unset", () => {
    expect(providerSetupRetryDelayMs(1, 0, undefined, 0, { initialDelayMs: 60_000 })).toBe(60_000);
    expect(providerRateLimitDelayMs(1, undefined, 0, 0, { initialDelayMs: 60_000 })).toBe(60_000);
    expect(providerSetupRetryDelayMs(1, 0)).toBe(1_000);
    expect(providerRateLimitDelayMs(1, undefined, 0, 0)).toBe(2_000);
  });

  it("keeps long waits timer-safe and abortable", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let settled = false;
    const wait = delayWithAbort(2_147_484_647, controller.signal).then(
      () => { settled = true; },
      error => { expect(error.name).toBe("AbortError"); },
    );
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(false);
    controller.abort();
    await wait;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses the fixed interval on a main request, then resets it on a reused runtime", async () => {
    const runtime = fixture({ providerRetryMaxAttempts: 2, providerRetryFixedDelayMs: 4_500 });
    vi.useFakeTimers();
    transport.mockImplementation(() => response(transport.mock.calls.length % 2 === 1));
    const first = runtime.prompt("Recover main request", "user-1", "turn-1");
    try {
      await vi.waitFor(() => expect(runtime.getStatus().activity?.phase).toBe("retrying"));
      expect(runtime.getStatus().activity).toMatchObject({ retryDelayMs: 4_500, maxAttempts: 2 });
      await vi.advanceTimersByTimeAsync(4_500);
      await first;
      expect(transport).toHaveBeenCalledTimes(2);
      runtime.setProviderRetryLimits(undefined, undefined, undefined);
      const next = runtime.prompt("Next main request", "user-2", "turn-2");
      await vi.waitFor(() => expect(runtime.getStatus().activity?.phase).toBe("retrying"));
      expect(runtime.getStatus().activity).toMatchObject({ phase: "retrying", retryDelayMs: 1_000 });
      await vi.advanceTimersByTimeAsync(1_000);
      await next;
      expect(transport).toHaveBeenCalledTimes(4);
    } finally { await runtime.abort(); await first; }
  });

  it("passes the fixed interval into a real user-started child", async () => {
    const runtime = fixture({ providerRetryMaxAttempts: 1, providerRetryFixedDelayMs: 4_500 });
    vi.useFakeTimers();
    const times: number[] = [];
    transport.mockImplementation(() => { times.push(Date.now()); return response(times.length === 1); });
    await runtime.controlSubagent({ sessionId: "retry-config", operationId: "start-child", action: "start",
      agent: "worker", task: "Recover the delegated request" }, "child-turn");
    await vi.waitFor(() => expect(times).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(4_499 - (Date.now() - times[0]));
    expect(times).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(times).toHaveLength(2);
    expect(times[1] - times[0]).toBe(4_500);
  });

  it("stops during a configured wait without sending another request", async () => {
    const runtime = fixture({ providerRetryFixedDelayMs: 45_000 });
    vi.useFakeTimers();
    transport.mockImplementation(() => response(true));
    const run = runtime.prompt("Stop a retry", "user", "turn");
    await vi.waitFor(() => expect(runtime.getStatus().activity?.phase).toBe("retrying"));
    await runtime.abort();
    await run;
    await vi.advanceTimersByTimeAsync(50_000);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(runtime.getStatus().isRunning).toBe(false);
  });
});
