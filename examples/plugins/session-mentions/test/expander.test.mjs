import test from 'node:test';
import assert from 'node:assert/strict';
import {
  expandSessionReferences, attachSessionReferenceSnapshots, estimateSessionReferenceTokens,
  stripSessionReferencePrompt,
} from '../dist/index.js';
import { A, B, C, source, NO_IO } from './helpers.mjs';

const cost = snapshots => estimateSessionReferenceTokens(attachSessionReferenceSnapshots('', snapshots));
const snap = (s, turns, omittedKnown = 0) => ({ sessionId: s.id, title: s.title, turns, omittedKnown });
const options = (sources, budgetTokens) => ({ budgetTokens, loadSession: async id => sources.find(s => s.id === id) ?? null });

test('no references require neither budget nor I/O', async () => {
  const result = await expandSessionReferences('ordinary question', { budgetTokens: 0, loadSession: NO_IO });
  assert.equal(result.content, 'ordinary question');
  assert.equal(result.estimatedTokens, 0);
  assert.equal(result.blockedReason, undefined);
});

test('invalid or zero budgets block before reading any history', async () => {
  for (const budgetTokens of [0, -1, NaN, Infinity, 0.1]) {
    const result = await expandSessionReferences(`@session:${A}`, { budgetTokens, loadSession: NO_IO });
    assert.equal(result.blockedReason, 'budget');
  }
});

test('all nonempty sources must fit together; not one budget per source', async () => {
  const first = source(A, [['QA', 'AA']]);
  const second = source(B, [['QB', 'AB']]);
  const sa = snap(first, [{ question: 'QA', answer: 'AA' }]);
  const sb = snap(second, [{ question: 'QB', answer: 'AB' }]);
  const alone = Math.max(cost([sa]), cost([sb]));
  assert.ok(cost([sa, sb]) > alone);
  const draft = `Read @session:${A} and @session:${B}`;
  const result = await expandSessionReferences(draft, options([first, second], alone));
  assert.equal(result.blockedReason, 'budget');
  assert.equal(result.content, draft);
  assert.ok(result.notices.every(n => n.includedTurns === 0));
});

test('exact shared estimated budget includes newest full Q&A from each source', async () => {
  const first = source(A, [['QA', 'AA']]);
  const second = source(B, [['QB', 'AB']]);
  const budget = cost([snap(first, [{ question: 'QA', answer: 'AA' }]), snap(second, [{ question: 'QB', answer: 'AB' }])]);
  const result = await expandSessionReferences(`Read @session:${A} and @session:${B}`, options([first, second], budget));
  assert.equal(result.blockedReason, undefined);
  assert.equal(result.estimatedTokens, budget);
  assert.deepEqual(result.notices.map(n => n.includedTurns), [1, 1]);
});

test('oversized older Q&A is omitted whole, never clipped', async () => {
  const s = source(A, [['Old question', 'X'.repeat(10000)], ['New question', 'New answer']]);
  const budget = cost([snap(s, [{ question: 'New question', answer: 'New answer' }], 1)]);
  const result = await expandSessionReferences(`@session:${A}`, options([s], budget));
  assert.equal(result.blockedReason, undefined);
  assert.equal(result.notices[0].omittedKnown, 1);
  assert.match(result.content, /New answer/);
  assert.doesNotMatch(result.content, /Old question/);
});

test('a source keeps a contiguous newest suffix; it does not skip a large middle turn', async () => {
  const s = source(A, [['Tiny old', 'Tiny'], ['Large middle', 'X'.repeat(10000)], ['Newest', 'Answer']]);
  const budget = cost([snap(s, [{ question: 'Newest', answer: 'Answer' }], 2)]) + 100;
  const result = await expandSessionReferences(`@session:${A}`, options([s], budget));
  assert.equal(result.notices[0].includedTurns, 1);
  assert.doesNotMatch(result.content, /Tiny old/);
});

test('large allowance is not an arbitrary last-10 or last-20 cap', async () => {
  const s = source(A, Array.from({ length: 30 }, (_, i) => [`Q${i}`, `A${i}`]));
  const result = await expandSessionReferences(`@session:${A}`, options([s], 100000));
  assert.equal(result.notices[0].includedTurns, 30);
  assert.equal(result.notices[0].omittedKnown, 0);
});

test('no completed Q&A with unread history is incomplete, not an empty conversation', async () => {
  const s = source(A, [], { hasMoreBefore: true, readLimitReached: true });
  const result = await expandSessionReferences(`@session:${A}`, options([s], 10000));
  assert.equal(result.blockedReason, 'incomplete');
  assert.equal(result.notices[0].olderUnread, true);
});

test('a fully read empty source is explicitly identified as empty', async () => {
  const result = await expandSessionReferences(`@session:${A}`, options([source(A, [])], 10000));
  assert.equal(result.blockedReason, undefined);
  assert.match(result.content, /No completed question-and-answer turns/);
  assert.equal(result.notices[0].includedTurns, 0);
});

test('unread older history remains an unknown count even when newest Q&A fits', async () => {
  const s = source(A, [['Q', 'A']], { hasMoreBefore: true, readLimitReached: true });
  const result = await expandSessionReferences(`@session:${A}`, options([s], 10000));
  assert.equal(result.blockedReason, undefined);
  assert.match(result.content, /omitted total is unknown/);
  assert.equal(result.notices[0].readLimitReached, true);
});

test('missing sources prevent a partial multi-source snapshot', async () => {
  const draft = `@session:${A} @session:${B}`;
  const result = await expandSessionReferences(draft, options([source(A, [['Q', 'A']])], 10000));
  assert.deepEqual(result.missingIds, [B]);
  assert.equal(result.content, draft);
  assert.equal(result.estimatedTokens, 0);
});

test('source ID mismatch is refused', async () => {
  await assert.rejects(expandSessionReferences(`@session:${A}`, {
    budgetTokens: 10000, loadSession: async () => source(B, [['Q', 'A']]),
  }), /id mismatch/);
});

test('loaded source snapshots are not mutated and nested mentions are not read', async () => {
  const s = source(A, [[`Nested @session:${C}`, 'Answer']]);
  const before = structuredClone(s);
  const reads = [];
  const draft = `Read @session:${A}`;
  const result = await expandSessionReferences(draft, { budgetTokens: 10000, loadSession: async id => { reads.push(id); return s; } });
  assert.deepEqual(reads, [A]);
  assert.deepEqual(s, before);
  assert.equal(stripSessionReferencePrompt(result.content), draft);
});

test('active-session references are excluded without I/O', async () => {
  const result = await expandSessionReferences(`@session:${A}`, {
    budgetTokens: 10000, excludeSessionId: A, loadSession: NO_IO,
  });
  assert.equal(result.estimatedTokens, 0);
});

test('already-aborted work does not read sources', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(expandSessionReferences(`@session:${A}`, {
    budgetTokens: 10000, loadSession: NO_IO, signal: controller.signal,
  }), { name: 'AbortError' });
});
