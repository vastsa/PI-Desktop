import type { PageLoader, ReferenceIdentity, SessionReferenceNotice } from "./types.js";
import { collectSessionReferenceIds } from "./references.js";
import { expandSessionReferences } from "./expander.js";
import { readSessionReferenceSource } from "./reader.js";

export const DEFAULT_SESSION_REFERENCE_TIMEOUT_MS = 20_000;
export type PreparationResult =
  | { status: "ready"; content: string; notices: SessionReferenceNotice[]; estimatedTokens: number }
  | { status: "blocked"; content: string; code: "budget" | "missing" | "incomplete" | "read" | "timeout" | "aborted"; reason: string };

/**
 * Private orchestration seam, NOT an SDK hook. Has no effect on a host draft,
 * queue, transcript or audit log. The real host must perform pre-commit admission
 * and honor blocked results atomically; the existing input hook cannot do that.
 * budgetTokens is a host-supplied reference-only allowance after all reserves.
 */
export async function prepareReferencedMessage(
  content: string,
  options: {
    budgetTokens: number;
    loadPage: PageLoader;
    references?: readonly ReferenceIdentity[];
    excludeSessionId?: string | null;
    signal?: AbortSignal;
    timeoutMs?: number;
    maxPages?: number;
  },
): Promise<PreparationResult> {
  const blocked = (code: Extract<PreparationResult, { status: "blocked" }>["code"], reason: string): PreparationResult =>
    ({ status: "blocked", content, code, reason });
  if (options.signal?.aborted) return blocked("aborted", "Reference preparation was cancelled.");
  if (!collectSessionReferenceIds(content, options.references, options.excludeSessionId).length) {
    return { status: "ready", content, notices: [], estimatedTokens: 0 };
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_SESSION_REFERENCE_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > DEFAULT_SESSION_REFERENCE_TIMEOUT_MS) {
    return blocked("read", "Reference timeout must be between 1 and 20000 milliseconds.");
  }
  const controller = new AbortController();
  let timedOut = false;
  const cancel = () => controller.abort(options.signal?.reason ?? new Error("Cancelled"));
  options.signal?.addEventListener("abort", cancel, { once: true });
  let rejectAbort: ((reason?: unknown) => void) | undefined;
  const abortPromise = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort?.(controller.signal.reason);
  controller.signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("Reference preparation exceeded its deadline"));
  }, timeoutMs);
  try {
    const work = expandSessionReferences(content, {
      ...options,
      signal: controller.signal,
      loadSession: (id, budgetTokens) => readSessionReferenceSource(id, options.loadPage, {
        budgetTokens, signal: controller.signal,
        ...(options.maxPages === undefined ? {} : { maxPages: options.maxPages }),
      }),
    });
    // Do not rely solely on cooperative cancellation: a hung adapter must not
    // prevent a blocked answer. A late adapter result cannot authorize a send.
    const result = await Promise.race([work, abortPromise]);
    controller.signal.throwIfAborted();
    if (result.missingIds.length) return blocked("missing", `Referenced sessions are unavailable: ${result.missingIds.join(", ")}`);
    if (result.blockedReason === "budget") return blocked("budget", "The newest complete Q&A from every source does not fit in the reference budget.");
    if (result.blockedReason === "incomplete") return blocked("incomplete", "No complete Q&A was found before the read limit; older history remains unread.");
    return { status: "ready", content: result.content, notices: result.notices, estimatedTokens: result.estimatedTokens };
  } catch (error) {
    if (timedOut) return blocked("timeout", "Reference preparation timed out; the original draft must be retained.");
    if (options.signal?.aborted) return blocked("aborted", "Reference preparation was cancelled.");
    return blocked("read", error instanceof Error ? error.message : "Reference preparation failed.");
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
    controller.signal.removeEventListener("abort", onAbort);
  }
}
