import assert from 'node:assert/strict';
import { register } from 'node:module';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { resolveRealOpenablePath } from '@pi-desktop/host-runtime';
register(new URL('./helpers/ts-import-hooks.mjs', import.meta.url));
const { VideoPreviewService } = await import('../electron/main/video-preview.ts');
const { isVideoReference, localVideoRef, remarkLocalVideoPaths } = await import('../src/lib/markdown-video.ts');

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'video-preview-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const scratch = join(dir, 'scratch');
  await mkdir(scratch);
  const path = join(scratch, '海 洋.mp4');
  const bytes = await readFile(new URL('../resources/skills/ai-aggregation-platform/tests/fixtures/clip.mp4', import.meta.url));
  await writeFile(path, bytes);
  let destination = join(dir, 'saved.mp4');
  let allowed = true;
  const service = new VideoPreviewService(
    (ref) => allowed ? resolveRealOpenablePath(ref, null, [scratch]) : Promise.resolve(null),
    async () => destination,
  );
  return { dir, scratch, path, bytes, service, destination: (value) => { destination = value; }, deny: () => { allowed = false; } };
}

test('saved scratch video streams full, ranged, suffix and HEAD requests and releases its lease', async (t) => {
  const f = await fixture(t);
  const result = await f.service.acquire(f.path);
  assert.equal(result.name, '海 洋.mp4');
  assert.equal(result.mimeType, 'video/mp4');
  const request = (headers = {}, method = 'GET') => f.service.respond(new Request(result.url, { headers, method }));
  const full = await request();
  assert.equal(full.status, 200);
  assert.deepEqual(Buffer.from(await full.arrayBuffer()), f.bytes);
  for (const [range, start, end] of [['bytes=2-9', 2, 9], ['bytes=8-', 8, f.bytes.length - 1], ['bytes=-10', f.bytes.length - 10, f.bytes.length - 1]]) {
    const part = await request({ range });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), `bytes ${start}-${end}/${f.bytes.length}`);
    assert.deepEqual(Buffer.from(await part.arrayBuffer()), f.bytes.subarray(start, end + 1));
  }
  const head = await request({}, 'HEAD');
  assert.equal(head.headers.get('content-length'), String(f.bytes.length));
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  for (const range of ['bytes=-0', 'bytes=999999999-', 'bytes=8-1', 'bytes=0-1,4-5', 'garbage']) {
    assert.equal((await request({ range })).status, 416, range);
  }
  assert.equal((await request({}, 'POST')).status, 405);
  f.service.release(result.url);
  assert.equal((await request()).status, 404);
});

test('native save copies exactly, cancellation does not write and same-file save never truncates', async (t) => {
  const f = await fixture(t);
  const video = await f.service.acquire(f.path);
  assert.deepEqual(await f.service.save(video.url), { canceled: false });
  assert.deepEqual(await readFile(join(f.dir, 'saved.mp4')), f.bytes);
  f.destination(f.path);
  await f.service.save(video.url);
  assert.deepEqual(await readFile(f.path), f.bytes);
  f.destination(null);
  assert.deepEqual(await f.service.save(video.url), { canceled: true });
  f.destination(join(f.dir, 'missing', 'save.mp4'));
  await assert.rejects(f.service.save(video.url));
});

test('containment, symlinks, non-video bytes and changed roots cannot be bypassed', async (t) => {
  const f = await fixture(t);
  const outside = join(f.dir, 'private.mp4');
  await writeFile(outside, f.bytes);
  await assert.rejects(f.service.acquire(outside));
  await symlink(outside, join(f.scratch, 'escape.mp4'));
  await assert.rejects(f.service.acquire(join(f.scratch, 'escape.mp4')));
  const fake = join(f.scratch, 'fake.mp4');
  await writeFile(fake, '<html>private text</html>');
  await assert.rejects(f.service.acquire(fake));
  const video = await f.service.acquire(f.path);
  f.deny();
  assert.equal((await f.service.respond(new Request(video.url))).status, 404);
  await assert.rejects(f.service.save(video.url));
  f.service.clear();
  await assert.rejects(f.service.save(video.url), /expired/);
});

test('local video links preserve macOS scratch and Windows paths through markdown sanitization', () => {
  for (const path of ['/tmp/scratch/海 洋.mp4', 'C:/scratch/ocean.MP4', String.raw`D:\scratch\ocean.webm`]) {
    assert.equal(isVideoReference(path), true);
    assert.equal(localVideoRef(encodeURIComponent(path), '/project'), path);
    const tree = { type: 'root', children: [{ type: 'link', url: path }] };
    remarkLocalVideoPaths()(tree);
    assert.equal(tree.children[0].url, encodeURIComponent(path));
  }
  assert.equal(localVideoRef('file:///C:/scratch/ocean.mp4'), 'C:/scratch/ocean.mp4');
  assert.equal(localVideoRef('file:///tmp/sea%20video.mp4'), '/tmp/sea video.mp4');
  assert.equal(localVideoRef('../movie.mp4', '/project', 'docs'), 'movie.mp4');
  for (const path of ['../../escape.mp4', '//server/movie.mp4', 'javascript:movie.mp4', 'file://server/movie.mp4', '%ZZ.mp4']) {
    assert.equal(localVideoRef(path, '/project'), null, path);
  }
  assert.equal(isVideoReference('https://example.com/video.mp4?token=1'), true);
  assert.equal(isVideoReference('https://example.com/page?name=video.mp4'), false);
});


test('renderer reload cancels an in-flight lease acquisition', async (t) => {
  const f = await fixture(t);
  let resume;
  const gate = new Promise((resolve) => { resume = resolve; });
  const service = new VideoPreviewService(async () => { await gate; return f.path; }, async () => null);
  const acquiring = service.acquire(f.path);
  service.clear();
  resume();
  await assert.rejects(acquiring, /canceled/);
});
