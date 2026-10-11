import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  createSessionTrigger, onLoad, triggerContext, triggerReferences, CONTEXT_FULL_PREFIX,
} from '../resources/plugins/pi.session-mentions/renderer.js';
import {
  parseReference, referenceFacts, ReferenceCard, ReferenceCardView, REFERENCE_CARD_CSS,
} from '../resources/plugins/pi.session-mentions/card.js';
import { buildSessionSnapshot } from '../resources/plugins/pi.session-mentions/lib/snapshot.js';
import { A, source } from './helpers/session-mentions.mjs';
import { displayTitle } from '../resources/plugins/pi.session-mentions/lib/references.js';

const KEY = (n) => `k${n}`;

function fakeDispatch(script) {
  const calls = [];
  const dispatch = async (action, payload) => {
    assert.equal(action, 'plugin.call');
    calls.push(payload);
    return script(payload, calls.length);
  };
  return { dispatch, calls };
}

test('only rows with a ready snapshot are offered, in list order', async () => {
  const { dispatch, calls } = fakeDispatch(({ method }) => method === 'sessions.items'
    ? { rows: [{ key: KEY(1), label: 'One' }, { key: KEY(2), label: 'Two' }, { key: KEY(3), label: 'Three' }],
        snapshots: [{ key: KEY(2), send: 'S2', detail: 'd2' }], pending: [KEY(1)] }
    : { snapshots: [{ key: KEY(1), send: 'S1', detail: 'd1' }], pending: [] });
  const trigger = createSessionTrigger(dispatch, { debounceMs: 0 });
  assert.deepEqual(await trigger.items({ trigger: '@', query: 'o' }), [
    { label: 'One', send: 'S1', detail: 'd1' }, { label: 'Two', send: 'S2', detail: 'd2' },
  ]);
  assert.deepEqual(calls.map((call) => call.method), ['sessions.items', 'sessions.snapshots']);
  assert.equal(calls[0].args.query, 'o');
  assert.deepEqual(calls[1].args.keys, [KEY(1)]);
  assert.ok(calls[0].args.deadlineMs <= 1450);

  await trigger.items({ trigger: '@', query: '' });
  assert.deepEqual(calls[2].args.cached, [KEY(2), KEY(1)], 'held snapshots are not asked for again');
});

test('a superseded keystroke answers empty without calling the plugin', async () => {
  const { dispatch, calls } = fakeDispatch(() => ({ rows: [], snapshots: [], pending: [] }));
  const trigger = createSessionTrigger(dispatch, { debounceMs: 20 });
  const [first, second] = await Promise.all([trigger.items({ query: 'a' }), trigger.items({ query: 'ab' })]);
  assert.deepEqual(first, []);
  assert.deepEqual(second, []);
  assert.deepEqual(calls.map((call) => call.args.query), ['ab']);
});

test('pending snapshots stop being chased when the budget runs out', async () => {
  const { dispatch, calls } = fakeDispatch(({ method }) => new Promise((resolve) => setTimeout(() => resolve(
    method === 'sessions.items'
      ? { rows: [{ key: KEY(1), label: 'One' }], snapshots: [], pending: [KEY(1)] }
      : { snapshots: [], pending: [KEY(1)] }), 60)));
  const trigger = createSessionTrigger(dispatch, { debounceMs: 0, budgetMs: 600 });
  const started = Date.now();
  assert.deepEqual(await trigger.items({ query: '' }), []);
  assert.ok(Date.now() - started < 700);
  assert.ok(calls.length >= 2);
});

test('onLoad claims @, the reference fence, and warms the cache', async () => {
  const registrations = [];
  const styles = [];
  const { dispatch, calls } = fakeDispatch(() => ({ rows: [], snapshots: [{ key: KEY(9), send: 'S9', detail: 'd' }], pending: [] }));
  onLoad({ dispatch, slots: { register: (registration) => registrations.push(registration) },
    ui: { injectStyle: (css) => styles.push(css) } });
  assert.equal(registrations.length, 2);
  assert.equal(registrations[0].slot, 'composerTrigger');
  assert.equal(registrations[0].trigger, '@');
  assert.equal(registrations[0].placement, 'first', 'sessions lead the list, files follow');
  assert.equal(typeof registrations[0].items, 'function');
  assert.equal(registrations[1].slot, 'blockRenderer');
  assert.equal(registrations[1].language, 'pi.session-mentions:chat');
  assert.equal(registrations[1].component, ReferenceCard);
  assert.deepEqual(styles, [REFERENCE_CARD_CSS]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls[0], { method: 'sessions.items', args: { query: '', cached: [] } });
});


test('the query context is passed on as is, and a session that does not fit is flagged', async () => {
  const hint = '上下文剩余不足：先 /compact 压缩，或在 设置 › AI 里调高引用预算';
  const { dispatch, calls } = fakeDispatch(() => ({
    rows: [{ key: `${KEY(1)}#0`, label: 'Big' }, { key: `${KEY(2)}#0`, label: 'Small' }],
    snapshots: [
      { key: `${KEY(1)}#0`, send: 'note', detail: hint, contextFull: true },
      { key: `${KEY(2)}#0`, send: 'S2', detail: 'd2' },
    ],
    pending: [],
  }));
  const sessionTrigger = createSessionTrigger(dispatch, { debounceMs: 0 });
  const context = { usedTokens: 191_000, contextWindow: 200_000, extra: 'dropped' };
  assert.deepEqual(await sessionTrigger.items({ query: '', context }), [
    { label: `${CONTEXT_FULL_PREFIX}Big`, send: 'note', detail: hint },
    { label: 'Small', send: 'S2', detail: 'd2' },
  ]);
  assert.deepEqual(calls[0].args.context, { usedTokens: 191_000, contextWindow: 200_000 });
  assert.equal(sessionTrigger.cache.size, 2, 'snapshot keys name their budget, so they stay cached');
  await sessionTrigger.items({ query: '', context });
  assert.deepEqual(calls[1].args.cached, [`${KEY(1)}#0`, `${KEY(2)}#0`]);
});

test('the row detail leads with the list\'s fresh update time', async () => {
  const { dispatch } = fakeDispatch(() => ({
    rows: [{ key: KEY(1), label: 'new task · 10-09 21:17', when: '5 min ago' }, { key: KEY(2), label: 'Other' }],
    snapshots: [{ key: KEY(1), send: 'S1', detail: '“Fix it” · 1 Q&A turn' }, { key: KEY(2), send: 'S2', detail: 'd2' }],
    pending: [],
  }));
  const sessionTrigger = createSessionTrigger(dispatch, { debounceMs: 0 });
  assert.deepEqual(await sessionTrigger.items({ query: '' }), [
    { label: 'new task · 10-09 21:17', send: 'S1', detail: '5 min ago · “Fix it” · 1 Q&A turn' },
    { label: 'Other', send: 'S2', detail: 'd2' },
  ]);
});

test('the host\'s session is left out; no context figures, no context', async () => {
  const { dispatch, calls } = fakeDispatch(() => ({
    rows: [{ key: KEY(1), label: 'One' }], snapshots: [{ key: KEY(1), send: 'S1', detail: 'd1' }], pending: [],
  }));
  const sessionTrigger = createSessionTrigger(dispatch, { debounceMs: 0 });
  const sessionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  await sessionTrigger.items({ query: '', sessionId });
  assert.equal(calls[0].args.exclude, sessionId);
  assert.equal(calls[0].args.context, undefined);
  await sessionTrigger.items({ query: '' });
  assert.equal(calls[1].args.exclude, undefined, 'an older host tells no session');
});

test('the host\'s Session references preferences are passed on with every call', async () => {
  const { dispatch, calls } = fakeDispatch(({ method }) => method === 'sessions.items'
    ? { rows: [{ key: KEY(1), label: 'One' }], snapshots: [], pending: [KEY(1)] }
    : { snapshots: [{ key: KEY(1), send: 'S1', detail: 'd1' }], pending: [] });
  const sessionTrigger = createSessionTrigger(dispatch, { debounceMs: 0 });
  const sessionReferences = { budgetPercent: 50, maxTurns: 3 };
  await sessionTrigger.items({ query: '', sessionReferences, context: { usedTokens: 1, contextWindow: 100 } });
  assert.deepEqual(calls.map((call) => call.args.references), [sessionReferences, sessionReferences]);
  assert.deepEqual(calls[1].args.context, { usedTokens: 1, contextWindow: 100 });
  await sessionTrigger.items({ query: '' });
  assert.equal(calls[2].args.references, undefined, 'an older host: the plugin\'s defaults apply');
  assert.deepEqual(triggerReferences({ budgetPercent: 10, maxTurns: 20, extra: 1 }), { budgetPercent: 10, maxTurns: 20 });
  for (const value of [undefined, null, {}, { budgetPercent: 10 }, { budgetPercent: 'x', maxTurns: 3 }]) {
    assert.equal(triggerReferences(value), undefined, JSON.stringify(value));
  }
});

test('only finite context figures with a window are passed on', () => {
  assert.deepEqual(triggerContext({ usedTokens: 5, contextWindow: 10 }), { usedTokens: 5, contextWindow: 10 });
  for (const context of [undefined, null, {}, { usedTokens: 5 }, { usedTokens: 5, contextWindow: 0 },
    { usedTokens: 'x', contextWindow: 10 }]) {
    assert.equal(triggerContext(context), undefined, JSON.stringify(context));
  }
});

const fenceBody = (send) => send.replace(/^\n`+pi\.session-mentions:chat\n/, '').replace(/\n`+\n$/, '');
const pairs = (n, size = 10) => Array.from({ length: n }, (_, i) => [`Q${i}`, `A${i} ${'x'.repeat(size)}`]);

test('the card reads its head from the block: title, turns, omitted, size', () => {
  const sent = buildSessionSnapshot({ ...source(A, pairs(14, 200)), title: 'Fix "the" <build>' }).send;
  const body = fenceBody(sent);
  const info = parseReference(body);
  assert.deepEqual({ ...info, bytes: undefined }, {
    id: A, title: 'Fix "the" <build>', turns: 10, firstTurn: true, omitted: 4, unread: false, clipped: false, bytes: undefined,
  });
  assert.equal(info.bytes, Buffer.byteLength(body, 'utf8'));
  assert.equal(referenceFacts(info, 'zh-CN'), `首轮 + 最近 9 轮 · 中间省略 4 轮 · 约 ${(info.bytes / 1024).toFixed(1)} KB`);
  assert.equal(referenceFacts(info, 'en'), `first + 9 recent turns · 4 between omitted · ~${(info.bytes / 1024).toFixed(1)} KB`);
  const whole = parseReference(fenceBody(buildSessionSnapshot(source(A, pairs(2))).send));
  assert.match(referenceFacts(whole, 'en'), /^2 Q&A turns · ~\d+ B$/);
  assert.equal(parseReference('not a block'), null);
});

test('the card is closed at first and shows the full text when opened', () => {
  const body = fenceBody(buildSessionSnapshot(source(A, pairs(3))).send);
  const closed = renderToStaticMarkup(createElement(ReferenceCard, { source: body, language: 'pi.session-mentions:chat' }));
  assert.match(closed, /^<div class="psm-card" data-psm-open="false" data-session-id="aaaaaaaa-/);
  assert.match(closed, /<button type="button" class="psm-head" aria-expanded="false"/);
  assert.match(closed, /<span class="psm-title">Alpha<\/span>/);
  assert.doesNotMatch(closed, /Q: Q1|referenced-chat/, 'the Q&A stays out of the chat window until opened');
  const open = renderToStaticMarkup(createElement(ReferenceCardView, { source: body, open: true, onToggle() {}, lang: 'zh-CN' }));
  assert.match(open, /aria-expanded="true"/);
  assert.match(open, /<span class="psm-kind">引用会话<\/span>/);
  assert.match(open, /<pre class="psm-body">&lt;referenced-chat [^<]*Q: Q0\nA: A0 x+\n\nQ: Q1/);
  // A fence it did not write is shown as text.
  assert.equal(renderToStaticMarkup(createElement(ReferenceCard, { source: 'hello' })), '<pre class="psm-raw">hello</pre>');
});

test('the UI locale is passed on; a snapshot cached in another language is built again', async () => {
  let detail = 'en detail';
  const { dispatch, calls } = fakeDispatch(({ method }) => method === 'sessions.items'
    ? { rows: [{ key: KEY(1), label: 'One' }], snapshots: calls.at(-1).args.cached.includes(KEY(1)) ? []
        : [{ key: KEY(1), send: 'S1', detail }], pending: [] }
    : { snapshots: [], pending: [] });
  const trigger = createSessionTrigger(dispatch, { debounceMs: 0 });
  assert.equal((await trigger.items({ query: '', locale: 'en' }))[0].detail, 'en detail');
  assert.equal(calls[0].args.locale, 'en');
  assert.equal((await trigger.items({ query: '', locale: 'en' }))[0].detail, 'en detail');
  assert.deepEqual(calls[1].args.cached, [KEY(1)], 'same language: reused');
  detail = '中文';
  assert.equal((await trigger.items({ query: '', locale: 'zh-CN' }))[0].detail, '中文');
  assert.deepEqual(calls[2].args.cached, [], 'another language: built again');
  assert.equal(calls[2].args.locale, 'zh-CN');
  await trigger.items({ query: '' });
  assert.equal('locale' in calls[3].args, false, 'an older host names none');
});

test('the warm-up is built in the host\'s app locale', async () => {
  const { dispatch, calls } = fakeDispatch(() => ({ rows: [], snapshots: [], pending: [] }));
  onLoad({ dispatch, app: { getLocale: async () => 'zh-CN' }, slots: { register() {} }, ui: { injectStyle() {} } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls[0], { method: 'sessions.items', args: { query: '', cached: [], locale: 'zh-CN' } });
});

test('the card names an untitled session as the app does', () => {
  const body = fenceBody(buildSessionSnapshot({ ...source(A, pairs(1)), title: 'new task' }).send);
  const zh = renderToStaticMarkup(createElement(ReferenceCardView, { source: body, open: false, onToggle() {}, lang: 'zh-CN' }));
  assert.match(zh, /<span class="psm-title">新建任务<\/span>/);
  assert.match(zh, /<span class="psm-facts">1 轮问答 · 约 /);
  const en = renderToStaticMarkup(createElement(ReferenceCardView, { source: body, open: false, onToggle() {}, lang: 'en' }));
  assert.match(en, /<span class="psm-title">New task<\/span>/);
  assert.match(en, /<span class="psm-kind">Referenced chat<\/span>/);
  assert.equal(displayTitle('Release plan', 'zh-CN'), 'Release plan');
  assert.equal(displayTitle(' 新建任务 ', 'en'), 'New task');
  assert.equal(displayTitle('', 'zh-CN'), '');
});
