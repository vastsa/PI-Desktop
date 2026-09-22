/**
 * Extension-visible provider request surface (extension-model-registry plan, S2).
 *
 * `ctx.providers.request` is deliberately not a completion API: the caller
 * supplies the path, so the same member reaches `/chat/completions`,
 * `/images/generations`, `/embeddings`, or `/models`. The host contributes the
 * destination origin, the credential, and the transport policy — never a
 * protocol. This module is only the client: it names the target `providerId`
 * on every call, forwards the request to main, and lets main decide.
 *
 * `providerId` has no default (plan D3): a request cannot silently land on a
 * provider the caller never named.
 *
 * Cancellation is bidirectional (plan D8): the caller's `signal` mints a
 * `callId`, sends it with the request, and on abort sends
 * `extensions.providers.abort` for that same id, because the transport cannot
 * cancel a peer's work on its own.
 */

import { randomUUID } from "node:crypto";

/** The HTTP methods this surface accepts; every other value is `INVALID_ARGUMENT`. */
export type ExtensionProviderRequestMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE";

/**
 * The body union. The host never guesses: it assembles exactly the shape the
 * caller asked for, and the host owns `content-type` (plan D3).
 */
export type ExtensionProviderRequestBody =
  /** Serialized by the host; `content-type: application/json`. */
  | { kind: "json"; value: unknown }
  /** Opaque text. */
  | { kind: "text"; value: string; contentType?: string }
  /** Small binary payload, base64-encoded by the caller. */
  | { kind: "base64"; value: string; contentType?: string }
  /** `multipart/form-data`; the host generates the boundary. */
  | {
      kind: "multipart";
      fields?: Array<{ name: string; value: string }>;
      files?: Array<{
        name: string;
        path: string;
        filename?: string;
        contentType?: string;
      }>;
    };

export type ExtensionProviderRequestInput = {
  providerId: string;
  /** Recommended: selects model-specific provider detail. Never injected into the body. */
  modelId?: string;
  /** Appended to the provider's `baseUrl`, after validation (plan §5.3). */
  path: string;
  method?: ExtensionProviderRequestMethod;
  headers?: Record<string, string>;
  body?: ExtensionProviderRequestBody;
  /** Default 60 000 ms, maximum 300 000 ms. */
  timeoutMs?: number;
  /** Cancels the call; the host aborts the request it is already running. */
  signal?: AbortSignal;
};

/**
 * An HTTP response — including 4xx and 5xx — is a result, not a host error
 * (plan D6). Redirects are never followed; their status and `location` come
 * back here for the caller to decide.
 */
export type ExtensionProviderRequestResult = {
  status: number;
  statusText?: string;
  ok: boolean;
  contentType?: string;
  /** Response headers, minus `set-cookie` and the credential header. */
  headers: Record<string, string>;
  body: { kind: "json" | "text" | "base64"; value: unknown; bytes: number };
  location?: string;
  /** `Retry-After`, so a caller can pace itself; the host never auto-retries. */
  retryAfterMs?: number;
  durationMs: number;
};

/** The member an extension reaches through `ctx.providers.request`. */
export interface ExtensionProviderAccess {
  request(
    input: ExtensionProviderRequestInput,
  ): Promise<ExtensionProviderRequestResult>;
}

/**
 * The bridge member behind `ctx.providers`. `extensionId` is the caller's
 * *claimed* identity: main gates on state it owns and uses this id for audit
 * attribution only (plan D7), so the wire never carries authority.
 */
export interface ExtensionProviderRequester {
  request(
    extensionId: string,
    input: ExtensionProviderRequestInput,
  ): Promise<ExtensionProviderRequestResult>;
  /**
   * Abort every call still outstanding. Called on runtime disposal so a call
   * that outlives its Runner does not keep a socket — and a credential — alive
   * (plan D8).
   */
  dispose(): void;
}

export const PROVIDER_REQUEST_DEFAULT_TIMEOUT_MS = 60_000;
export const PROVIDER_REQUEST_MAX_TIMEOUT_MS = 300_000;
/**
 * Transport slack over the caller's budget. `rpcTimeoutMs` defaults to 130 s
 * and cannot know this budget, so the deadline is always passed explicitly.
 */
const TRANSPORT_SLACK_MS = 15_000;
/** An abort is a side channel; it never becomes an unhandled rejection. */
const ABORT_CALL_TIMEOUT_MS = 5_000;

const REQUEST_METHOD = "extensions.providers.request";
const ABORT_METHOD = "extensions.providers.abort";

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function abortedError(): Error {
  return Object.assign(new Error("The provider request was aborted"), {
    errorCode: "ABORTED",
  });
}

/** A usable budget for the transport deadline; main validates the value itself. */
function deadlineFor(timeoutMs: unknown): number {
  const budget =
    typeof timeoutMs === "number" &&
    Number.isFinite(timeoutMs) &&
    timeoutMs > 0 &&
    timeoutMs <= PROVIDER_REQUEST_MAX_TIMEOUT_MS
      ? Math.ceil(timeoutMs)
      : PROVIDER_REQUEST_DEFAULT_TIMEOUT_MS;
  return budget + TRANSPORT_SLACK_MS;
}

/**
 * The client's own give-up for one call. The transport proxy rejects with a bare
 * message when its deadline passes, so this surface answers with its own
 * `TIMEOUT` instead — and sends the abort for the call it is no longer waiting
 * on, so the provider socket does not outlive the caller (plan D8).
 */
function createCallDeadline(
  callId: string,
  budgetMs: number,
  abortCall: (callId: string) => void,
): { promise: Promise<never>; clear: () => void } {
  let rejectDeadline: (error: Error) => void = () => undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject;
  });
  const timer = setTimeout(() => {
    abortCall(callId);
    rejectDeadline(
      Object.assign(new Error("The provider request exceeded its budget"), {
        errorCode: "TIMEOUT",
      }),
    );
  }, budgetMs);
  return { promise, clear: () => clearTimeout(timer) };
}

export type ExtensionProviderRequesterOptions = {
  callHost: (
    method: string,
    params: unknown,
    timeoutOverrideMs?: number,
  ) => Promise<unknown>;
  sessionId: string;
};

/**
 * One requester per Runner (one session). It keeps no module-level state: a
 * sidecar process serves every session and shares one module instance across
 * them (spec 16 §4.3), so the in-flight set belongs to the requester.
 */
export function createExtensionProviderRequester(
  options: ExtensionProviderRequesterOptions,
): ExtensionProviderRequester {
  const inFlight = new Set<string>();

  const abortCall = (callId: string): void => {
    void options
      .callHost(
        ABORT_METHOD,
        { sessionId: options.sessionId, callId },
        ABORT_CALL_TIMEOUT_MS,
      )
      .catch(() => undefined);
  };

  return {
    async request(extensionId, input) {
      const signal = input?.signal;
      // A caller that cancelled before the call started must not spend a
      // request: main would run the whole thing before it could notice.
      if (signal?.aborted) throw abortedError();

      const callId = randomUUID();
      const params: Record<string, unknown> = {
        sessionId: options.sessionId,
        extensionId,
        callId,
        providerId: input?.providerId,
        path: input?.path,
        // Absent fields are omitted rather than sent as `undefined`, so main
        // reads "the caller did not send this" without a wire-level sentinel.
        ...(input?.modelId !== undefined ? { modelId: input.modelId } : {}),
        ...(input?.method !== undefined ? { method: input.method } : {}),
        ...(input?.headers !== undefined ? { headers: input.headers } : {}),
        ...(input?.body !== undefined ? { body: input.body } : {}),
        ...(input?.timeoutMs !== undefined
          ? { timeoutMs: input.timeoutMs }
          : {}),
      };
      // The host give-up and this surface's own give-up are the same moment: the
      // caller's budget plus transport slack. Racing them means a stalled host
      // still answers with a code this surface owns, and the abort goes out
      // instead of the call silently outliving the caller.
      const budgetMs = deadlineFor(input?.timeoutMs);
      const deadline = createCallDeadline(callId, budgetMs, abortCall);
      const onAbort = () => abortCall(callId);
      signal?.addEventListener("abort", onAbort, { once: true });
      inFlight.add(callId);
      try {
        const result = (await Promise.race([
          options.callHost(REQUEST_METHOD, params, budgetMs),
          deadline.promise,
        ])) as ExtensionProviderRequestResult;
        // An abort that landed after main had already answered — the side
        // channel can be slower than the response — is still the caller's
        // cancellation: a cancelled caller is never handed a result.
        if (signal?.aborted) throw abortedError();
        return result;
      } catch (error) {
        // An abort surfaces as the transport's own failure; the caller asked
        // for neither, so it is reported as the abort it was.
        if (signal?.aborted) throw abortedError();
        throw asError(error);
      } finally {
        deadline.clear();
        inFlight.delete(callId);
        signal?.removeEventListener("abort", onAbort);
      }
    },

    dispose() {
      for (const callId of [...inFlight]) abortCall(callId);
      inFlight.clear();
    },
  };
}
