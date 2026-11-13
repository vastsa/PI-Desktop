export type SubagentDraftAddress = { sessionId: string; delegationId?: string };
export type SubagentControlDraft = Readonly<{
  text: string; agent: string; model: string; revision: number; operationId?: string; operationDelegationId?: string;
}>;
export type SubagentDraftCheckpoint = SubagentDraftAddress & {
  text: string; agent: string; model: string; operationId?: string; operationDelegationId?: string;
};
const empty: SubagentControlDraft = Object.freeze({ text: "", agent: "", model: "", revision: 0 });
const drafts = new Map<string, { address: SubagentDraftAddress; draft: SubagentControlDraft }>();
const listeners = new Set<() => void>();
let revision = 0;
const key = (address: SubagentDraftAddress) => JSON.stringify([address.sessionId, address.delegationId ?? null]);
const notify = () => { for (const listener of listeners) listener(); };

/** Feature-owned renderer memory: no provider credentials or automatic execution. */
export function readSubagentControlDraft(address: SubagentDraftAddress): SubagentControlDraft {
  return drafts.get(key(address))?.draft ?? empty;
}
export function subscribeSubagentControlDrafts(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function writeSubagentControlDraft(
  address: SubagentDraftAddress, patch: Partial<Pick<SubagentControlDraft, "text" | "agent" | "model">>,
): void {
  const previous = readSubagentControlDraft(address);
  const next = { ...previous, ...patch };
  if (next.text === previous.text && next.agent === previous.agent && next.model === previous.model) return;
  delete next.operationId;
  delete next.operationDelegationId;
  next.revision = ++revision;
  drafts.set(key(address), { address: { ...address }, draft: next });
  notify();
}

/** Retained after an uncertain IPC failure, so a retry cannot launch twice. */
export function prepareSubagentControlOperation(
  address: SubagentDraftAddress, delegationId?: string,
): SubagentControlDraft & { operationId: string } {
  const previous = readSubagentControlDraft(address);
  const operationId = previous.operationId ?? crypto.randomUUID();
  const operationDelegationId = previous.operationId ? previous.operationDelegationId : delegationId;
  const draft = { ...previous, operationId, ...(operationDelegationId ? { operationDelegationId } : {}) };
  drafts.set(key(address), { address: { ...address }, draft });
  notify();
  return draft;
}
export function clearSubagentControlDraft(address: SubagentDraftAddress, expectedRevision: number): void {
  if (readSubagentControlDraft(address).revision !== expectedRevision) return;
  drafts.delete(key(address));
  notify();
}
export function pruneSubagentControlDrafts(sessionIds: Iterable<string>): void {
  const keep = new Set(sessionIds);
  let changed = false;
  for (const [id, entry] of drafts) {
    if (keep.has(entry.address.sessionId)) continue;
    drafts.delete(id);
    changed = true;
  }
  if (changed) notify();
}
export function snapshotSubagentControlDrafts(): SubagentDraftCheckpoint[] {
  return [...drafts.values()].filter(({ draft }) => draft.text || draft.agent || draft.model || draft.operationId)
    .map(({ address, draft }) => ({ ...address, text: draft.text, agent: draft.agent, model: draft.model,
      ...(draft.operationId ? { operationId: draft.operationId } : {}),
      ...(draft.operationDelegationId ? { operationDelegationId: draft.operationDelegationId } : {}) }));
}
export function restoreSubagentControlDrafts(checkpoints: readonly SubagentDraftCheckpoint[]): void {
  drafts.clear();
  for (const { sessionId, delegationId, ...fields } of checkpoints) {
    const address = { sessionId, ...(delegationId ? { delegationId } : {}) };
    drafts.set(key(address), { address, draft: { ...fields, revision: ++revision } });
  }
  notify();
}
