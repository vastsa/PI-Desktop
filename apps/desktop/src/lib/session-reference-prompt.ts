import {
  DEFAULT_SESSION_REFERENCE_PAGE_LIMIT,
  expandSessionReferences,
  readSessionReferenceSource,
} from "@pi-desktop/shared";
import { api } from "./api";

export const SESSION_REFERENCE_TIMEOUT_MS = 20_000;

/** No clipped content: only complete, physically paginated Q&A may be frozen. */
export async function expandComposerSessionReferences(
  content: string,
  fileReferences: ReadonlyArray<{ path: string; kind?: string }> | undefined,
  excludeSessionId: string | null | undefined,
  options: { budgetTokens: number; signal?: AbortSignal; isCurrent?: () => boolean },
) {
  const controller = new AbortController();
  const check = () => {
    if (controller.signal.aborted) throw controller.signal.reason;
    if (options.isCurrent?.() === false) throw new Error("Session reference target changed");
  };
  const cancel = () => controller.abort(options.signal?.reason ?? new Error("Session reference read cancelled"));
  let rejectAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = () => reject(controller.signal.reason);
    controller.signal.addEventListener("abort", rejectAbort, { once: true });
  });
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();
  const timer = setTimeout(() => controller.abort(new Error("Session reference read timed out")), SESSION_REFERENCE_TIMEOUT_MS);
  try {
    // The race bounds the entire operation even if an in-flight IPC never settles.
    // IPC itself cannot be aborted; every late result is checked and discarded.
    const expansion = (async () => {
      check();
      const expanded = await expandSessionReferences(content, {
        references: fileReferences,
        excludeSessionId,
        budgetTokens: options.budgetTokens,
        signal: controller.signal,
        loadSession: async (id, budgetTokens) => {
          check();
          const source = await readSessionReferenceSource(id, async (sessionId, before) => {
            check();
            const result = await api.getSession(sessionId, {
              messageLimit: DEFAULT_SESSION_REFERENCE_PAGE_LIMIT,
              ...(before === undefined ? {} : { messageBefore: before }),
            });
            check();
            const session = result.session;
            if (!session) {
              if (before !== undefined) throw new Error("Referenced session disappeared during pagination");
              return null;
            }
            const { messageStart: start, messageEnd: end } = session;
            // Reject malformed IPC pages rather than freezing a partial snapshot.
            if (session.id !== sessionId ||
              (start !== undefined && (!Number.isSafeInteger(start) || start < 0)) ||
              (end !== undefined && (!Number.isSafeInteger(end) || end < (start ?? 0))) ||
              (before !== undefined && end !== undefined && end !== before) ||
              (session.hasMoreBefore && (start === undefined || start === 0)) ||
              (before !== undefined && start !== undefined && start >= before)) {
              throw new Error("Invalid session reference pagination cursor");
            }
            return {
              id: session.id, title: session.title, messages: session.messages,
              messageStart: session.messageStart, messageEnd: session.messageEnd,
              hasMoreBefore: session.hasMoreBefore,
            };
          }, { budgetTokens, signal: controller.signal });
          check();
          return source;
        },
      });
      check();
      return expanded;
    })();
    return await Promise.race([expansion, aborted]);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
    if (rejectAbort) controller.signal.removeEventListener("abort", rejectAbort);
    controller.abort(new Error("Session reference read finished"));
  }
}
