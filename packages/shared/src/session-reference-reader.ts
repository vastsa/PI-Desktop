import type { UiMessage } from "./types/messages.js";
import {
  estimateSessionReferenceTokens,
  pairCompletedQaTurns,
  type SessionReferenceSource,
} from "./session-reference.js";

export const DEFAULT_SESSION_REFERENCE_PAGE_LIMIT = 400;
export const MAX_SESSION_REFERENCE_READ_PAGES = 25;

export type SessionReferencePage = {
  id: string;
  title: string;
  messages: UiMessage[];
  messageStart?: number;
  messageEnd?: number;
  hasMoreBefore?: boolean;
};

function createAbortError(reason?: unknown): Error {
  if (reason instanceof Error) return reason;
  const err = new Error(typeof reason === "string" ? reason : "This operation was aborted");
  err.name = "AbortError";
  return err;
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw createAbortError(signal.reason);
}

function fail(message: string): never {
  throw new Error(message);
}

function isCursor(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Newest-first pages are merged oldest-first. Keep the first chronological
 * position and the latest content/status per id. Drop tools and nested
 * delegates immediately; keep empty user rows so they still close a turn.
 */
function mergePages(pages: readonly SessionReferencePage[]): UiMessage[] {
  const chronological = [...pages].reverse();
  const messageMap = new Map<string, UiMessage>();
  const messageOrder: string[] = [];

  for (const page of chronological) {
    for (const msg of page.messages) {
      if (msg.role === "tool" || msg.parentToolCallId?.trim()) continue;
      const id = msg.id;
      if (id) {
        if (messageMap.has(id)) {
          messageMap.set(id, { ...messageMap.get(id)!, ...msg });
        } else {
          messageOrder.push(id);
          messageMap.set(id, { ...msg });
        }
      } else {
        const syntheticId = `anon_${messageOrder.length}`;
        messageOrder.push(syntheticId);
        messageMap.set(syntheticId, { ...msg });
      }
    }
  }

  return messageOrder.map((id) => messageMap.get(id)!);
}

function candidateTokens(pages: readonly SessionReferencePage[]): number {
  const turns = pairCompletedQaTurns(mergePages(pages));
  return estimateSessionReferenceTokens(turns.map((turn) => `Q: ${turn.question}\nA: ${turn.answer}`).join("\n\n"));
}

/**
 * Page backwards with physical transcript cursors. 400 is a page size, 25 is
 * I/O insurance. Malformed or stalled cursors fail closed instead of sending
 * a partial snapshot as if history were complete.
 */
export async function readSessionReferenceSource(
  id: string,
  loadPage: (id: string, before?: number) => Promise<SessionReferencePage | null>,
  options: {
    budgetTokens: number;
    signal?: AbortSignal;
    maxPages?: number;
  },
): Promise<SessionReferenceSource | null> {
  checkAbort(options.signal);

  const maxPages = options.maxPages ?? MAX_SESSION_REFERENCE_READ_PAGES;
  let pageCount = 0;
  let currentBefore: number | undefined;
  let title = "";
  let hasMoreBefore = false;
  const pages: SessionReferencePage[] = [];

  while (pageCount < maxPages) {
    checkAbort(options.signal);
    const page = await loadPage(id, currentBefore);
    checkAbort(options.signal);

    if (!page) {
      if (pageCount === 0) return null;
      fail("Session reference source disappeared while paging");
    }
    if (page.id !== id) {
      if (pageCount === 0) return null;
      fail("Session reference page id mismatch");
    }

    if (!title && page.title) title = page.title;
    if (currentBefore !== undefined && page.messageEnd !== undefined && page.messageEnd !== currentBefore) {
      fail("Session reference page is not contiguous");
    }

    pageCount += 1;
    pages.push(page);
    hasMoreBefore = Boolean(page.hasMoreBefore);

    if (candidateTokens(pages) >= options.budgetTokens && pairCompletedQaTurns(mergePages(pages)).length > 0) {
      break;
    }

    if (!hasMoreBefore) break;

    const nextBefore = page.messageStart;
    if (nextBefore === 0) {
      hasMoreBefore = false;
      break;
    }
    if (!isCursor(nextBefore)) fail("Session reference page cursor is invalid");
    if (currentBefore !== undefined && nextBefore >= currentBefore) {
      fail("Session reference page cursor did not advance");
    }
    currentBefore = nextBefore;
  }

  const messages = mergePages(pages);
  const turns = pairCompletedQaTurns(messages);
  const tokens = estimateSessionReferenceTokens(
    turns.map((turn) => `Q: ${turn.question}\nA: ${turn.answer}`).join("\n\n"),
  );
  const readLimitReached = pageCount >= maxPages && hasMoreBefore && tokens < options.budgetTokens;

  return { id, title, messages, hasMoreBefore, readLimitReached };
}
