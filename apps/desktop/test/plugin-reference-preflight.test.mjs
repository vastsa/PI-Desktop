import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';
register(new URL('./helpers/ts-import-hooks.mjs', import.meta.url));
globalThis.piDesktop = { invoke: async () => ({ ok: true, data: null }), on: () => () => {} };
const { pluginSlots, resetPluginSlots } = await import('../src/plugins/renderer-slots/registry.ts');
const { validateReferenceSend } = await import('../src/plugins/renderer-slots/reference-preflight.ts');
const input = { text: 'draft', contextWindow: 128000, usedTokens: 0, hasAttachments: false, steering: false };
function hook(validateSend) {
  resetPluginSlots();
  return pluginSlots.register('test.reference', 'composerReference', () => null, { validateSend });
}
test('existing reference slot validates before a caller can commit its draft', async () => {
  let checked = false;
  hook(async (value) => { checked = true; assert.equal(value.text, 'draft'); return { ok: false, reason: 'too large' }; });
  let committed = false;
  await assert.rejects(async () => { await validateReferenceSend(input, new AbortController().signal); committed = true; }, /too large/);
  assert.equal(checked, true); assert.equal(committed, false);
});
test('a hung reference provider fails closed under the global deadline', async () => {
  hook(() => new Promise(() => {}));
  await assert.rejects(validateReferenceSend(input, new AbortController().signal, 10), /TIMEOUT/);
});
test('unloading a provider cancels an in-flight reference validation', async () => {
  const registration = hook(() => new Promise(() => {}));
  const pending = validateReferenceSend(input, new AbortController().signal, 1000);
  registration.remove();
  await assert.rejects(pending, /UNLOADED/);
});
test('an invalid or throwing response never authorizes a send', async () => {
  hook(() => undefined);
  await assert.rejects(validateReferenceSend(input, new AbortController().signal), /INVALID_RESULT/);
  hook(() => { throw new Error('failed'); });
  await assert.rejects(validateReferenceSend(input, new AbortController().signal), /failed/);
});
test('validation cannot be attached to an unrelated component slot', () => {
  resetPluginSlots();
  assert.equal(pluginSlots.register('test.invalid', 'entryExtra', () => null, { validateSend: () => ({ ok: true }) }), null);
});
test('ordinary sends without a reference validator stay unchanged', async () => {
  resetPluginSlots();
  await validateReferenceSend(input, new AbortController().signal);
});
test('successful reference validations run in order and preserve the original input', async () => {
  const seen = [];
  hook(async (value) => { seen.push(value.text); return { ok: true }; });
  pluginSlots.register('test.second', 'composerReference', () => null, {
    validateSend: async (value) => { seen.push(value.text); return { ok: true }; },
  });
  await validateReferenceSend(input, new AbortController().signal);
  assert.deepEqual(seen, ['draft', 'draft']);
  assert.equal(input.text, 'draft');
});
test('caller cancellation prevents a late successful response from authorizing a send', async () => {
  let finish;
  hook(() => new Promise((resolve) => { finish = resolve; }));
  const controller = new AbortController();
  const pending = validateReferenceSend(input, controller.signal);
  controller.abort(new Error('draft changed'));
  finish({ ok: true });
  await assert.rejects(pending, /draft changed/);
});
