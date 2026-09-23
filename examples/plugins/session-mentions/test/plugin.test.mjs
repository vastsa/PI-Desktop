import assert from 'node:assert/strict';
import test from 'node:test';
import install from '../extension.mjs';
import { createSessionMentionService } from '../service.mjs';
import { referenceBudget, referencePage } from '../context.mjs';
import { A, B, C, page, user, assistant } from './helpers.mjs';

function fakeHost(replies = {}) {
  const calls = [];
  const host = { plugin: { getSettings: async () => ({ budgetPercent: 25 }) }, desktop: {
    invoke: async ({ operation, args }) => {
      calls.push({ operation, args });
      const reply = replies[operation];
      return typeof reply === 'function' ? reply(args) : reply;
    },
  } };
  return { calls, host, service: createSessionMentionService(host) };
}
function hook(overrides = {}) {
  let input;
  const reads = [];
  const notices = [];
  install({ on: (name, fn) => { assert.equal(name, 'input'); input = fn; },
    getPluginSettings: () => ({ budgetPercent: 25 }),
    recap: async (args) => { reads.push(args); return { scope: 'session', sessionId: args.sessionId,
      title: 'Other chat', messageStart: 0, messageEnd: 2, truncated: false,
      messages: [user('QUESTION'), assistant('ANSWER', { thinking: 'SECRET THINKING' })] }; },
    ...overrides });
  const ctx = { getContextUsage: () => ({ tokens: 1000, contextWindow: 128000 }),
    model: { maxTokens: 8192 }, ui: { notify: (...args) => notices.push(args) } };
  return { call: (text, context = ctx) => input({ text, sessionId: C, attachments: [] }, context), reads, notices, ctx };
}

test('plugin actually registers the input hook and transforms only the model copy', async () => {
  const h = hook(); const text = `Use @session:${A} now`;
  const result = await h.call(text);
  assert.equal(result.action, 'transform');
  assert.ok(result.text.includes('QUESTION'));
  assert.ok(result.text.includes('ANSWER'));
  assert.ok(!result.text.includes('SECRET THINKING'));
  assert.ok(result.text.endsWith(text));
  assert.deepEqual(h.reads, [{ scope: 'session', sessionId: A, limit: 400 }]);
});
test('unreferenced and self-referenced inputs do not read any session', async () => {
  const h = hook();
  assert.deepEqual(await h.call(`literal @session:${C}`), { action: 'continue' });
  assert.deepEqual(await h.call('hello'), { action: 'continue' });
  assert.equal(h.reads.length, 0);
});
test('unknown context is blocked, not guessed to be empty', async () => {
  const h = hook();
  const result = await h.call(`@session:${A}`, { ...h.ctx, getContextUsage: () => undefined });
  assert.equal(result.action, 'handled'); assert.equal(h.reads.length, 0);
});
test('a refused session read blocks instead of passing an unresolved token', async () => {
  const h = hook({ recap: async () => undefined });
  assert.equal((await h.call(`@session:${A}`)).action, 'handled');
});
test('runtime input pages using the actual physical before cursor', async () => {
  const calls = [];
  const h = hook({ recap: async (args) => {
    calls.push(args);
    return args.before === undefined
      ? { scope: 'session', sessionId: A, title: 'Paged', messages: [assistant('answer')], messageStart: 1, messageEnd: 2, truncated: true }
      : { scope: 'session', sessionId: A, title: 'Paged', messages: [user('question')], messageStart: 0, messageEnd: 1, truncated: false };
  } });
  const result = await h.call(`@session:${A}`);
  assert.equal(result.action, 'transform'); assert.ok(result.text.includes('question'));
  assert.equal(calls[1].before, 1);
});
test('source errors are converted to a readable handled result', async () => {
  const h = hook({ recap: async () => { throw new Error('offline'); } });
  const result = await h.call(`@session:${A}`);
  assert.equal(result.action, 'handled'); assert.match(result.reason, /offline/);
});
test('search includes local durable sessions only and excludes the current one', async () => {
  const { service, calls } = fakeHost({ 'session/list': { sessions: [
    { id: A, title: 'Alpha', updatedAt: '2026-09-20' },
    { id: B, title: 'Beta', updatedAt: '2026-09-21' },
    { id: C, title: 'Native', source: 'pi-native' },
  ] } });
  assert.deepEqual(await service.call('sessions.search', { query: '', sessionId: A }), {
    items: [{ id: B, title: 'Beta' }], truncated: false,
  });
  assert.deepEqual(calls, [{ operation: 'session/list', args: [] }]);
});
test('new-task search works without a materialized session', async () => {
  const { service } = fakeHost({ 'session/list': { sessions: [{ id: A, title: 'Alpha' }] } });
  assert.equal((await service.call('sessions.search', { query: 'alp' })).items[0].id, A);
});
test('reference preflight uses the reviewed native read and returns no transcript', async () => {
  const { service, calls } = fakeHost({ 'session/get': { session: page(A, [user('private question'), assistant('private answer')]) } });
  const result = await service.call('references.validate', { text: `@session:${A}`, sessionId: C,
    contextWindow: 128000, usedTokens: 100 });
  assert.deepEqual(result, { ok: true });
  assert.ok(!JSON.stringify(result).includes('private'));
  assert.deepEqual(calls, [{ operation: 'session/get', args: [{ id: A, messageLimit: 400 }] }]);
});
test('oversized latest Q&A fails preflight and leaves original text with its caller', async () => {
  const { service } = fakeHost({ 'session/get': { session: page(A, [user('q'), assistant('x'.repeat(20000))]) } });
  const text = `@session:${A}`;
  const result = await service.call('references.validate', { text, contextWindow: 12000, usedTokens: 0 });
  assert.equal(result.ok, false); assert.match(result.reason, /budget/);
  assert.equal(text, `@session:${A}`);
});
test('preflight refuses a disappeared source', async () => {
  const { service } = fakeHost({ 'session/get': { session: null } });
  assert.equal((await service.call('references.validate', { text: `@session:${A}`, contextWindow: 128000, usedTokens: 0 })).ok, false);
});
test('navigation is explicit, validated and the only write operation', async () => {
  const { service, calls } = fakeHost({ 'session/open': { ok: true } });
  await assert.rejects(service.call('sessions.open', { id: 'not-a-session' }));
  await service.call('sessions.open', { id: A });
  assert.deepEqual(calls, [{ operation: 'session/open', args: [A] }]);
  await assert.rejects(service.call('run.anything', {}));
});
test('unload prevents new calls and cancels in-flight preflight', async () => {
  const { service } = fakeHost({ 'session/get': () => new Promise(() => {}) });
  const request = service.call('references.validate', { text: `@session:${A}`, contextWindow: 128000, usedTokens: 0 });
  await new Promise((resolve) => setTimeout(resolve, 5));
  service.dispose();
  const answer = await request;
  assert.equal(answer.ok, false);
  await assert.rejects(service.call('sessions.search'));
});
test('boundary projection excludes thought, tools, delegates and attachment content', () => {
  const projected = referencePage(page(A, [user('', { attachments: [{ bytes: 'secret' }] }),
    assistant('public', { thinking: 'secret' }),
    assistant('delegate', { parentToolCallId: 'tool-id' }), { role: 'tool', content: 'secret' }]), A);
  assert.equal(projected.messages.length, 2);
  assert.ok(!JSON.stringify(projected).includes('secret'));
  assert.ok(!JSON.stringify(projected).includes('delegate'));
});
test('budget reserves prompt/output capacity and uses one chosen percentage', () => {
  const usage = { contextWindow: 100000, usedTokens: 10000, maxOutputTokens: 1000 };
  const full = referenceBudget('', usage, 100);
  assert.equal(referenceBudget('', usage, 25), Math.floor(full / 4));
  assert.ok(referenceBudget('new prompt', usage, 100) < full);
  assert.equal(referenceBudget('', { ...usage, usedTokens: NaN }), 0);
});
