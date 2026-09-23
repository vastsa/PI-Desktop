import { estimateSessionReferenceTokens } from './dist/prompt.js';
import { normalizeSessionId } from './dist/references.js';

export const DEFAULT_BUDGET_PERCENT = 25;
export function budgetPercent(value) {
  return [10, 25, 50, 100].includes(value) ? value : DEFAULT_BUDGET_PERCENT;
}

/** Estimate only; the runtime and provider remain authoritative for admission. */
export function referenceBudget(text, usage, percent = 25) {
  const { contextWindow, usedTokens } = usage ?? {};
  if (!Number.isFinite(contextWindow) || contextWindow <= 0 ||
      !Number.isFinite(usedTokens) || usedTokens < 0) return 0;
  const reserve = (Number.isFinite(usage.maxOutputTokens) && usage.maxOutputTokens > 0
    ? usage.maxOutputTokens : 8192) + 2048 + (usage.hasAttachments ? 4096 : 0);
  return Math.max(0, Math.floor((contextWindow - usedTokens - reserve -
    estimateSessionReferenceTokens(text)) * budgetPercent(percent) / 100));
}

/** Whitelist Q&A fields at the host boundary; never forward thinking or tool payloads. */
export function referencePage(value, expectedId) {
  const id = normalizeSessionId(value?.id ?? value?.sessionId);
  if (!id || id !== expectedId || !Array.isArray(value?.messages)) {
    throw new Error('The referenced session returned an invalid transcript page.');
  }
  const messages = [];
  for (const row of value.messages) {
    if (!row || typeof row !== 'object') throw new Error('Invalid transcript row.');
    if (!['user', 'assistant', 'tool', 'system'].includes(row.role)) continue;
    if (row.role === 'tool' || row.role === 'system' || row.parentToolCallId) continue;
    if (row.content !== undefined && typeof row.content !== 'string') {
      throw new Error('The host did not provide complete plain-text message content.');
    }
    messages.push({
      ...(typeof row.id === 'string' ? { id: row.id } : {}),
      role: row.role, content: row.content ?? '',
      ...(typeof row.status === 'string' ? { status: row.status } : {}),
      ...(row.contentTruncated ? { contentTruncated: true } : {}),
      ...(Array.isArray(row.attachments) && row.attachments.length ? { attachments: [{}] } : {}),
    });
  }
  return { id, title: typeof value.title === 'string' ? value.title : id, messages,
    messageStart: value.messageStart, messageEnd: value.messageEnd,
    hasMoreBefore: value.hasMoreBefore ?? value.truncated };
}
