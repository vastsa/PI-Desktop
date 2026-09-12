import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'
import { noticeRoute, verifyLocalePairs } from './check-locales.mjs'

test('notice routes keep POSIX separators on every platform', () => {
  // `markdownFiles` builds its paths with `path.relative`, which separates with
  // backslashes on Windows. The notice is a routed link, so a backslash there
  // makes every Chinese mirror look like it is missing its source notice.
  const relative = ['01-product', '00-overview.md'].join(path.sep)

  assert.equal(noticeRoute(relative), '/spec/01-product/00-overview')
  assert.equal(noticeRoute('03-runtime/01-ipc-protocol.md'), '/spec/03-runtime/01-ipc-protocol')
  assert.ok(!noticeRoute(relative).includes('\\'))
})

test('every English specification has a valid Chinese mirror', () => {
  const { englishFiles, missing, invalid } = verifyLocalePairs()

  assert.ok(englishFiles.length > 0, 'expected to discover English specifications')
  assert.deepEqual(missing, [], 'Chinese specifications missing for the listed English pages')
  assert.deepEqual(invalid, [], 'Chinese pages whose source notice or structure is invalid')
})
