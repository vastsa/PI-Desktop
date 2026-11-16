import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
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

test('the repository Chinese pages are valid and the required entry points exist', () => {
  const { englishFiles, missing, invalid } = verifyLocalePairs()

  assert.ok(englishFiles.includes('README.md'), 'the specification index is a required mirror')
  assert.deepEqual(missing, [], 'required Chinese pages are missing')
  assert.deepEqual(invalid, [], 'Chinese pages whose source notice or structure is invalid')
})

test('spec mirrors are optional, but an existing one must match an English page', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-locale-docs-'))
  try {
    fs.mkdirSync(path.join(root, 'spec/01-product'), { recursive: true })
    fs.mkdirSync(path.join(root, 'zh-CN/spec/01-product'), { recursive: true })
    fs.writeFileSync(path.join(root, 'spec/README.md'), '# Specs\n')
    fs.writeFileSync(path.join(root, 'spec/01-product/00-overview.md'), '# Overview\n')
    fs.writeFileSync(path.join(root, 'plugin-development.md'), '# Plugins\n\n### 6.7 Theme\n\n### 6.8 Views\n')
    fs.writeFileSync(path.join(root, 'zh-CN/plugin-development.md'), '# 插件\n\n[英文源页面](/plugin-development)\n\n### 6.7 主题\n\n### 6.8 视图\n')
    assert.deepEqual(verifyLocalePairs(root).missing, ['README.md'])

    fs.writeFileSync(path.join(root, 'zh-CN/spec/README.md'), '# 规格\n\n[英文源规格](/spec/README)\n')
    assert.deepEqual(verifyLocalePairs(root), {
      englishFiles: ['README.md', 'plugin-development.md'], missing: [], invalid: [],
    })

    fs.writeFileSync(path.join(root, 'zh-CN/spec/01-product/00-overview.md'), '# 概览\n')
    assert.deepEqual(verifyLocalePairs(root).invalid, ['01-product/00-overview.md'])

    fs.writeFileSync(path.join(root, 'zh-CN/spec/01-product/orphan.md'), '# 孤页\n\n[英文源规格](/spec/01-product/orphan)\n')
    assert.ok(verifyLocalePairs(root).invalid.includes('01-product/orphan.md'))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('the plugin development guide participates in locale checks', () => {
  assert.ok(verifyLocalePairs().englishFiles.includes('plugin-development.md'))
})

test('plugin guide checks reject missing mirrors and divergent theme examples', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-theme-docs-'))
  try {
    fs.mkdirSync(path.join(root, 'spec'))
    fs.mkdirSync(path.join(root, 'zh-CN/spec'), { recursive: true })
    fs.writeFileSync(path.join(root, 'spec/README.md'), '# Specs\n')
    fs.writeFileSync(path.join(root, 'zh-CN/spec/README.md'), '# 规格\n\n[英文源规格](/spec/README)\n')
    const english = '# Plugins\n\n### 6.7 Theme\n\n```json\n{"base":"dark"}\n```\n\n### 6.8 Views\n'
    const chinese = '# 插件\n\n[英文源页面](/plugin-development)\n\n### 6.7 主题\n\n```json\n{"base":"dark"}\n```\n\n### 6.8 视图\n'
    fs.writeFileSync(path.join(root, 'plugin-development.md'), english)
    const mirror = path.join(root, 'zh-CN/plugin-development.md')
    assert.deepEqual(verifyLocalePairs(root).missing, ['plugin-development.md'])
    fs.writeFileSync(mirror, chinese)
    assert.deepEqual(verifyLocalePairs(root).invalid, [])
    for (const broken of [
      chinese.replace('"dark"', '"light"'),
      chinese.replace('### 6.7 主题', '### 6.6 主题'),
      chinese.replace('/plugin-development', '/wrong-source'),
    ]) {
      fs.writeFileSync(mirror, broken)
      assert.deepEqual(verifyLocalePairs(root).invalid, ['plugin-development.md'])
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
