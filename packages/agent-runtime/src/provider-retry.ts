import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Context,
  type FetchFunction,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { PROVIDER_RETRY_MAX_RETRIES } from "@pi-desktop/shared";
import {
  classifyAgentError,
  type ClassifiedAgentError,
} from "./agent-errors.js";
import {
  describeProviderFetchFailure,
  type ProviderFetchFailure,
  withProviderFetchFailure,
} from "./provider-transport-recovery.js";
/** Maximum number of retries after the first rate-limited request. */
export const PROVIDER_RATE_LIMIT_MAX_RETRIES = PROVIDER_RETRY_MAX_RETRIES;
export const PROVIDER_RATE_LIMIT_INITIAL_DELAY_MS = 2_000;
export const PROVIDER_RATE_LIMIT_JITTER_FACTOR = 0.25;
/** Keep a provider outage bounded even when it sends an unusably long delay. */
export const PROVIDER_RATE_LIMIT_MAX_DELAY_MS = 30_000;
/**
 * Non-rate-limit transient failures wait 1s, 2s, 4s, then 8s. Later retries
 * stay at the capped 8-second wait so the ten-retry budget remains predictable.
 */
export const PROVIDER_SETUP_RETRY_INITIAL_DELAY_MS = 1_000;
export const PROVIDER_SETUP_MAX_RETRY_DELAY_MS = 8_000;
/**
 * Retries allowed after the first non-rate-limit transient failure. Upstream
 * gateway faults (502/503/504, dropped
 * sockets) routinely need more than one attempt, so they share one bounded
 * response-recovery budget the way rate limits do instead of getting a single retry
 * per phase.
 */
export const PROVIDER_TRANSIENT_MAX_RETRIES = PROVIDER_RETRY_MAX_RETRIES;

export type ProviderRetryPhase = "request" | "stream";

/**
 * Error codes that may claim the shared non-429 transient budget. Codes outside
 * this set stay terminal even when `retriable` is set, because they are
 * repaired by a different recovery path than re-sending the same request.
 */
const TRANSIENT_RETRY_CODES = new Set([
  "NETWORK_ERROR",
  "TIMEOUT",
  "STREAM_FAILED",
  "PROVIDER_ERROR",
]);

/** Whether a classified error may claim the shared non-429 transient budget. */
export function isTransientProviderRetryCode(code: string): boolean {
  return TRANSIENT_RETRY_CODES.has(code);
}

/**
 * Statuses whose response headers can carry a usable retry delay. Gateway 5xx
 * and 408/409 responses often ship `Retry-After`, so keeping their headers lets
 * a transient retry honor server pacing instead of guessing a backoff.
 */
export function carriesRetryDelayHeaders(status: number | undefined): boolean {
  if (status === undefined) return false;
  return status === 429 || status === 408 || status === 409 || status >= 500;
}

/** OpenAI-style SDK clients summarize an unreadable failure as "<status> status code (no body)". */
const OPAQUE_ERROR_BODY_PATTERN = /\(\s*no\s+body\s*\)\s*$/i;

/**
 * A pre-stream 400/422 whose body is empty gives the caller nothing to act on.
 * The classifier marks those statuses terminal precisely because re-sending
 * the same request cannot help — but the request itself was assembled from
 * catalog-derived values (the auto-filled output limit above all) that an
 * OpenAI-compatible gateway is free to reject without a word. Detecting the
 * opaque shape here lets the retry loop attempt one informed repair instead of
 * surfacing a dead end like "400 status code (no body)".
 */
export function isOpaqueBadRequest(error: ClassifiedAgentError): boolean {
  const providerStatus = error.details?.providerStatus;
  return (
    error.code === "PROVIDER_ERROR" &&
    !error.retriable &&
    (providerStatus === 400 || providerStatus === 422) &&
    OPAQUE_ERROR_BODY_PATTERN.test(error.message)
  );
}

const OUTPUT_LIMIT_FIELDS = [
  "max_tokens",
  "max_completion_tokens",
  "max_output_tokens",
] as const;

/** Drop the auto-derived output-limit fields, leaving the provider's own default in effect. */
export function stripOutputLimitFields(payload: unknown): unknown {
  if (typeof payload !== "object" || payload === null) return payload;
  const rest = { ...(payload as Record<string, unknown>) };
  for (const field of OUTPUT_LIMIT_FIELDS) delete rest[field];
  return rest;
}

/**
 * Request options for the one repair attempt: the outgoing payload keeps every
 * caller- and catalog-derived field except the output limit, and any caller
 * `onPayload` hook still runs (its result is what gets stripped).
 */
export function withoutDerivedOutputLimit(
  options: SimpleStreamOptions,
): SimpleStreamOptions {
  return {
    ...options,
    onPayload: async (payload, model) => {
      const rewritten = await options.onPayload?.(payload, model);
      return stripOutputLimitFields(rewritten ?? payload);
    },
  };
}

export type ProviderResponseSnapshot = {
  status: number;
  headers: Record<string, string>;
};

export type ProviderRetryController = {
  /** Claim one retry across setup/stream failures of the current response. */
  claim: (
    error: ClassifiedAgentError,
    phase: ProviderRetryPhase,
  ) => number | undefined;
  /** Headers captured from the failed HTTP response, if any. */
  headers: () => Readonly<Record<string, string>> | undefined;
  /** Status captured even when the provider body omits the HTTP code. */
  status?: () => number | undefined;
  /** Cause captured for the attempt that just failed, when the fetch rejected. */
  failure?: () => ProviderFetchFailure | undefined;
  onRetry?: (input: {
    error: ClassifiedAgentError;
    phase: ProviderRetryPhase;
    attempt: number;
    delayMs: number;
  }) => void;
  /** Test hook; production uses the abortable timer below. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

/**
 * Apply a captured HTTP 429 before relying on provider error wording. Some
 * adapters return a generic body (or `fetch failed`) even though the response
 * status is rate limiting. Keep explicit non-retryable classifications such as
 * auth and context errors terminal.
 */
export function classifyProviderError(
  error: unknown,
  providerStatus?: number,
): ClassifiedAgentError {
  const classified = classifyAgentError(error);
  if (
    providerStatus === 429 &&
    classified.code !== "PROVIDER_RATE_LIMITED" &&
    classified.retriable
  ) {
    return {
      ...classified,
      code: "PROVIDER_RATE_LIMITED",
      retriable: true,
      details: {
        ...classified.details,
        providerStatus,
      },
    };
  }
  return classified;
}

function headerValue(
  headers: Readonly<Record<string, string>> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const entry = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === name,
  );
  return entry?.[1];
}

function boundedServerDelay(
  value: number,
  maxDelayMs = PROVIDER_RATE_LIMIT_MAX_DELAY_MS,
): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(maxDelayMs, Math.max(0, Math.ceil(value)));
}

/**
 * Read the server's requested delay in OpenCode's order of precedence:
 * provider milliseconds, `Retry-After` seconds, then `Retry-After` HTTP-date.
 * Returns undefined when no usable header is present.
 */
function serverRetryDelayMs(
  headers: Readonly<Record<string, string>> | undefined,
  maxDelayMs: number,
  now: number,
): number | undefined {
  const retryAfterMs = headerValue(headers, "retry-after-ms");
  if (retryAfterMs !== undefined && retryAfterMs.trim() !== "") {
    const parsed = Number.parseFloat(retryAfterMs);
    if (!Number.isNaN(parsed)) return boundedServerDelay(parsed, maxDelayMs);
  }

  const retryAfter = headerValue(headers, "retry-after");
  if (retryAfter !== undefined && retryAfter.trim() !== "") {
    const seconds = Number.parseFloat(retryAfter);
    if (!Number.isNaN(seconds)) {
      return boundedServerDelay(seconds * 1_000, maxDelayMs);
    }
    const dateMs = Date.parse(retryAfter) - now;
    if (!Number.isNaN(dateMs)) {
      return boundedServerDelay(dateMs, maxDelayMs);
    }
  }
  return undefined;
}

/**
 * OpenCode's order of precedence: provider milliseconds, Retry-After seconds,
 * HTTP-date, then exponential backoff with positive jitter. Header values are
 * capped so a bad or stale server response cannot hold a turn indefinitely.
 */
export function providerRateLimitDelayMs(
  attempt: number,
  headers?: Readonly<Record<string, string>>,
  now = Date.now(),
  random = Math.random(),
): number {
  const serverDelay = serverRetryDelayMs(
    headers,
    PROVIDER_RATE_LIMIT_MAX_DELAY_MS,
    now,
  );
  if (serverDelay !== undefined) return serverDelay;

  const safeAttempt = Math.max(1, Math.floor(attempt));
  const base = PROVIDER_RATE_LIMIT_INITIAL_DELAY_MS * 2 ** (safeAttempt - 1);
  const jitter = Math.min(1, Math.max(0, random));
  return Math.min(
    PROVIDER_RATE_LIMIT_MAX_DELAY_MS,
    Math.ceil(base + base * PROVIDER_RATE_LIMIT_JITTER_FACTOR * jitter),
  );
}

/**
 * Plain doubling: 1s, 2s, 4s, 8s per attempt. A gateway that states its own
 * `Retry-After` wins outright, so an upstream 502/503 burst clears by waiting
 * as long as the server asked, capped so a bad header cannot hold the turn.
 *
 * `random` is accepted for signature compatibility with the rate-limit delay
 * and is intentionally unused: a predictable schedule is easier to reason about
 * for a single failed request, and the retries are not synchronized across
 * sessions the way a rate-limit burst is.
 */
export function providerSetupRetryDelayMs(
  attempt: number,
  random?: number,
  headers?: Readonly<Record<string, string>>,
  now = Date.now(),
): number {
  void random;
  const serverDelay = serverRetryDelayMs(
    headers,
    PROVIDER_SETUP_MAX_RETRY_DELAY_MS,
    now,
  );
  // A server-stated delay wins outright, including one shorter than the
  // caller's floor: the gateway knows when it will be ready again.
  if (serverDelay !== undefined) return serverDelay;
  const safeAttempt = Math.max(1, Math.floor(attempt));
  const base = PROVIDER_SETUP_RETRY_INITIAL_DELAY_MS * 2 ** (safeAttempt - 1);
  return Math.min(PROVIDER_SETUP_MAX_RETRY_DELAY_MS, base);
}

function requestAbortedError(): Error {
  return Object.assign(new Error("Request aborted"), { name: "AbortError" });
}

export function delayWithAbort(
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(requestAbortedError());
      return;
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      if (timeout) clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      reject(Object.assign(new Error("Request aborted"), { name: "AbortError" }));
    };
    timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(0, ms));
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Serialized request body size, without ever inspecting the body: only the byte
 * length is retained, never the content. Request size is the one correlation
 * signal from the reporter of issue #234 that is safe to keep on every attempt.
 */
function requestBodyBytes(body: unknown): number | undefined {
  if (typeof body === "string") return Buffer.byteLength(body, "utf8");
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  if (typeof Blob !== "undefined" && body instanceof Blob) return body.size;
  return undefined;
}

/** Capture HTTP status/headers, including failed 429 responses that pi-ai's
 * onResponse callback intentionally does not expose. The second argument is the
 * outgoing request size, reported even when the request dies before headers, and
 * the third is the transport cause of a rejection — the same two signals the
 * reporter of issue #234 had no way to read. */
export function captureProviderResponse(
  fetchFn: FetchFunction | undefined,
  onResponse: (
    response?: ProviderResponseSnapshot,
    requestBytes?: number,
    failure?: ProviderFetchFailure,
  ) => void,
): FetchFunction {
  const baseFetch = fetchFn ?? globalThis.fetch;
  return async (input, init) => {
    // Clear the previous response before a new fetch. If this request fails
    // before receiving headers, a prior 429 must not classify the new failure.
    onResponse();
    const requestBytes = requestBodyBytes(init?.body);
    try {
      const response = await baseFetch(input, init);
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
      onResponse({ status: response.status, headers }, requestBytes);
      return response;
    } catch (error) {
      // Last point that still sees the original Error: pi-ai hands the runtime a
      // flattened `errorMessage`, in which the errno undici keeps in
      // `error.cause` is already gone (issue #234). Describing it here does not
      // change the rejection the provider sees.
      onResponse(
        undefined,
        requestBytes,
        describeProviderFetchFailure(error, input),
      );
      throw error;
    }
  };
}

function normalizeRateLimitMessage(message: AssistantMessage): AssistantMessage {
  const errorMessage = message.errorMessage ?? "";
  if (/^\s*429\b/.test(errorMessage)) return message;
  return {
    ...message,
    errorMessage: `429: ${errorMessage || "provider rate limited"}`,
  };
}

function setupErrorMessage(
  model: Model<Api>,
  error: unknown,
  aborted: boolean,
): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: aborted ? "aborted" : "error",
    errorMessage: error instanceof Error ? error.message : String(error),
    timestamp: Date.now(),
  };
}

type StreamFactory = (
  options: SimpleStreamOptions,
) => AssistantMessageEventStream;

/**
 * pi-ai returns setup failures as an error event rather than throwing. This
 * adapter consumes only those pre-stream failures, retries them through the
 * shared controller, and forwards every event from a started stream unchanged
 * so runtime mid-stream recovery can replace the visible assistant safely.
 */
export function createProviderRetryStream(
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions,
  createStream: StreamFactory,
  controller: ProviderRetryController,
): AssistantMessageEventStream {
  // Keep the context in the signature: it prevents callers from accidentally
  // building a retry stream around a different request than the provider call.
  void context;
  const outer = createAssistantMessageEventStream();
  const sleep = controller.sleep ?? delayWithAbort;

  void (async () => {
    // One repair per logical turn: after an opaque 400/422 the next attempt
    // drops the derived output limit. Repairing never consumes the shared
    // transient budget, and a second opaque failure surfaces untouched.
    let limitRepairTried = false;
    for (;;) {
      if (options.signal?.aborted) throw requestAbortedError();
      const inner = createStream({
        ...(limitRepairTried ? withoutDerivedOutputLimit(options) : options),
        maxRetries: 0,
      });
      let sawStart = false;
      let retry:
        | { error: ClassifiedAgentError; attempt: number }
        | undefined;
      let opaqueLimitRejection: ClassifiedAgentError | undefined;

      for await (const event of inner) {
        if (event.type === "start") sawStart = true;
        if (
          !sawStart &&
          event.type === "error" &&
          event.reason === "error"
        ) {
          const errorMessage =
            typeof event.error.errorMessage === "string"
              ? event.error.errorMessage
              : event.error;
          // Fold in the cause the fetch wrapper captured for this attempt: the
          // message pi-ai hands over is already flattened, so without it the
          // retry indicator and the terminal error read `fetch failed` with no
          // errno (issue #234).
          const error = withProviderFetchFailure(
            classifyProviderError(errorMessage, controller.status?.()),
            controller.failure?.(),
          );
          if (!limitRepairTried && isOpaqueBadRequest(error)) {
            opaqueLimitRejection = error;
            break;
          }
          const attempt = controller.claim(error, "request");
          if (attempt !== undefined) {
            retry = { error, attempt };
            break;
          }
        }
        const forwardedEvent =
          event.type === "error" &&
          event.reason === "error" &&
          controller.status?.() === 429
            ? { ...event, error: normalizeRateLimitMessage(event.error) }
            : event;
        outer.push(forwardedEvent);
      }

      if (opaqueLimitRejection) {
        // Drain the ended stream so providers with deferred cleanup do not
        // overlap the repair request, mirroring the retry path below.
        await inner.result();
        if (options.signal?.aborted) throw requestAbortedError();
        limitRepairTried = true;
        continue;
      }

      if (!retry) {
        const result = await inner.result();
        const finalResult =
          result.stopReason === "error" && controller.status?.() === 429
            ? normalizeRateLimitMessage(result)
            : result;
        outer.end(finalResult);
        return;
      }

      // The failed event has already ended this inner stream. Awaiting its
      // result keeps providers with deferred cleanup from overlapping retries.
      await inner.result();
      const delayMs =
        retry.error.code === "PROVIDER_RATE_LIMITED"
          ? providerRateLimitDelayMs(
              retry.attempt,
              controller.headers(),
            )
          : providerSetupRetryDelayMs(
              retry.attempt,
              undefined,
              controller.headers(),
            );
      controller.onRetry?.({
        error: retry.error,
        phase: "request",
        attempt: retry.attempt,
        delayMs,
      });
      await sleep(delayMs, options.signal);
    }
  })().catch((error) => {
    const aborted =
      options.signal?.aborted ||
      (error instanceof Error && error.name === "AbortError");
    const message = setupErrorMessage(model, error, Boolean(aborted));
    outer.push({
      type: "error",
      reason: message.stopReason === "aborted" ? "aborted" : "error",
      error: message,
    });
    outer.end(message);
  });

  return outer;
}

/**
 * Default zero-event idle budget for a provider stream: a stream that emits
 * nothing for this long is ended as a retriable stream failure so the shared
 * transient retry path re-runs the request instead of leaving the turn hung on
 * a connection the provider never closes.
 */
export const STREAM_IDLE_TIMEOUT_DEFAULT_MS = 180_000;

/**
 * The smallest idle budget a positive override may set. The watchdog wraps the
 * whole retry adapter, so the backoff wait between two attempts is zero-event
 * time to it: a budget below the largest retry delay would end a turn that is
 * pacing exactly as the provider asked it to. `0` still disables the watchdog
 * outright — this floor only clamps a positive override.
 */
export const STREAM_IDLE_TIMEOUT_FLOOR_MS = PROVIDER_RATE_LIMIT_MAX_DELAY_MS;

/**
 * `PI_DESKTOP_STREAM_IDLE_TIMEOUT_MS` overrides the zero-event idle budget;
 * `0` disables the watchdog, and any other override is clamped up to
 * `STREAM_IDLE_TIMEOUT_FLOOR_MS` (see above). A value that is not a number, or
 * is negative, keeps the default.
 */
export function streamIdleTimeoutMs(): number {
  const raw = process.env.PI_DESKTOP_STREAM_IDLE_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === "") {
    return STREAM_IDLE_TIMEOUT_DEFAULT_MS;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    return STREAM_IDLE_TIMEOUT_DEFAULT_MS;
  }
  if (value === 0) return 0;
  return Math.max(STREAM_IDLE_TIMEOUT_FLOOR_MS, Math.floor(value));
}

function streamIdleTimeoutMessage(timeoutMs: number): string {
  return `stream stalled: no provider events for ${timeoutMs}ms`;
}

/**
 * Zero-event idle watchdog around a provider stream. Every event resets the
 * timer and total stream duration is never limited, so a long but productive
 * stream is forwarded unchanged. A stream that stays silent for `timeoutMs` is
 * ended as a `STREAM_FAILED`-classified error result — the same shape a dropped
 * socket produces — so the existing transient retry budget picks it up instead
 * of adding a second recovery path.
 *
 * `onStall` is the caller's chance to *stop* what this watchdog abandons, and a
 * caller that can must pass it. The wrapper sits outside the retry adapter, so
 * `inner` is that adapter: draining it without aborting it lets it wake from a
 * backoff and open a second request for the same turn while the runtime is
 * already re-running the turn — two provider requests and two bills for one
 * answer. Aborting the request's own signal is what makes the adapter's next
 * attempt refuse to start and its backoff sleep reject. The abandoned stream is
 * drained either way, so its queued events are released rather than left to
 * pile up behind a consumer that has stopped reading.
 */
export function withStreamIdleTimeout(
  inner: AssistantMessageEventStream,
  model: Model<Api>,
  timeoutMs: number,
  onStall?: () => void,
): AssistantMessageEventStream {
  if (timeoutMs <= 0) return inner;
  const outer = createAssistantMessageEventStream();

  void (async () => {
    const iterator = inner[Symbol.asyncIterator]();
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const idle = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(streamIdleTimeoutMessage(timeoutMs))),
          timeoutMs,
        );
      });
      let step: IteratorResult<AssistantMessageEvent>;
      try {
        step = await Promise.race([iterator.next(), idle]);
      } catch {
        clearTimeout(timer);
        // Stop before draining: the abort is what keeps the adapter from
        // starting another request behind the retry the runtime is already
        // running (see the doc comment above).
        onStall?.();
        drainAbandonedStream(iterator);
        const message = setupErrorMessage(
          model,
          new Error(streamIdleTimeoutMessage(timeoutMs)),
          false,
        );
        outer.push({ type: "error", reason: "error", error: message });
        outer.end(message);
        return;
      }
      clearTimeout(timer);
      if (step.done) {
        outer.end(await inner.result());
        return;
      }
      outer.push(step.value);
      if (step.value.type === "done" || step.value.type === "error") {
        return;
      }
    }
  })().catch((error) => {
    // The driver only rejects on a programming error; surface it the way the
    // retry adapter does so a consumer never waits on a dead wrapper.
    const message = setupErrorMessage(model, error, false);
    outer.push({ type: "error", reason: "error", error: message });
    outer.end(message);
  });

  return outer;
}

/** Keep consuming an abandoned stream so its queued events are released. */
function drainAbandonedStream(
  iterator: AsyncIterator<AssistantMessageEvent>,
): void {
  void (async () => {
    try {
      for (;;) {
        const step = await iterator.next();
        if (step.done) return;
      }
    } catch {
      // The stalled stream's own late failures are not ours to surface.
    }
  })();
}
