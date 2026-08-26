import { describe, expect, it, vi } from "vitest";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import {
  captureProviderResponse,
  carriesRetryDelayHeaders,
  classifyProviderError,
  createProviderRetryStream,
  delayWithAbort,
  isTransientProviderRetryCode,
  providerRateLimitDelayMs,
  providerSetupRetryDelayMs,
} from "./provider-retry.js";

const model = {
  id: "model",
  api: "openai-completions",
  provider: "provider",
  name: "Model",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32_000,
  maxTokens: 4_000,
  baseUrl: "https://provider.invalid/v1",
} as any;

const context = { messages: [], tools: [] };

function assistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "openai-completions",
    provider: "provider",
    model: "model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage: "429: too many requests",
    timestamp: Date.now(),
    ...overrides,
  };
}

function failedStream(
  overrides: Partial<AssistantMessage> = {},
): ReturnType<typeof createAssistantMessageEventStream> {
  const stream = createAssistantMessageEventStream();
  const error = assistantMessage(overrides);
  queueMicrotask(() => {
    stream.push({ type: "error", reason: "error", error });
    stream.end(error);
  });
  return stream;
}

function successfulStream(): ReturnType<typeof createAssistantMessageEventStream> {
  const stream = createAssistantMessageEventStream();
  const message = assistantMessage({
    content: [{ type: "text", text: "recovered" }],
    stopReason: "stop",
    errorMessage: undefined,
  });
  queueMicrotask(() => {
    stream.push({ type: "start", partial: message });
    stream.push({ type: "done", reason: "stop", message });
    stream.end(message);
  });
  return stream;
}

describe("provider rate-limit retry", () => {
  it("uses a captured 429 status when the provider body is generic", () => {
    expect(classifyProviderError("upstream unavailable", 429)).toMatchObject({
      code: "PROVIDER_RATE_LIMITED",
      retriable: true,
      details: { providerStatus: 429 },
    });
    expect(classifyProviderError("authentication failed", 429)).toMatchObject({
      code: "PROVIDER_UNAUTHORIZED",
      retriable: false,
    });
  });

  it("prefers retry headers and bounds exponential fallback", () => {
    expect(providerRateLimitDelayMs(1, { "retry-after-ms": "1250" }, 0, 0)).toBe(1250);
    expect(providerRateLimitDelayMs(1, { "retry-after": "2" }, 0, 0)).toBe(2000);
    expect(
      providerRateLimitDelayMs(
        1,
        { "retry-after": new Date(5_000).toUTCString() },
        0,
        0,
      ),
    ).toBe(5000);
    expect(
      providerRateLimitDelayMs(
        1,
        { "retry-after": new Date(-5_000).toUTCString() },
        0,
        0,
      ),
    ).toBe(0);
    expect(providerRateLimitDelayMs(1, undefined, 0, 0)).toBe(2000);
    expect(providerRateLimitDelayMs(1, undefined, 0, 1)).toBe(2500);
    expect(providerRateLimitDelayMs(20, { "retry-after": "120" }, 0, 0)).toBe(30_000);
  });

  it("silently retries pre-stream 429s and forwards only the successful stream", async () => {
    let attempts = 0;
    const claims: Array<{ phase: string; attempt: number }> = [];
    const sleep = vi.fn(async () => undefined);
    const stream = createProviderRetryStream(
      model,
      context,
      {},
      () => {
        attempts += 1;
        return attempts < 3 ? failedStream() : successfulStream();
      },
      {
        claim: (_error, phase) => {
          const attempt = attempts;
          claims.push({ phase, attempt });
          return attempt <= 2 ? attempt : undefined;
        },
        headers: () => ({ "retry-after-ms": "1" }),
        sleep,
      },
    );

    const events: string[] = [];
    for await (const event of stream) events.push(event.type);

    expect(attempts).toBe(3);
    expect(claims).toEqual([
      { phase: "request", attempt: 1 },
      { phase: "request", attempt: 2 },
    ]);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 1, undefined);
    expect(sleep).toHaveBeenNthCalledWith(2, 1, undefined);
    expect(events).toEqual(["start", "done"]);
  });

  it("uses the captured HTTP status when the error body omits rate-limit text", async () => {
    let attempts = 0;
    const claimedCodes: string[] = [];
    const stream = createProviderRetryStream(
      model,
      context,
      {},
      () => {
        attempts += 1;
        if (attempts === 1) {
          const result = createAssistantMessageEventStream();
          const error = assistantMessage({ errorMessage: "upstream unavailable" });
          queueMicrotask(() => {
            result.push({ type: "error", reason: "error", error });
            result.end(error);
          });
          return result;
        }
        return successfulStream();
      },
      {
        claim: (error) => {
          claimedCodes.push(error.code);
          return 1;
        },
        headers: () => undefined,
        status: () => 429,
        sleep: vi.fn(async () => undefined),
      },
    );

    const events: string[] = [];
    for await (const event of stream) events.push(event.type);

    expect(attempts).toBe(2);
    expect(claimedCodes).toEqual(["PROVIDER_RATE_LIMITED"]);
    expect(events).toEqual(["start", "done"]);
  });

  it("does not promote known non-retryable errors just because status is 429", async () => {
    const claim = vi.fn(() => undefined);
    const stream = createProviderRetryStream(
      model,
      context,
      {},
      () => {
        const result = createAssistantMessageEventStream();
        const error = assistantMessage({ errorMessage: "authentication failed" });
        queueMicrotask(() => {
          result.push({ type: "error", reason: "error", error });
          result.end(error);
        });
        return result;
      },
      {
        claim,
        headers: () => undefined,
        status: () => 429,
        sleep: vi.fn(async () => undefined),
      },
    );

    const events: string[] = [];
    for await (const event of stream) events.push(event.type);

    expect(claim).toHaveBeenCalledWith(
      expect.objectContaining({ code: "PROVIDER_UNAUTHORIZED", retriable: false }),
      "request",
    );
    expect(events).toEqual(["error"]);
  });

  it("clears a captured 429 before a fetch fails without a response", async () => {
    let calls = 0;
    let snapshot: { status: number; headers: Record<string, string> } | undefined;
    const wrapped = captureProviderResponse(
      async () => {
        calls += 1;
        if (calls === 1) {
          return new Response("rate limited", { status: 429 });
        }
        throw new Error("fetch failed");
      },
      (response) => {
        snapshot = response;
      },
    );

    await wrapped("https://provider.invalid", {});
    expect(snapshot?.status).toBe(429);
    await expect(wrapped("https://provider.invalid", {})).rejects.toThrow("fetch failed");
    expect(snapshot).toBeUndefined();
  });

  it("rejects an abortable retry delay without waiting for the timer", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    try {
      const pending = delayWithAbort(30_000, controller.signal);
      controller.abort();
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps an exhausted setup 429 classified when its body omits status text", async () => {
    const stream = createProviderRetryStream(
      model,
      context,
      {},
      () => {
        const result = createAssistantMessageEventStream();
        const error = assistantMessage({ errorMessage: "upstream unavailable" });
        queueMicrotask(() => {
          result.push({ type: "error", reason: "error", error });
          result.end(error);
        });
        return result;
      },
      {
        claim: vi.fn(() => undefined),
        headers: () => undefined,
        status: () => 429,
        sleep: vi.fn(async () => undefined),
      },
    );

    const events: Array<{ type: string; error?: AssistantMessage }> = [];
    for await (const event of stream) events.push(event as typeof events[number]);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "error",
      error: { errorMessage: "429: upstream unavailable" },
    });
  });

  it("does not hide a 429 after a stream has started", async () => {
    const stream = createProviderRetryStream(
      model,
      context,
      {},
      () => {
        const result = createAssistantMessageEventStream();
        const partial = assistantMessage({ stopReason: "pending" });
        const error = assistantMessage();
        queueMicrotask(() => {
          result.push({ type: "start", partial });
          result.push({ type: "error", reason: "error", error });
          result.end(error);
        });
        return result;
      },
      {
        claim: vi.fn(() => 1),
        headers: () => undefined,
        sleep: vi.fn(async () => undefined),
      },
    );

    const events: string[] = [];
    for await (const event of stream) events.push(event.type);

    expect(events).toEqual(["start", "error"]);
  });
});

describe("bounded transient provider retry", () => {
  it("admits only the transport/gateway codes into the shared budget", () => {
    for (const code of [
      "NETWORK_ERROR",
      "TIMEOUT",
      "STREAM_FAILED",
      "PROVIDER_ERROR",
    ]) {
      expect(isTransientProviderRetryCode(code)).toBe(true);
    }
    for (const code of [
      "PROVIDER_RATE_LIMITED",
      "PROVIDER_UNAUTHORIZED",
      "CONTEXT_TOO_LARGE",
      "MODEL_NOT_CONFIGURED",
      "EMPTY_MODEL_RESPONSE",
      "TURN_ABORTED",
    ]) {
      expect(isTransientProviderRetryCode(code)).toBe(false);
    }
  });

  it("classifies an upstream gateway 502 as a retryable provider error", () => {
    const classified = classifyProviderError(
      'OpenAI API error (502): {"type":"api_error","message":"Upstream API request failed."}',
    );
    expect(classified).toMatchObject({
      code: "PROVIDER_ERROR",
      retriable: true,
      details: { providerStatus: 502 },
    });
    expect(isTransientProviderRetryCode(classified.code)).toBe(true);
  });

  it("keeps retry headers for every status that can state a delay", () => {
    expect(carriesRetryDelayHeaders(429)).toBe(true);
    expect(carriesRetryDelayHeaders(408)).toBe(true);
    expect(carriesRetryDelayHeaders(409)).toBe(true);
    expect(carriesRetryDelayHeaders(502)).toBe(true);
    expect(carriesRetryDelayHeaders(503)).toBe(true);
    expect(carriesRetryDelayHeaders(400)).toBe(false);
    expect(carriesRetryDelayHeaders(401)).toBe(false);
    expect(carriesRetryDelayHeaders(undefined)).toBe(false);
  });

  it("prefers a gateway Retry-After over exponential setup backoff", () => {
    expect(providerSetupRetryDelayMs(1, 0)).toBe(500);
    expect(providerSetupRetryDelayMs(2, 0)).toBe(1_000);
    expect(providerSetupRetryDelayMs(3, 0)).toBe(2_000);
    expect(providerSetupRetryDelayMs(1, 0, { "retry-after-ms": "1250" })).toBe(1250);
    expect(providerSetupRetryDelayMs(1, 0, { "retry-after": "2" })).toBe(2_000);
    expect(
      providerSetupRetryDelayMs(1, 0, { "retry-after": new Date(5_000).toUTCString() }, 0),
    ).toBe(5_000);
    // A hostile or stale header cannot hold the turn past the non-429 cap.
    expect(providerSetupRetryDelayMs(1, 0, { "retry-after": "600" })).toBe(8_000);
    expect(providerSetupRetryDelayMs(20, 0)).toBe(8_000);
  });

  it("applies the mid-stream floor only to calculated backoff", () => {
    const floor = 750;
    // Without a header the floor raises the short first-attempt backoff.
    expect(providerSetupRetryDelayMs(1, 0, undefined, undefined, floor)).toBe(750);
    // Later attempts already exceed the floor and keep their own value.
    expect(providerSetupRetryDelayMs(2, 0, undefined, undefined, floor)).toBe(1_000);
    // A server that asks for a shorter wait wins over the floor.
    expect(
      providerSetupRetryDelayMs(1, 0, { "retry-after-ms": "100" }, undefined, floor),
    ).toBe(100);
    // The floor never overrides the non-429 cap either.
    expect(
      providerSetupRetryDelayMs(1, 0, undefined, undefined, 99_000),
    ).toBe(8_000);
  });

  it("retries repeated pre-stream 502s until the shared budget is spent", async () => {
    let attempts = 0;
    const claims: Array<{ code: string; attempt: number }> = [];
    const delays: number[] = [];
    const stream = createProviderRetryStream(
      model,
      context,
      {},
      () => {
        attempts += 1;
        return attempts < 4
          ? failedStream({
              errorMessage:
                'OpenAI API error (502): {"type":"api_error","message":"Upstream API request failed."}',
            })
          : successfulStream();
      },
      {
        claim: (error) => {
          if (!isTransientProviderRetryCode(error.code)) return undefined;
          if (claims.length >= 3) return undefined;
          const attempt = claims.length + 1;
          claims.push({ code: error.code, attempt });
          return attempt;
        },
        headers: () => undefined,
        status: () => 502,
        sleep: async (ms) => {
          delays.push(ms);
        },
      },
    );

    const events: string[] = [];
    for await (const event of stream) events.push(event.type);

    // Three retries after the initial attempt, so four provider attempts.
    expect(attempts).toBe(4);
    expect(claims.map((claim) => claim.attempt)).toEqual([1, 2, 3]);
    expect(claims.every((claim) => claim.code === "PROVIDER_ERROR")).toBe(true);
    expect(delays).toHaveLength(3);
    // No intermediate error event reaches the consumer.
    expect(events).toEqual(["start", "done"]);
    expect((await stream.result()).stopReason).toBe("stop");
  });

  it("surfaces the 502 once the budget refuses a further attempt", async () => {
    let attempts = 0;
    const stream = createProviderRetryStream(
      model,
      context,
      {},
      () => {
        attempts += 1;
        return failedStream({
          errorMessage:
            'OpenAI API error (502): {"type":"api_error","message":"Upstream API request failed."}',
        });
      },
      {
        claim: () => (attempts <= 3 ? attempts : undefined),
        headers: () => undefined,
        status: () => 502,
        sleep: async () => undefined,
      },
    );

    const events: string[] = [];
    for await (const event of stream) events.push(event.type);

    expect(attempts).toBe(4);
    expect(events).toEqual(["error"]);
    const result = await stream.result();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("502");
  });
});
