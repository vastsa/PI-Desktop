import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream, normalizeContext, type AssistantMessage } from "@earendil-works/pi-ai";
import { buildProviderModel, type RuntimeProviderConfig } from "./provider-binding.js";
import { SubagentProviderAttempt, SUBAGENT_RECOVERY_ERROR, SUBAGENT_STALL_MS } from "./subagent-provider-attempt.js";
import { subagentModelBinding, type SubagentProviderRetryState } from "./subagent-model-binding.js";

const provider: RuntimeProviderConfig = { id: "fixture", name: "Fixture", modelId: "fixture", apiStyle: "openai-chat", baseUrl: "http://127.0.0.1/v1", apiKey: "", supportsReasoning: false, supportedThinkingLevels: ["off"] };
const model = buildProviderModel(provider);
function message(stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
  return { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, stopReason, timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
function attempt(tracker = new SubagentProviderAttempt()) {
  const source = createAssistantMessageEventStream();
  const parent = new AbortController();
  let signal: AbortSignal | undefined;
  const stream = tracker.stream(model, { signal: parent.signal }, options => { signal = options.signal; return source; });
  return { tracker, source, parent, stream, signal: () => signal };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1000); });
afterEach(() => vi.useRealTimers());

it("observes exactly 120 seconds of zero events and never aborts automatically", async () => {
  const a = attempt(); const stalled = vi.fn(); const unsubscribe = a.tracker.onStall(stalled);
  await vi.advanceTimersByTimeAsync(SUBAGENT_STALL_MS - 1);
  expect(a.tracker.snapshot().stalled).toBe(false); expect(stalled).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(a.tracker.snapshot()).toMatchObject({ phase: "provider", stalled: true, providerAttemptStartedAt: 1000 });
  expect(stalled).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(500_000);
  expect(a.signal()?.aborted).toBe(false); expect(a.parent.signal.aborted).toBe(false);
  unsubscribe(); a.parent.abort(); a.source.end(message());
});

it("thinking events refresh the deadline and invalidate even an equally stalled authorization ticket", async () => {
  const a = attempt(); const stalled = vi.fn(); const unsubscribe = a.tracker.onStall(stalled);
  await vi.advanceTimersByTimeAsync(SUBAGENT_STALL_MS);
  const ticket = a.tracker.reserve();
  a.source.push({ type: "thinking_delta", contentIndex: 0, delta: "still thinking", partial: message() });
  await vi.advanceTimersByTimeAsync(0);
  expect(a.tracker.snapshot()).toMatchObject({ stalled: false, lastProviderEventAt: 121000 });
  expect(() => a.tracker.recover(ticket)).toThrow(/resumed activity/);
  await vi.advanceTimersByTimeAsync(SUBAGENT_STALL_MS);
  expect(a.tracker.snapshot().stalled).toBe(true);
  expect(() => a.tracker.recover(ticket)).toThrow(/resumed activity/);
  a.tracker.release(ticket); unsubscribe(); a.parent.abort(); a.source.end(message());
});

it("excludes tools, between-request/backoff time and settlement from provider stalls", async () => {
  const tracker = new SubagentProviderAttempt();
  await vi.advanceTimersByTimeAsync(500_000);
  expect(() => tracker.reserve()).toThrow(/no active/);
  const a = attempt(tracker);
  a.source.push({ type: "done", reason: "stop", message: message() });
  await vi.advanceTimersByTimeAsync(0);
  tracker.toolStarted("read");
  await vi.advanceTimersByTimeAsync(500_000);
  expect(tracker.snapshot()).toMatchObject({ phase: "tools", stalled: false });
  expect(() => tracker.reserve()).toThrow(/no active/);
  tracker.toolEnded("read");
  expect(tracker.snapshot()).toMatchObject({ phase: "idle", stalled: false });
  const next = attempt(tracker);
  expect(tracker.snapshot().stalled).toBe(false);
  next.parent.abort(); tracker.settle();
  expect(tracker.snapshot()).toMatchObject({ phase: "settled", stalled: false });
  next.source.end(message());
});

it("recovers only the attempt, rejects duplicates, drains late tool events and leaves the next attempt untouched", async () => {
  const a = attempt();
  await vi.advanceTimersByTimeAsync(SUBAGENT_STALL_MS);
  const ticket = a.tracker.reserve();
  expect(() => a.tracker.reserve()).toThrow(/already pending/);
  a.tracker.recover(ticket);
  expect(a.signal()?.aborted).toBe(true); expect(a.parent.signal.aborted).toBe(false);
  expect(await a.stream.result()).toMatchObject({ stopReason: "error", errorMessage: SUBAGENT_RECOVERY_ERROR });
  a.tracker.release(ticket);
  const next = attempt(a.tracker);
  const before = a.tracker.snapshot();
  a.source.push({ type: "toolcall_delta", contentIndex: 0, delta: "late tool", partial: message() });
  a.source.push({ type: "done", reason: "stop", message: message() });
  await vi.advanceTimersByTimeAsync(0);
  expect(a.tracker.snapshot()).toEqual(before);
  const events = []; for await (const event of a.stream) events.push(event.type);
  expect(events).toEqual(["error"]);
  expect(() => a.tracker.recover(ticket)).toThrow(/changed/);
  next.parent.abort(); next.source.end(message());
});

it("Stop cancels the physical request, drops the pending authorization and ends only with the provider's own answer", async () => {
  const a = attempt(); const stall = vi.fn(); const unsubscribe = a.tracker.onStall(stall);
  await vi.advanceTimersByTimeAsync(SUBAGENT_STALL_MS);
  const ticket = a.tracker.reserve();
  a.parent.abort();
  expect(a.signal()?.aborted).toBe(true);
  expect(a.tracker.snapshot()).toMatchObject({ phase: "idle", stalled: false, recoveryPending: false });
  expect(() => a.tracker.recover(ticket)).toThrow(/changed/);
  a.tracker.release(ticket); unsubscribe();
  expect(vi.getTimerCount()).toBe(0);
  a.source.end(message("aborted"));
  expect(await a.stream.result()).toMatchObject({ stopReason: "aborted" });
});

it.each(["response", "fetch failure"] as const)("ignores a recovered transport's late %s while retaining replacement retry evidence", async late => {
  let release!: (value: Response) => void;
  let reject!: (error: Error) => void;
  const pending = new Promise<Response>((resolve, no) => { release = resolve; reject = no; });
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const tracker = new SubagentProviderAttempt();
  const retry: SubagentProviderRetryState = { claim: () => undefined };
  const binding = (id: string) => subagentModelBinding({
    provider: { ...provider, id, name: id, modelId: id },
    thinkingLevel: "off", sessionId: "callback-fixture", attempts: tracker,
  }, retry);
  const context = normalizeContext({ messages: [{ role: "user", content: "Fixture", timestamp: 1 }] });
  const old = binding("old");
  const abandoned = old.streamFn(old.model, context, { apiKey: "fixture-only", fetch: async () => { started(); return pending; } });
  await ready;
  await vi.advanceTimersByTimeAsync(SUBAGENT_STALL_MS);
  const ticket = tracker.reserve(); tracker.recover(ticket); tracker.release(ticket);
  expect(await abandoned.result()).toMatchObject({ errorMessage: SUBAGENT_RECOVERY_ERROR });
  const next = binding("next");
  const result = await next.streamFn(next.model, context, { apiKey: "fixture-only", fetch: async () => new Response(
    JSON.stringify({ error: { message: "Fixture replacement unavailable" } }),
    { status: 503, headers: { "retry-after": "3", "content-type": "application/json" } },
  ) }).result();
  expect(result.stopReason).toBe("error");
  expect(retry.status).toBe(503); expect(retry.headers?.["retry-after"]).toBe("3");
  if (late === "response") release(new Response(JSON.stringify({ error: { message: "Fixture old rate limit" } }), {
    status: 429, headers: { "retry-after": "999", "content-type": "application/json" },
  }));
  else reject(new TypeError("fetch failed", { cause: Object.assign(new Error("Fixture reset"), { code: "ECONNRESET" }) }));
  await vi.advanceTimersByTimeAsync(0);
  expect(retry.status).toBe(503); expect(retry.headers?.["retry-after"]).toBe("3"); expect(retry.failure).toBeUndefined();
  tracker.settle();
});

it("retains stalled progress after observation and reports a later physical attempt independently", async () => {
  const first = attempt();
  expect(first.tracker.consumeStallObservation()).toBe(false);
  await vi.advanceTimersByTimeAsync(SUBAGENT_STALL_MS);
  expect(first.tracker.consumeStallObservation()).toBe(true);
  expect(first.tracker.snapshot().stalled).toBe(true);
  expect(first.tracker.consumeStallObservation()).toBe(false);
  first.source.push({ type: "thinking_delta", contentIndex: 0, delta: "activity", partial: message() });
  await vi.advanceTimersByTimeAsync(SUBAGENT_STALL_MS);
  expect(first.tracker.consumeStallObservation()).toBe(false);
  first.parent.abort(); first.source.end(message());
  const next = attempt(first.tracker);
  await vi.advanceTimersByTimeAsync(SUBAGENT_STALL_MS);
  expect(next.tracker.consumeStallObservation()).toBe(true);
  next.parent.abort(); next.source.end(message());
});
