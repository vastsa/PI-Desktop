import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSessionSnapshot, budgetPercent, BUDGET_PERCENTS, maxTurnsOf, MAX_TURNS_CHOICES, BUDGET_STEP_BYTES, CONTEXT_RESERVE_TOKENS,
  DEFAULT_BUDGET_PERCENT, MARK_SEND_MAX_BYTES, DEFAULT_MAX_TURNS, referenceBudget, REFERENCE_FENCE_LANGUAGE,
} from './helpers/session-mentions.mjs';
import { A, source, user, assistant } from './helpers/session-mentions.mjs';

const bytes = (text) => Buffer.byteLength(text, 'utf8');
const pairs = (n, size = 10) => Array.from({ length: n }, (_, i) => [`Q${i}`, `A${i} ${'x'.repeat(size)}`]);
const questions = (send) => [...send.matchAll(/^Q: (Q\d+)$/gm)].map((match) => match[1]);
/** The newest rows of a long session: the reader stopped before its start. */
const tail = (n, from, fields = {}) => {
  const all = source(A, pairs(from + n));
  return { ...all, messages: all.messages.slice(from * 2), hasMoreBefore: true, ...fields };
};
const firstOf = (fields = {}) => ({ question: 'Q0', answer: `A0 ${'x'.repeat(10)}`, id: `${A}-u0`, ...fields });

test('the first turn is kept, then the most recent ones up to 10 turns, with a marker between', () => {
  const snapshot = buildSessionSnapshot(source(A, pairs(14)));
  assert.equal(DEFAULT_MAX_TURNS, 10);
  assert.equal(snapshot.includedTurns, 10);
  assert.equal(snapshot.firstTurn, true);
  assert.equal(snapshot.omittedKnown, 4);
  assert.equal(snapshot.unread, false);
  assert.equal(snapshot.clipped, false);
  assert.deepEqual(questions(snapshot.send), ['Q0', 'Q5', 'Q6', 'Q7', 'Q8', 'Q9', 'Q10', 'Q11', 'Q12', 'Q13']);
  assert.match(snapshot.send, /^A: A0 x+\n\n\[… 4 turns omitted here\]\n\nQ: Q5$/m);
  assert.match(snapshot.send, /turns="10" first-turn="true" omitted="4" unread="false"/);
  assert.match(snapshot.send, /Included the session's first turn and the 9 most recent complete turns; 4 turns after it omitted\./);
});

test('a reference is sent in a fence its blockRenderer claims, framed by line breaks', () => {
  const snapshot = buildSessionSnapshot(source(A, pairs(2)));
  assert.equal(REFERENCE_FENCE_LANGUAGE, 'pi.session-mentions:chat');
  assert.match(snapshot.send, /^\n```pi\.session-mentions:chat\n<referenced-chat id="aaaaaaaa-[^"]+" title="Alpha" turns="2"/);
  assert.match(snapshot.send, /<\/referenced-chat>\n```\n$/);
  // Backticks in the content: the fence is longer than any of their runs.
  const fenced = buildSessionSnapshot(source(A, [['code?', 'Here:\n````js\nx\n````']]));
  assert.match(fenced.send, /^\n`{5}pi\.session-mentions:chat\n/);
  assert.match(fenced.send, /\n`{5}\n$/);
});

test('each turn limit counts the first turn: 3 is the first + the 2 most recent', () => {
  const all = source(A, pairs(25));
  for (const [maxTurns, recent] of [[3, 2], [5, 4], [10, 9], [20, 19]]) {
    const snapshot = buildSessionSnapshot(all, { maxTurns });
    assert.equal(snapshot.includedTurns, maxTurns);
    assert.equal(snapshot.omittedKnown, 24 - recent);
    assert.deepEqual(questions(snapshot.send),
      ['Q0', ...Array.from({ length: recent }, (_, i) => `Q${25 - recent + i}`)], `max ${maxTurns}`);
    assert.match(snapshot.send, new RegExp(`\\[… ${24 - recent} turns omitted here\\]`));
  }
  // Without the first turn the newest ones fill the limit.
  const newest = buildSessionSnapshot(tail(12, 20), { maxTurns: 3 });
  assert.deepEqual(questions(newest.send), ['Q29', 'Q30', 'Q31']);
});

test('turn limits from the host: 3/5/10/20, 10 otherwise', () => {
  assert.deepEqual(MAX_TURNS_CHOICES, [3, 5, 10, 20]);
  for (const value of MAX_TURNS_CHOICES) assert.equal(maxTurnsOf(value), value);
  for (const value of [undefined, null, 0, 7, '5', 25]) assert.equal(maxTurnsOf(value), 10);
});

test('a short session is referenced whole, without a marker', () => {
  const snapshot = buildSessionSnapshot(source(A, pairs(3)));
  assert.deepEqual(questions(snapshot.send), ['Q0', 'Q1', 'Q2']);
  assert.equal(snapshot.omittedKnown, 0);
  assert.doesNotMatch(snapshot.send, /omitted here/);
  assert.match(snapshot.send, /Included all 3 complete turns\./);
  const one = buildSessionSnapshot(source(A, pairs(1)));
  assert.equal(one.includedTurns, 1);
  assert.equal(one.firstTurn, true);
  assert.match(one.send, /Included all 1 complete turn\./);
});

test('recent turns fill the budget newest-first after the first turn', () => {
  const snapshot = buildSessionSnapshot(source(A, pairs(10, 6000)));
  assert.ok(bytes(snapshot.send) <= MARK_SEND_MAX_BYTES);
  assert.deepEqual(questions(snapshot.send), ['Q0', 'Q6', 'Q7', 'Q8', 'Q9']);
  assert.equal(snapshot.omittedKnown, 5);
  assert.equal(snapshot.clipped, false);
});

test('the first turn read from the start joins the newest turns; the gap was not read', () => {
  const snapshot = buildSessionSnapshot({ ...tail(3, 20), firstTurn: firstOf() });
  assert.deepEqual(questions(snapshot.send), ['Q0', 'Q20', 'Q21', 'Q22']);
  assert.equal(snapshot.firstTurn, true);
  assert.equal(snapshot.unread, true);
  assert.equal(snapshot.omittedKnown, 0);
  assert.match(snapshot.send, /\[… turns omitted here were not read\]/);
  assert.match(snapshot.send, /first-turn="true" omitted="0" unread="true"/);
  assert.match(snapshot.send, /some turns after it were not read/);
  // More read than fit: the known ones are counted, the rest said unread.
  const many = buildSessionSnapshot({ ...tail(14, 20), firstTurn: firstOf() });
  assert.deepEqual(questions(many.send), ['Q0', ...Array.from({ length: 9 }, (_, i) => `Q${25 + i}`)]);
  assert.match(many.send, /\[… 5 turns omitted here; turns before them were not read\]/);
});

test('a first turn already in the transcript read is not repeated', () => {
  const all = source(A, pairs(4));
  const snapshot = buildSessionSnapshot({ ...all, hasMoreBefore: true, firstTurn: firstOf() });
  assert.deepEqual(questions(snapshot.send), ['Q0', 'Q1', 'Q2', 'Q3']);
  assert.equal(snapshot.unread, false);
  assert.equal(snapshot.omittedKnown, 0);
});

test('without the first turn, the most recent turns are kept and older history is not read', () => {
  const snapshot = buildSessionSnapshot(tail(12, 20));
  assert.equal(snapshot.firstTurn, false);
  assert.deepEqual(questions(snapshot.send), Array.from({ length: 10 }, (_, i) => `Q${22 + i}`));
  assert.equal(snapshot.omittedKnown, 2);
  assert.equal(snapshot.unread, true);
  assert.doesNotMatch(snapshot.send, /omitted here/);
  assert.match(snapshot.send, /first-turn="false" omitted="2" unread="true"/);
  assert.match(snapshot.send, /Included the 10 most recent complete turns; 2 older turns omitted; older history was not read\./);
});

test('every parent answer of a turn is kept together', () => {
  const snapshot = buildSessionSnapshot({ id: A, title: 'Alpha', messages: [
    user('Q'), assistant('first'), { role: 'tool', content: 'SECRET_TOOL' }, assistant('second'),
  ] });
  assert.match(snapshot.send, /A: first\n\nsecond\n/);
  assert.doesNotMatch(snapshot.send, /SECRET/);
});

test('a first turn larger than the limit is clipped, and says so', () => {
  const snapshot = buildSessionSnapshot(source(A, [['Q'.repeat(5000), '中'.repeat(20000)], ['small', 'new']]));
  assert.ok(bytes(snapshot.send) <= MARK_SEND_MAX_BYTES, `${bytes(snapshot.send)} bytes`);
  assert.ok(bytes(snapshot.send) > MARK_SEND_MAX_BYTES - 200, 'the room is used');
  assert.equal(snapshot.includedTurns, 1);
  assert.equal(snapshot.firstTurn, true);
  assert.equal(snapshot.omittedKnown, 1);
  assert.equal(snapshot.clipped, true);
  assert.match(snapshot.send, /clipped to fit the reference size limit/);
  assert.match(snapshot.send, /Included the session's first turn only; 1 turn after it omitted; some text was clipped to fit\./);
  // Without the first turn, the newest is the one clipped.
  const newest = buildSessionSnapshot({ ...source(A, [['small', 'old'], ['Q'.repeat(5000), '中'.repeat(20000)]]), hasMoreBefore: true });
  assert.equal(newest.clipped, true);
  assert.equal(newest.firstTurn, false);
  assert.ok(bytes(newest.send) <= MARK_SEND_MAX_BYTES);
});

test('text the host shortened is marked in the block', () => {
  const snapshot = buildSessionSnapshot({ id: A, title: 'Alpha', messages: [user('Q'), assistant('part', { contentTruncated: true })] });
  assert.equal(snapshot.clipped, true);
  assert.match(snapshot.send, /A: part\n\[… the host shortened this text\]/);
});

test('a session without a complete turn still makes a block that says so', () => {
  const snapshot = buildSessionSnapshot({ id: A, title: 'Alpha', messages: [user('Unanswered')], hasMoreBefore: true });
  assert.equal(snapshot.includedTurns, 0);
  assert.equal(snapshot.unread, true);
  assert.match(snapshot.send, /\(No completed question-and-answer turns\.\)/);
  assert.match(snapshot.send, /unread="true"/);
});

test('custom limits are validated', () => {
  assert.throws(() => buildSessionSnapshot(source(A, pairs(1)), { maxBytes: 10 }), /maxBytes/);
  assert.throws(() => buildSessionSnapshot(source(A, pairs(1)), { maxTurns: 0 }), /maxTurns/);
  const small = buildSessionSnapshot(source(A, pairs(3, 2000)), { maxBytes: 4096 });
  assert.ok(bytes(small.send) <= 4096);
});

test('budget shares from the host: 10/25/50/100%, 25% otherwise', () => {
  assert.deepEqual(BUDGET_PERCENTS, [10, 25, 50, 100]);
  assert.equal(DEFAULT_BUDGET_PERCENT, 25);
  for (const value of [10, 25, 50, 100]) assert.equal(budgetPercent(value), value);
  for (const value of [undefined, null, 0, 30, 'x', '50', -10]) assert.equal(budgetPercent(value), 25);
});

test('budget = pct × (window − used − 8192 reserve), at 3 bytes per token, under 32 KB', () => {
  assert.equal(CONTEXT_RESERVE_TOKENS, 8192);
  const context = { usedTokens: 100_000, contextWindow: 128_000 };
  // 128000 − 100000 − 8192 = 19808 tokens left after the reserve.
  const expected = (pct) => Math.floor(Math.floor(19_808 * pct / 100) * 3 / BUDGET_STEP_BYTES) * BUDGET_STEP_BYTES;
  assert.deepEqual(referenceBudget(context, 10), { bytes: expected(10), contextBound: true });
  assert.equal(expected(10), 5632);
  assert.deepEqual(referenceBudget(context, 25), { bytes: expected(25), contextBound: true });
  assert.equal(expected(25), 14848);
  assert.deepEqual(referenceBudget(context, 50), { bytes: 29_696, contextBound: true });
  // 100% of it is past the mark limit: 32 KB decides.
  assert.deepEqual(referenceBudget(context, 100), { bytes: MARK_SEND_MAX_BYTES, contextBound: false });
  // The default is 25%; a large free window is capped at 32 KB.
  assert.deepEqual(referenceBudget(context), referenceBudget(context, 25));
  assert.deepEqual(referenceBudget({ usedTokens: 0, contextWindow: 1_000_000 }, 10),
    { bytes: MARK_SEND_MAX_BYTES, contextBound: false });
});

test('unknown context falls back to the 32 KB mark limit', () => {
  for (const context of [undefined, null, {}, { usedTokens: 10 }, { contextWindow: 1000 },
    { usedTokens: NaN, contextWindow: 1000 }, { usedTokens: 1, contextWindow: 0 }]) {
    assert.deepEqual(referenceBudget(context, 10), { bytes: MARK_SEND_MAX_BYTES, contextBound: false }, JSON.stringify(context));
  }
});

test('a nearly full context leaves a zero budget, and the first turn is not attached', () => {
  const full = referenceBudget({ usedTokens: 125_000, contextWindow: 128_000 }, 100);
  assert.deepEqual(full, { bytes: 0, contextBound: true });
  const near = referenceBudget({ usedTokens: 118_000, contextWindow: 128_000 }, 25);
  assert.equal(near.contextBound, true);
  assert.ok(near.bytes < 2048);
  const snapshot = buildSessionSnapshot(source(A, pairs(3, 2000)), { contextBytes: near.bytes });
  assert.equal(snapshot.status, 'context-full');
});

test('a tighter context budget keeps fewer whole turns, without clipping, first turn included', () => {
  const full = buildSessionSnapshot(source(A, pairs(10, 1000)));
  const tight = buildSessionSnapshot(source(A, pairs(10, 1000)), { contextBytes: 4000 });
  assert.equal(full.status, 'ready');
  assert.equal(tight.status, 'ready');
  assert.ok(bytes(tight.send) <= 4000);
  assert.ok(tight.includedTurns >= 1 && tight.includedTurns < full.includedTurns);
  assert.equal(tight.clipped, false);
  assert.match(tight.send, /Q: Q0\n/);
  assert.match(tight.send, /Q: Q9\n/);
});

test('when not even the first turn fits the context, nothing is clipped or sent', () => {
  const snapshot = buildSessionSnapshot(source(A, [['Q', 'w'.repeat(5000)], ['Q2', 'small']]), { contextBytes: 3000 });
  assert.equal(snapshot.status, 'context-full');
  assert.equal(snapshot.contextBytes, 3000);
  assert.ok(snapshot.neededBytes > 5000);
  assert.equal(snapshot.send, undefined);
  const none = buildSessionSnapshot(source(A, pairs(1)), { contextBytes: 0 });
  assert.equal(none.status, 'context-full');
});

test('a context budget above the mark limit changes nothing', () => {
  const plain = buildSessionSnapshot(source(A, pairs(10, 6000)));
  const roomy = buildSessionSnapshot(source(A, pairs(10, 6000)), { contextBytes: 10 * MARK_SEND_MAX_BYTES });
  assert.deepEqual(roomy, plain);
  assert.throws(() => buildSessionSnapshot(source(A, pairs(1)), { contextBytes: -1 }), /contextBytes/);
});
