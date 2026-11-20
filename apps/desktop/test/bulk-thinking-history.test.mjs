import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';
register('./helpers/ts-import-hooks.mjs', import.meta.url);
const { readThinkingMessageIds } = await import('../src/lib/thinking-history.ts');
const thought = (id) => ({ id, role: 'assistant', content: '', thinking: id, createdAt: '2026-11-13' });

test('reads all pages before returning IDs, including remote opaque cursors', async () => {
  const calls = [];
  const pages = [
    { messages: [thought('new')], hasMoreBefore: true, messageStart: 281474976710656 },
    { messages: [thought('old')], hasMoreBefore: false },
  ];
  const ids = await readThinkingMessageIds({ sessionId: 's', liveMessages: [thought('live')],
    isCurrent: () => true, readSession: async (id, options) => { calls.push(options); return { session: pages.shift() }; } });
  assert.deepEqual(new Set(ids), new Set(['live', 'new', 'old']));
  assert.deepEqual(calls, [undefined, { messageBefore: 281474976710656 }]);
});

test('a later page failure rejects the entire read', async () => {
  let calls = 0;
  await assert.rejects(readThinkingMessageIds({ sessionId: 's', liveMessages: [], isCurrent: () => true,
    readSession: async () => { if (calls++) throw new Error('offline'); return { session: { messages: [thought('a')], hasMoreBefore: true, messageStart: 100 } }; },
  }), /offline/);
});

test('departure stops paging without returning a partial batch', async () => {
  let active = true;
  const result = await readThinkingMessageIds({ sessionId: 's', liveMessages: [], isCurrent: () => active,
    readSession: async () => { active = false; return { session: { messages: [thought('a')], hasMoreBefore: true, messageStart: 100 } }; },
  });
  assert.equal(result, undefined);
});

test('repeated cursors fail explicitly rather than looping or silently skipping history', async () => {
  await assert.rejects(readThinkingMessageIds({ sessionId: 's', liveMessages: [], isCurrent: () => true,
    readSession: async () => ({ session: { messages: [thought('a')], hasMoreBefore: true, messageStart: 100 } }),
  }), /cursor/);
});
