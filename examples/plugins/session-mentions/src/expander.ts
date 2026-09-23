import type { ReferenceIdentity, SessionReferenceNotice, SessionReferenceSnapshot, SessionReferenceSource } from "./types.js";
import { collectSessionReferenceIds, normalizeSessionId } from "./references.js";
import { attachSessionReferenceSnapshots, estimateSessionReferenceTokens, stripSessionReferencePrompt } from "./prompt.js";
import { pairCompletedQaTurns } from "./qa.js";

export type ExpansionResult = {
  content: string;
  missingIds: string[];
  notices: SessionReferenceNotice[];
  estimatedTokens: number;
  budgetTokens: number;
  blockedReason?: "budget" | "incomplete";
};

/** Each nonempty source's newest eligible Q&A must fit before older Q&A is added. */
export async function expandSessionReferences(
  content: string,
  options: {
    references?: readonly ReferenceIdentity[];
    excludeSessionId?: string | null;
    budgetTokens: number;
    loadSession: (id: string, budgetTokens: number) => Promise<SessionReferenceSource | null>;
    signal?: AbortSignal;
  },
): Promise<ExpansionResult> {
  const ids = collectSessionReferenceIds(content, options.references, options.excludeSessionId);
  const budgetTokens = Number.isFinite(options.budgetTokens) && options.budgetTokens > 0
    ? Math.floor(options.budgetTokens) : 0;
  const unchanged: ExpansionResult = { content: stripSessionReferencePrompt(content),
    missingIds: [], notices: [], estimatedTokens: 0, budgetTokens };
  options.signal?.throwIfAborted();
  if (!ids.length) return unchanged;
  if (budgetTokens <= 0) return { ...unchanged, blockedReason: "budget" };
  const sources: SessionReferenceSource[] = [];
  for (const id of ids) {
    options.signal?.throwIfAborted();
    const source = await options.loadSession(id, budgetTokens);
    options.signal?.throwIfAborted();
    if (source && normalizeSessionId(source.id) !== id) throw new Error("Session reference source id mismatch");
    if (source) sources.push({ ...source, id });
    else unchanged.missingIds.push(id);
  }
  if (unchanged.missingIds.length) return unchanged;
  const entries = sources.map((source) => ({ source, turns: pairCompletedQaTurns(source.messages), start: 0 }));
  for (const entry of entries) entry.start = Math.max(0, entry.turns.length - 1);
  const notices = (blocked = false): SessionReferenceNotice[] => entries.map(({ source, turns, start }) => ({
    sessionId: source.id, title: source.title,
    includedTurns: blocked ? 0 : turns.length - start,
    omittedKnown: blocked ? turns.length : start,
    olderUnread: Boolean(source.hasMoreBefore), readLimitReached: Boolean(source.readLimitReached),
  }));
  if (entries.some(({ source, turns }) => !turns.length && (source.hasMoreBefore || source.readLimitReached))) {
    return { ...unchanged, notices: notices(true), blockedReason: "incomplete" };
  }
  const snapshots = (): SessionReferenceSnapshot[] => entries.map(({ source, turns, start }) => ({
    sessionId: source.id, title: source.title, turns: turns.slice(start), omittedKnown: start,
    olderUnread: Boolean(source.hasMoreBefore), readLimitReached: Boolean(source.readLimitReached),
  }));
  const cost = () => estimateSessionReferenceTokens(attachSessionReferenceSnapshots("", snapshots()));
  if (cost() > budgetTokens) return { ...unchanged, notices: notices(true), blockedReason: "budget" };
  const exhausted = new Set<number>();
  let advanced: boolean;
  do {
    advanced = false;
    for (let index = 0; index < entries.length; index++) {
      options.signal?.throwIfAborted();
      const entry = entries[index]!;
      if (exhausted.has(index) || entry.start === 0) continue;
      entry.start--;
      if (cost() <= budgetTokens) advanced = true;
      else { entry.start++; exhausted.add(index); }
    }
  } while (advanced);
  return { ...unchanged, content: attachSessionReferenceSnapshots(content, snapshots()),
    notices: notices(), estimatedTokens: cost() };
}
