import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { register } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
const here = fileURLToPath(new URL('.', import.meta.url));
register(pathToFileURL(join(here, 'helpers/ts-import-hooks.mjs')));
const { createManagedAttachmentStore, MAX_MANAGED_ATTACHMENT_CHUNK_BASE64, MAX_MANAGED_ATTACHMENT_BYTES } =
  await import('../electron/main/plugin-managed-attachments.ts');

// The store is the only thing standing between a plugin and every blob on the
// machine, and the process test above stubs all four calls away. These exercise
// the real store directly: chunked round trip, ref shape, upload ownership
// across plugins, and unload cleanup.
function store(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'managed-blob-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  return { dataDir, blobs: createManagedAttachmentStore(dataDir) };
}
const sha = bytes => `attachments/${createHash('sha256').update(bytes).digest('hex')}`;
const chunk = (bytes, size) => {
  const parts = [];
  for (let offset = 0; offset < bytes.length; offset += size) parts.push(bytes.subarray(offset, offset + size));
  return parts.length ? parts : [bytes.subarray(0, 0)];
};
async function upload(blobs, pluginId, bytes, name = 'shot.png', size = bytes.length) {
  const { uploadId } = blobs.begin(pluginId, { name, size, mimeType: 'application/octet-stream' });
  let offset = 0;
  for (const part of chunk(bytes, 7)) {
    await blobs.write(pluginId, { uploadId, offset, dataBase64: part.toString('base64') });
    offset += part.length;
  }
  return blobs.commit(pluginId, { uploadId });
}
async function readAll(blobs, ref, length) {
  const parts = [];
  for (let offset = 0; ; ) {
    const page = await blobs.read({ ref, offset, length });
    assert.equal(page.ref, ref);
    assert.equal(page.offset, offset);
    parts.push(Buffer.from(page.contentBase64, 'base64'));
    offset += Buffer.from(page.contentBase64, 'base64').length;
    if (page.eof) return { bytes: Buffer.concat(parts), size: page.size };
    assert.ok(page.contentBase64.length > 0, 'a non-eof chunk must carry bytes');
  }
}

test('a chunked upload is content-addressed and reads back byte for byte', async t => {
  const { dataDir, blobs } = store(t);
  const bytes = Buffer.from('room attachment payload, longer than one small chunk');
  const committed = await upload(blobs, 'plugin.one', bytes);
  assert.equal(committed.ref, sha(bytes));
  assert.equal(committed.size, bytes.length);
  // The blob landed under the content-addressed root, not under staging.
  assert.ok(readdirSync(join(dataDir, 'attachments')).includes(committed.ref.slice('attachments/'.length)));
  // Reading in small windows reassembles the same bytes and ends exactly once.
  const { bytes: restored, size } = await readAll(blobs, committed.ref, 5);
  assert.deepEqual(restored, bytes);
  assert.equal(size, bytes.length);
  // An identical upload of the same bytes converges on the same ref.
  assert.equal((await upload(blobs, 'plugin.one', bytes)).ref, committed.ref);
});

test('a ref must be attachments/<sha256>; a path is never readable', async t => {
  const { blobs } = store(t);
  for (const ref of ['/etc/passwd', 'attachments/../../etc/passwd', 'attachments/short', `attachments/${'z'.repeat(64)}`]) {
    await assert.rejects(blobs.read({ ref }), { errorCode: 'INVALID_PARAMS' });
  }
  // A well-formed ref for a blob this machine does not hold is NOT_FOUND.
  await assert.rejects(blobs.read({ ref: `attachments/${'a'.repeat(64)}` }), { errorCode: 'NOT_FOUND' });
});

test('a staged upload belongs to the plugin that began it', async t => {
  const { blobs } = store(t);
  const { uploadId } = blobs.begin('plugin.one', { name: 'shot.png', size: 4 });
  const body = { uploadId, offset: 0, dataBase64: Buffer.from('abcd').toString('base64') };
  await assert.rejects(blobs.write('plugin.two', body), { errorCode: 'NOT_FOUND' });
  await assert.rejects(blobs.commit('plugin.two', { uploadId }), { errorCode: 'NOT_FOUND' });
  // The owner is unaffected by the foreign attempts.
  assert.deepEqual(await blobs.write('plugin.one', body), { received: 4 });
  assert.equal((await blobs.commit('plugin.one', { uploadId })).ref, sha(Buffer.from('abcd')));
});

test('unload drops only the unloading plugin staged uploads', async t => {
  const { blobs } = store(t);
  const mine = blobs.begin('plugin.one', { name: 'a.bin', size: 2 });
  const theirs = blobs.begin('plugin.two', { name: 'b.bin', size: 2 });
  blobs.discardPlugin('plugin.one');
  await assert.rejects(blobs.commit('plugin.one', { uploadId: mine.uploadId }), { errorCode: 'NOT_FOUND' });
  // A different plugin's staged upload survives another plugin's unload.
  await blobs.write('plugin.two', { uploadId: theirs.uploadId, offset: 0, dataBase64: Buffer.from('xy').toString('base64') });
  assert.equal((await blobs.commit('plugin.two', { uploadId: theirs.uploadId })).size, 2);
});

test('upload bounds are enforced before anything is hashed into place', async t => {
  const { blobs } = store(t);
  // `begin` is synchronous, so a rejected stage is a throw, not a rejection.
  assert.throws(() => blobs.begin('plugin.one', { name: 'big.bin', size: MAX_MANAGED_ATTACHMENT_BYTES + 1 }), { errorCode: 'INVALID_PARAMS' });
  assert.throws(() => blobs.begin('plugin.one', { name: '', size: 1 }), { errorCode: 'INVALID_PARAMS' });
  assert.throws(() => blobs.begin('plugin.one', { name: 'x'.repeat(256), size: 1 }), { errorCode: 'INVALID_PARAMS' });
  // Chunks must arrive in order and never exceed the declared size.
  const { uploadId } = blobs.begin('plugin.one', { name: 'a.bin', size: 3 });
  await assert.rejects(blobs.write('plugin.one', { uploadId, offset: 2, dataBase64: 'AAAA' }), { errorCode: 'INVALID_PARAMS' });
  await assert.rejects(blobs.write('plugin.one', { uploadId, offset: 0, dataBase64: Buffer.alloc(4, 1).toString('base64') }), { errorCode: 'LIMIT_EXCEEDED' });
  await assert.rejects(blobs.write('plugin.one', { uploadId, offset: 0, dataBase64: 'A'.repeat(MAX_MANAGED_ATTACHMENT_CHUNK_BASE64 * 2 + 1) }), { errorCode: 'LIMIT_EXCEEDED' });
  // An incomplete upload is refused and its staging slot is released.
  await assert.rejects(blobs.commit('plugin.one', { uploadId }), { errorCode: 'INVALID_PARAMS' });
  await assert.rejects(blobs.commit('plugin.one', { uploadId }), { errorCode: 'NOT_FOUND' });
  // Staged uploads are capped per plugin; another plugin has its own budget.
  for (let i = 0; i < 8; i++) blobs.begin('plugin.one', { name: `f${i}.bin`, size: 1 });
  assert.throws(() => blobs.begin('plugin.one', { name: 'overflow.bin', size: 1 }), { errorCode: 'LIMIT_EXCEEDED' });
  blobs.begin('plugin.two', { name: 'theirs.bin', size: 1 });
});
