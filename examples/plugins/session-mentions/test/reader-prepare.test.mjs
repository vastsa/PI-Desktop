import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readSessionReferenceSource, pairCompletedQaTurns, prepareReferencedMessage,
  stripSessionReferencePrompt, MAX_SESSION_REFERENCE_READ_PAGES,
} from '../dist/index.js';
import { A, B, user, assistant, page, NO_IO } from './helpers.mjs';

const readyPage = id => page(id, [user('Question'), assistant('Answer')]);
const draft = `Use @session:${A}`;
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
  assert.deepEqual(pairCompletedQaTurns(result.messages), [{ question: 'Q', answer: 'Latest' }]);
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

test('preparation returns a frozen string snapshot and the original request remains recoverable', async () => {
  const input = readyPage(A);
  const result = await prepareReferencedMessage(draft, { budgetTokens, loadPage: async () => input });
  assert.equal(result.status, 'ready');
  assert.equal(stripSessionReferencePrompt(result.content), draft);
  input.messages[1].content = 'Changed after preparation';
  assert.doesNotMatch(result.content, /Changed after preparation/);
});

test('missing and failed reads return blocked with the unchanged input', async () => {
  for (const [code, loadPage] of [
    ['missing', async () => null], ['read', async () => { throw new Error('Read failed'); }],
  ]) {
    const result = await prepareReferencedMessage(draft, { budgetTokens, loadPage });
    assert.equal(result.status, 'blocked');
    assert.equal(result.code, code);
    assert.equal(result.content, draft);
  }
});

test('no available complete pair before the read cap is blocked as incomplete', async () => {
  const result = await prepareReferencedMessage(draft, { budgetTokens, maxPages: 1,
    loadPage: async () => page(A, [assistant('No visible parent question')], { messageStart: 10, hasMoreBefore: true }),
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.code, 'incomplete');
  assert.equal(result.content, draft);
});

test('an insufficient budget blocks without changing the input', async () => {
  const result = await prepareReferencedMessage(draft, { budgetTokens: 1, loadPage: async () => readyPage(A) });
  assert.equal(result.status, 'blocked');
  assert.equal(result.code, 'budget');
  assert.equal(result.content, draft);
});

test('a non-cooperative hung reader still returns a blocked timeout', async () => {
  let signal;
  const start = performance.now();
  const result = await prepareReferencedMessage(draft, { budgetTokens, timeoutMs: 20,
    loadPage: (_id, _before, s) => { signal = s; return new Promise(() => {}); },
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.code, 'timeout');
  assert.equal(result.content, draft);
  assert.equal(signal.aborted, true);
  assert.ok(performance.now() - start < 2000);
});

test('parent cancellation interrupts a non-cooperative reader and late replies cannot authorize sending', async () => {
  const controller = new AbortController();
  let release;
  const pending = prepareReferencedMessage(draft, { budgetTokens, signal: controller.signal,
    loadPage: () => new Promise(resolve => { release = resolve; }),
  });
  controller.abort();
  const result = await pending;
  assert.equal(result.status, 'blocked');
  assert.equal(result.code, 'aborted');
  release(readyPage(A));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(result.status, 'blocked');
  assert.equal(result.content, draft);
});

test('an already-cancelled preparation performs no I/O', async () => {
  const controller = new AbortController(); controller.abort();
  const result = await prepareReferencedMessage(draft, { budgetTokens, signal: controller.signal, loadPage: NO_IO });
  assert.equal(result.code, 'aborted');
});

test('plain text and excluded self-references require no history reads', async () => {
  for (const content of ['plain text', draft]) {
    const result = await prepareReferencedMessage(content, { budgetTokens: 0, loadPage: NO_IO, excludeSessionId: A });
    assert.equal(result.status, 'ready');
    assert.equal(result.content, content);
  }
});

test('all sources share a single cancellation signal', async () => {
  const signals = [];
  const result = await prepareReferencedMessage(`@session:${A} @session:${B}`, { budgetTokens,
    loadPage: async (id, _before, signal) => { signals.push(signal); return readyPage(id); },
  });
  assert.equal(result.status, 'ready');
  assert.equal(signals.length, 2);
  assert.strictEqual(signals[0], signals[1]);
});

test('invalid timeout configuration is refused before reading', async () => {
  for (const timeoutMs of [0, -1, 20001, NaN, Infinity]) {
    const result = await prepareReferencedMessage(draft, { budgetTokens, timeoutMs, loadPage: NO_IO });
    assert.equal(result.status, 'blocked');
    assert.equal(result.code, 'read');
  }
});
