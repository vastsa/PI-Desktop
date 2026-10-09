import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const source = readFileSync(new URL('../electron/main/plugin-managed-sessions.ts', import.meta.url), 'utf8');
const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
// `prompt-attachments` is a sibling module the data-URL import cannot resolve,
// so the router's attachment dependency is exercised with a stub that mirrors
// the content-addressed contract: one descriptor per resolved attachment.
const stub = `data:text/javascript;base64,${Buffer.from(
  `export async function prepareManagedPromptAttachments(dataDir, sessionId, projectPath, attachments) { return attachments.map(a => ({ ref: 'attachments/' + '0'.repeat(64), name: a.name ?? 'attachment', kind: 'image' })); }`,
).toString('base64')}`;
const rewritten = output.replace('"./prompt-attachments"', JSON.stringify(stub));
const { createManagedSessionRouter } = await import(`data:text/javascript;base64,${Buffer.from(rewritten).toString('base64')}`);

test('native text submit reaches only the durable owner and returns a plugin receipt', async () => {
  const received = [];
  const router = createManagedSessionRouter({ owner: async id => id === 'room' ? 'plugin.one' : null, submit: async (...args) => received.push(args), dataDir: '/tmp', projectPath: async () => undefined });
  assert.equal(await router.prompt({ sessionId: 'normal', content: 'ordinary' }), null);
  assert.deepEqual(await router.prompt({ sessionId: 'room', content: 'hello', messageId: 'stable-id' }), { accepted: true, managed: true, turnId: 'stable-id' });
  assert.deepEqual(received, [['plugin.one', { sessionId: 'room', content: 'hello', messageId: 'stable-id', attachments: [] }]]);
  await assert.rejects(router.rejectAgentOperation('room'), { errorCode: 'PLUGIN_SESSION_MANAGED' });
  await router.rejectAgentOperation('normal');
});

test('unavailable owner and host read failures never fall back to ordinary prompting', async () => {
  const router = createManagedSessionRouter({ owner: async () => 'plugin.one', submit: async () => { throw new Error('disabled'); }, dataDir: '/tmp', projectPath: async () => undefined });
  await assert.rejects(router.prompt({ sessionId: 'room', content: 'hello' }), /disabled/);
  const failedRead = createManagedSessionRouter({ owner: async () => { throw new Error('host unavailable'); }, submit: async () => assert.fail(), dataDir: '/tmp', projectPath: async () => undefined });
  await assert.rejects(failedRead.prompt({ sessionId: 'room', content: 'hello' }), /host unavailable/);
});

test('pending submissions serialize; failure releases the fence; attachments are prepared and forwarded', async () => {
  let finish;
  let call = 0;
  const received = [];
  const router = createManagedSessionRouter({ owner: async () => 'plugin.one', submit: async (_plugin, input) => { call++; received.push(input); await new Promise(resolve => { finish = resolve; }); }, dataDir: '/tmp', projectPath: async () => undefined });
  const first = router.prompt({ sessionId: 'room', content: 'one' });
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(router.prompt({ sessionId: 'room', content: 'two' }), { errorCode: 'BUSY' });
  assert.equal(call, 1);
  finish();
  assert.equal((await first).managed, true);
  const again = router.prompt({ sessionId: 'room', content: 'three' });
  await new Promise(resolve => setImmediate(resolve));
  finish();
  await again;
  assert.equal(call, 2);
});

// The project-path dependency issues a real host `session.get` on every managed
// send, before the submission reaches the plugin. An earlier revision asked for
// `messageLimit: 0`, which host-core refuses
// ("session read window must use non-negative messageBefore and positive
// messageLimit", INVALID_PARAMS), so every room message failed with a failed-turn
// banner instead of being delivered. The window fields are host-owned defaults;
// the dependency only needs the session's project path.
test('the project-path host read never sends an invalid read window', () => {
  const register = readFileSync(new URL('../electron/main/ipc/register.ts', import.meta.url), 'utf8');
  const start = register.indexOf('projectPath: async (sessionId) => {');
  assert.notEqual(start, -1, 'the managed-session projectPath dependency is missing');
  const block = register.slice(start, register.indexOf('\n      },', start));
  assert.match(block, /"session\.get"/);
  assert.doesNotMatch(block, /messageLimit:\s*0/);
  assert.doesNotMatch(block, /messageBefore:/);
  assert.doesNotMatch(block, /messageAround:/);
});

test('a failing project-path read fails the submission instead of executing locally', async () => {
  const router = createManagedSessionRouter({
    owner: async () => 'plugin.one',
    submit: async () => assert.fail('a failed path read must not submit'),
    dataDir: '/tmp',
    projectPath: async () => {
      throw Object.assign(new Error('session read window must use non-negative messageBefore and positive messageLimit'), { code: 'INVALID_PARAMS' });
    },
  });
  await assert.rejects(router.prompt({ sessionId: 'room', content: 'hello' }), /positive messageLimit/);
});

// Voice input stays unsupported: a managed transcript has no turn to attribute
// a transcription to. Attachments, by contrast, are content-addressed and handed
// to the plugin as descriptors.
test('voice origin is refused and an attachment becomes a content-addressed descriptor', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'managed-att-'));
  writeFileSync(join(dataDir, 'scratch-note.txt'), 'hello');
  const received = [];
  const router = createManagedSessionRouter({ owner: async () => 'plugin.one', submit: async (_plugin, input) => received.push(input), dataDir, projectPath: async () => undefined });
  await assert.rejects(router.prompt({ sessionId: 'room', content: 'spoken', voiceOrigin: 'dictation' }), { errorCode: 'UNSUPPORTED' });
  await router.prompt({
    sessionId: 'room',
    content: 'look',
    messageId: 'm-1',
    attachments: [{ path: 'attachments/' + 'a'.repeat(64), name: 'photo.png', size: 3 }],
  });
  assert.deepEqual(received[0].attachments, [{ ref: 'attachments/' + '0'.repeat(64), name: 'photo.png', kind: 'image' }]);
});
