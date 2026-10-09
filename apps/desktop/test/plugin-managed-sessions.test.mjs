import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const source = readFileSync(new URL('../electron/main/plugin-managed-sessions.ts', import.meta.url), 'utf8');
const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { createManagedSessionRouter } = await import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`);

test('native text submit reaches only the durable owner and returns a plugin receipt', async () => {
  const received = [];
  const router = createManagedSessionRouter({ owner: async id => id === 'room' ? 'plugin.one' : null, submit: async (...args) => received.push(args) });
  assert.equal(await router.prompt({ sessionId: 'normal', content: 'ordinary' }), null);
  assert.deepEqual(await router.prompt({ sessionId: 'room', content: 'hello', messageId: 'stable-id' }), { accepted: true, managed: true, turnId: 'stable-id' });
  assert.deepEqual(received, [['plugin.one', { sessionId: 'room', content: 'hello', messageId: 'stable-id' }]]);
  await assert.rejects(router.rejectAgentOperation('room'), { errorCode: 'PLUGIN_SESSION_MANAGED' });
  await router.rejectAgentOperation('normal');
});

test('unavailable owner and host read failures never fall back to ordinary prompting', async () => {
  const router = createManagedSessionRouter({ owner: async () => 'plugin.one', submit: async () => { throw new Error('disabled'); } });
  await assert.rejects(router.prompt({ sessionId: 'room', content: 'hello' }), /disabled/);
  const failedRead = createManagedSessionRouter({ owner: async () => { throw new Error('host unavailable'); }, submit: async () => assert.fail() });
  await assert.rejects(failedRead.prompt({ sessionId: 'room', content: 'hello' }), /host unavailable/);
});

test('pending submissions serialize; failure releases the fence; unsupported attachment sends remain unaccepted', async () => {
  let finish;
  let call = 0;
  const router = createManagedSessionRouter({ owner: async () => 'plugin.one', submit: async () => { call++; await new Promise(resolve => { finish = resolve; }); } });
  const first = router.prompt({ sessionId: 'room', content: 'one' });
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(router.prompt({ sessionId: 'room', content: 'two' }), { errorCode: 'BUSY' });
  await assert.rejects(router.prompt({ sessionId: 'room', content: 'attachment', attachments: [{}] }), { errorCode: 'UNSUPPORTED' });
  assert.equal(call, 1);
  finish();
  assert.equal((await first).managed, true);
  const again = router.prompt({ sessionId: 'room', content: 'three' });
  await new Promise(resolve => setImmediate(resolve));
  finish();
  await again;
  assert.equal(call, 2);
});
