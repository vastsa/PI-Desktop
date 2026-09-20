/**
 * Recovery policy for a provider transport that keeps failing (issue #234).
 *
 * One turn retried a Codex request ten times and every attempt died with a bare
 * `fetch failed`, while a new turn on the same network and provider recovered
 * immediately. `phase=stream` / `streamMs=1~2` looked like a failure after the
 * response headers, but pi-agent-core emits `message_start` for a stream that
 * ended without ever emitting `start`, so the pair actually means the opposite:
 * the request never produced a response, on all ten attempts, each of which
 * spent seconds in `provider-retry.ts`'s `phase=request` retries.
 *
 * A rejected provider fetch says two things beyond its errno. It is the only
 * transport event that proves the connection never worked, and it is the last
 * moment the original Error (with the cause chain node/undici put the real errno
 * in) still exists — pi-ai only forwards a flattened `errorMessage`. So the
 * capture and the decision live together here:
 *
 * - `describeProviderFetchFailure` turns the rejection into the same bounded,
 *   validated `network*` fields a directly classified network error carries.
 * - `createProviderTransportHealth` decides when the shared pool is worth
 *   rebuilding. It is deliberately not "rebuild on every rejection": the
 *   dispatcher in `node-proxy.ts` is process-wide, so a rebuild closes the idle
 *   sockets of every session, including ones that are not failing. One failure
 *   is a blip and a replay over the same pool is what a retry is supposed to do;
 *   the *same origin* failing twice in a row without ever answering is the point
 *   where the pool's view of that origin is not recovering on its own, and it
 *   leaves eight of the ten attempts to prove that a fresh pool helped.
 * - `dns` never triggers a rebuild: name resolution happens before a socket
 *   exists, so a fresh pool cannot change the answer.
 */
import type {
  ClassifiedAgentError,
  NetworkFailureCategory,
} from "./agent-errors.js";
import { networkFailureDiagnostics } from "./agent-errors.js";
import { activeNodeTransportRoute } from "./node-proxy.js";
import { isCertificateVerificationError } from "@pi-desktop/shared";

/** Consecutive unanswered failures for one origin that justify a rebuild. */
export const PROVIDER_TRANSPORT_REBUILD_THRESHOLD = 2;

/** A rejected provider fetch, described for the log and the error details. */
export type ProviderFetchFailure = {
  /**
   * Origin of the failed request. Compared to decide whether two failures are
   * consecutive; never reported, because a URL can carry credentials.
   */
  origin?: string;
  category: NetworkFailureCategory;
  /** Validated `network*` fields for `AppError.details`. */
  fields: Record<string, unknown>;
};

/**
 * Error codes a captured fetch cause explains. Mirrors the transient provider
 * codes: everything else is either a reached provider (`PROVIDER_RATE_LIMITED`,
 * an HTTP status) or a failure a different recovery path repairs.
 */
const EXPLAINED_ERROR_CODES = new Set([
  "NETWORK_ERROR",
  "TIMEOUT",
  "STREAM_FAILED",
  "PROVIDER_ERROR",
]);

/** Whether a captured fetch cause explains an error about to be surfaced. */
export function explainsProviderFetchFailure(code: string): boolean {
  return EXPLAINED_ERROR_CODES.has(code);
}

/**
 * DNS happens before a connection exists. Certificate verification errors are
 * excluded separately by their exact code; the broader TLS category includes
 * protocol failures for which a fresh connection can still help.
 */
const UNREBUILDABLE_CATEGORIES: ReadonlySet<NetworkFailureCategory> = new Set([
  "dns",
]);

function isAbort(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === "AbortError") ||
    (typeof error === "object" &&
      error !== null &&
      (error as { name?: unknown }).name === "AbortError")
  );
}

/**
 * Origin of the request that failed, for the consecutive-failure comparison.
 * `undefined` (an input the URL parser rejects) still works: the failures share
 * one fallback bucket instead of never reaching the threshold.
 */
function requestOrigin(input: unknown): string | undefined {
  const raw =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : typeof input === "object" &&
            input !== null &&
            typeof (input as { url?: unknown }).url === "string"
          ? (input as { url: string }).url
          : undefined;
  if (raw === undefined) return undefined;
  try {
    return new URL(raw).origin;
  } catch {
    return undefined;
  }
}

function errorMessageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "";
}

/**
 * Describe a rejected provider fetch, or return undefined when the rejection is
 * not a transport fault: an abort the user asked for (a stopped turn must not
 * look like a broken connection) or an error carrying an HTTP status, which means
 * a response did arrive.
 */
export function describeProviderFetchFailure(
  error: unknown,
  input?: unknown,
): ProviderFetchFailure | undefined {
  if (isAbort(error)) return undefined;
  const { category, fields } = networkFailureDiagnostics(
    error,
    errorMessageOf(error),
  );
  const origin = requestOrigin(input);
  return {
    ...(origin !== undefined ? { origin } : {}),
    category,
    fields: { ...fields, networkRoute: activeNodeTransportRoute() },
  };
}

/**
 * Consecutive-failure policy for the shared transport. One instance per runtime,
 * so one failing session cannot spend another session's evidence; the rebuild
 * itself is throttled by its owner in `node-proxy.ts`.
 */
export type ProviderTransportHealth = {
  /** Record an unanswered failure; true when the shared pool should be rebuilt. */
  observeFailure: (failure: ProviderFetchFailure) => boolean;
  /** Record that an attempt reached the provider. */
  observeResponse: () => void;
  /** Drop the streak; called when a new turn starts. */
  reset: () => void;
};

export function createProviderTransportHealth(): ProviderTransportHealth {
  let origin: string | undefined;
  let consecutive = 0;

  const clear = (): void => {
    origin = undefined;
    consecutive = 0;
  };

  return {
    observeFailure(failure) {
      if (
        UNREBUILDABLE_CATEGORIES.has(failure.category) ||
        isCertificateVerificationError(failure.fields.networkCode)
      ) {
        clear();
        return false;
      }
      if (consecutive > 0 && failure.origin !== origin) {
        // A different origin is a different connection. Restart the streak
        // rather than adding two unrelated failures together.
        origin = failure.origin;
        consecutive = 1;
        return false;
      }
      origin = failure.origin;
      consecutive += 1;
      if (consecutive < PROVIDER_TRANSPORT_REBUILD_THRESHOLD) return false;
      // One rebuild per streak: a further rebuild has to earn its own evidence,
      // so a long outage cannot churn the pool on every attempt.
      clear();
      return true;
    },
    observeResponse: clear,
    reset: clear,
  };
}

/**
 * Apply a captured cause to an error that was classified from a flattened
 * message. The errno the capture carries is first-hand, so it replaces the
 * `networkCategory: "unknown"` the text-only classifier falls back to; an error
 * the capture cannot explain is returned untouched.
 */
export function withProviderFetchFailure(
  error: ClassifiedAgentError,
  failure: ProviderFetchFailure | undefined,
): ClassifiedAgentError {
  if (failure === undefined || !explainsProviderFetchFailure(error.code)) {
    return error;
  }
  return {
    ...error,
    retriable: error.retriable && !isCertificateVerificationError(failure.fields.networkCode),
    details: { ...(error.details ?? {}), ...failure.fields },
  };
}
