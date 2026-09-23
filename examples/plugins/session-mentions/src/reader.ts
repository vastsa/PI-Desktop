import type { PageLoader, ReferenceMessage, SessionReferencePage, SessionReferenceSource } from "./types.js";
import { normalizeSessionId } from "./references.js";
import { estimateSessionReferenceTokens } from "./prompt.js";
import { pairCompletedQaTurns } from "./qa.js";

export const DEFAULT_SESSION_REFERENCE_PAGE_LIMIT = 400;
export const MAX_SESSION_REFERENCE_READ_PAGES = 25;

function isCursor(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Only retain fields used by the reducer: never retain thinking/tool payloads. */
function projectMessage(message: ReferenceMessage): ReferenceMessage {
  const projected: ReferenceMessage = { role: message.role };
  if (message.id !== undefined) projected.id = message.id;
  if (message.content !== undefined) projected.content = message.content;
  if (message.status !== undefined) projected.status = message.status;
  if (message.contentTruncated !== undefined) projected.contentTruncated = message.contentTruncated;
  if (message.attachments?.length) projected.attachments = [true];
  return projected;
}

/** Newest pages arrive first; chronological position and latest row revision win. */
function mergePages(pages: readonly SessionReferencePage[]): ReferenceMessage[] {
  const out: ReferenceMessage[] = [];
  const positionById = new Map<string, number>();
  for (const page of [...pages].reverse()) {
    for (const raw of page.messages) {
      if (raw.parentToolCallId?.trim() || !["user", "assistant"].includes(raw.role)) continue;
      const message = projectMessage(raw);
      const position = message.id ? positionById.get(message.id) : undefined;
      if (position !== undefined) out[position] = message;
      else {
        if (message.id) positionById.set(message.id, out.length);
        out.push(message);
      }
    }
  }
  return out;
}

function candidateTokens(messages: readonly ReferenceMessage[]): number {
  return estimateSessionReferenceTokens(pairCompletedQaTurns(messages)
    .map((turn) => `Q: ${turn.question}\nA: ${turn.answer}`).join("\n\n"));
}

/**
 * The adapter must use physical transcript cursors, keep chronological order
 * within each page, and bound page length to 400 itself. It must reject revision
 * changes it cannot reconcile. This is not pi.session.listMessages's contract.
 */
export async function readSessionReferenceSource(
  rawId: string,
  loadPage: PageLoader,
  options: { budgetTokens: number; signal?: AbortSignal; maxPages?: number },
): Promise<SessionReferenceSource | null> {
  const id = normalizeSessionId(rawId);
  if (!id) throw new Error("Invalid session reference id");
  const maxPages = options.maxPages ?? MAX_SESSION_REFERENCE_READ_PAGES;
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > MAX_SESSION_REFERENCE_READ_PAGES) {
    throw new Error("maxPages must be an integer between 1 and 25");
  }
  if (!Number.isFinite(options.budgetTokens) || options.budgetTokens <= 0) {
    throw new Error("A positive reference token budget is required");
  }
  const signal = options.signal ?? new AbortController().signal;
  const pages: SessionReferencePage[] = [];
  let before: number | undefined;
  let title = "";
  let more = false;
  let messages: ReferenceMessage[] = [];
  for (let index = 0; index < maxPages; index++) {
    signal.throwIfAborted();
    const page = await loadPage(id, before, signal);
    signal.throwIfAborted();
    if (!page) {
      if (pages.length === 0) return null;
      throw new Error("Session reference source disappeared while paging");
    }
    if (normalizeSessionId(page.id) !== id) throw new Error("Session reference page id mismatch");
    if (before !== undefined && page.messageEnd !== before) {
      throw new Error("Session reference page is not contiguous");
    }
    more = Boolean(page.hasMoreBefore);
    if (more) {
      if (!isCursor(page.messageStart) || page.messageStart === 0) {
        throw new Error("Session reference page cursor is invalid");
      }
      if (before !== undefined && page.messageStart >= before) {
        throw new Error("Session reference page cursor did not advance");
      }
    }
    // Validate the cursor before the budget early-exit; a malformed page must
    // not become valid merely because its text already fills the budget.
    if (!title && page.title) title = page.title;
    pages.push(page);
    messages = mergePages(pages);
    if (!more || candidateTokens(messages) >= options.budgetTokens) break;
    before = page.messageStart;
  }
  return { id, title, messages, hasMoreBefore: more,
    readLimitReached: pages.length >= maxPages && more };
}
