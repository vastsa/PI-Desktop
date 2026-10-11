import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readSessionReferenceSource, pairCompletedQaTurns, MAX_SESSION_REFERENCE_READ_PAGES,
} from './helpers/session-mentions.mjs';
import { A, B, user, assistant, page, NO_IO } from './helpers/session-mentions.mjs';

const readyPage = id => page(id, [user('Question'), assistant('Answer')]);
const budgetTokens = 10000;

test('Q&A split across physical pages is reassembled in chronological order', async () => {
  const cursors = [];
  const result = await readSessionReferenceSource(A, async (_id, before) => {
    cursors.push(before);
    return before === undefined
      ? page(A, [assistant('Answer')], { messageStart: 10, messageEnd: 11, hasMoreBefore: true })
      : page(A, [user('Question')], { messageStart: 0, messageEnd: 10 });
  }, { budgetTokens });
  assert.deepEqual(cursors, [undefined, 10]);
  assert.deepEqual(pairCompletedQaTurns(result.messages), [{ question: 'Question', answer: 'Answer' }]);
});

test('duplicate message IDs keep latest revision without duplicating answers', async () => {
  const result = await readSessionReferenceSource(A, async (_id, before) => before === undefined
    ? page(A, [assistant('Latest', { id: 'a' })], { messageStart: 10, hasMoreBefore: true })
    : page(A, [user('Q', { id: 'u' }), assistant('Old', { id: 'a' })], { messageEnd: 10 }), { budgetTokens });
  assert.deepEqual(pairCompletedQaTurns(result.messages), [{ question: 'Q', answer: 'Latest', id: 'u' }]);
});

test('projection removes reasoning, tool payloads and actual attachment objects', async () => {
  const input = page(A, [user('Q', { attachments: [{ data: 'SECRET_FILE' }] }),
    assistant('A', { thinking: 'SECRET_THOUGHT', toolCalls: ['SECRET_CALL'] }),
    { role: 'tool', content: 'SECRET_TOOL' }, assistant('SECRET_CHILD', { parentToolCallId: 'p' }),
  ]);
  const result = await readSessionReferenceSource(A, async () => input, { budgetTokens });
  assert.doesNotMatch(JSON.stringify(result.messages), /SECRET/);
  assert.match(JSON.stringify(input), /SECRET_THOUGHT/);
});

test('anonymous rows cannot collide with an actual message named anon_0', async () => {
  const result = await readSessionReferenceSource(A, async () => page(A, [
    user('Q'), assistant('A', { id: 'anon_0' }),
  ]), { budgetTokens });
  assert.deepEqual(pairCompletedQaTurns(result.messages), [{ question: 'Q', answer: 'A' }]);
});

test('malformed cursor is rejected before a budget-based early exit', async () => {
  await assert.rejects(readSessionReferenceSource(A, async () => page(A,
    [user('Q'), assistant('X'.repeat(1000))], { messageStart: undefined, hasMoreBefore: true }),
  { budgetTokens: 1 }), /cursor is invalid/);
});

test('hasMoreBefore with zero cursor is rejected instead of claiming full coverage', async () => {
  await assert.rejects(readSessionReferenceSource(A, async () => page(A, [], { hasMoreBefore: true }),
    { budgetTokens }), /cursor is invalid/);
});

test('stalled paging is rejected', async () => {
  await assert.rejects(readSessionReferenceSource(A, async (_id, before) => page(A, [], {
    messageStart: 10, messageEnd: before, hasMoreBefore: true,
  }), { budgetTokens }), /did not advance/);
});

test('non-contiguous pages and absent continuation end cursors are rejected', async () => {
  for (const messageEnd of [11, undefined]) {
    await assert.rejects(readSessionReferenceSource(A, async (_id, before) => before === undefined
      ? page(A, [], { messageStart: 10, hasMoreBefore: true })
      : page(A, [], { messageEnd }), { budgetTokens }), /not contiguous/);
  }
});

test('page limit reports unread history rather than making up an omitted total', async () => {
  let reads = 0;
  const result = await readSessionReferenceSource(A, async (_id, before) => {
    reads++;
    return page(A, [user(`Q${reads}`), assistant(`A${reads}`)], {
      messageEnd: before, messageStart: 100 - reads, hasMoreBefore: true,
    });
  }, { budgetTokens, maxPages: 2 });
  assert.equal(reads, 2);
  assert.equal(result.hasMoreBefore, true);
  assert.equal(result.readLimitReached, true);
});

test('default read guard is 25 pages', async () => {
  let reads = 0;
  const result = await readSessionReferenceSource(A, async (_id, before) => {
    reads++;
    return page(A, [], { messageEnd: before, messageStart: 100 - reads, hasMoreBefore: true });
  }, { budgetTokens });
  assert.equal(reads, MAX_SESSION_REFERENCE_READ_PAGES);
  assert.equal(reads, 25);
  assert.equal(result.readLimitReached, true);
});

test('a missing first page is unavailable; disappearing later pages are errors', async () => {
  assert.equal(await readSessionReferenceSource(A, async () => null, { budgetTokens }), null);
  await assert.rejects(readSessionReferenceSource(A, async (_id, before) => before === undefined
    ? page(A, [], { messageStart: 10, hasMoreBefore: true }) : null, { budgetTokens }), /disappeared/);
});

test('wrong-session pages are rejected', async () => {
  await assert.rejects(readSessionReferenceSource(A, async () => readyPage(B), { budgetTokens }), /id mismatch/);
});

test('invalid reader options do not start I/O', async () => {
  for (const maxPages of [0, -1, 1.5, 26, NaN]) {
    await assert.rejects(readSessionReferenceSource(A, NO_IO, { budgetTokens, maxPages }), /maxPages/);
  }
  await assert.rejects(readSessionReferenceSource('not-id', NO_IO, { budgetTokens }), /Invalid session/);
});

test('cooperative abort between pages stops reading', async () => {
  const controller = new AbortController();
  let reads = 0;
  await assert.rejects(readSessionReferenceSource(A, async () => {
    reads++; controller.abort(); return readyPage(A);
  }, { budgetTokens, signal: controller.signal }), { name: 'AbortError' });
  assert.equal(reads, 1);
});

test('paging stops once enough complete turns are known', async () => {
  let reads = 0;
  const result = await readSessionReferenceSource(A, async (_id, before) => {
    reads++;
    return page(A, [user(`Q${reads}`), assistant(`A${reads}`)], {
      messageEnd: before, messageStart: 100 - reads * 2, hasMoreBefore: true,
    });
  }, { budgetTokens, enoughTurns: 3 });
  assert.equal(reads, 3);
  assert.equal(result.hasMoreBefore, true);
  assert.equal(result.readLimitReached, false);
});
