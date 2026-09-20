import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import {
  adrIdFromFileName,
  collectAdrCitations,
  readAdrCatalog,
  readAdrIndex,
  verifyAdrCatalog,
  verifyAdrCitations,
  verifyAdrIndex,
  verifyChineseMirrors,
  verifyDocumentation,
  verifyPageStructure,
  verifySpecIndex,
  verifySpecTreeSymmetry,
} from './check-docs.mjs'

/** Build a throwaway `docs/` tree from a `{ relativePath: source }` map. */
function fixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-docs-check-'))
  for (const [relativePath, source] of Object.entries(files)) {
    const target = path.join(root, relativePath)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, source)
  }
  return root
}

const catalog = (records) => new Map(Object.entries(records).map(([fileName, entry]) => [
  fileName,
  typeof entry === 'string'
    ? { id: adrIdFromFileName(fileName), h1: entry, source: `# ${entry}\n\n- Status: Accepted\n\n## Context\nx\n\n## Decision\nx\n\n## Consequences\nx\n` }
    : entry,
]))

test('decision ids come from the file name only', () => {
  assert.equal(adrIdFromFileName('0249-chatgpt-style-logical-project-groups.md'), '0249')
  assert.equal(adrIdFromFileName('session-content-search.md'), 'session-content-search')
  assert.equal(adrIdFromFileName('0249_legacy_name.md'), null)
  assert.equal(adrIdFromFileName('README.md'), null)
})

test('page structure ignores markdown inside fences', () => {
  const root = fixture({
    'ok.md': '# Title\n\n```bash\n# a shell comment\n```\n',
    'two-h1.md': '# One\n\n# Two\n',
    'broken-table.md': '# Title\n\n| a | b |\n|---|---|\n| 1 | 2 | 3 |\n',
    'unbalanced.md': '# Title\n\n```text\nno closing fence\n',
    'home.md': '---\nlayout: home\n---\n\nhero only\n',
  })

  assert.deepEqual(verifyPageStructure(['ok.md'], root), [])
  assert.deepEqual(verifyPageStructure(['home.md'], root), [])
  assert.match(verifyPageStructure(['two-h1.md'], root).join('\n'), /expected exactly one H1/)
  assert.match(verifyPageStructure(['broken-table.md'], root).join('\n'), /has 2 columns but this row has 3/)
  assert.match(verifyPageStructure(['unbalanced.md'], root).join('\n'), /unbalanced code fence/)
})

test('a decision id cannot be owned twice, and the H1 must declare it', () => {
  const duplicated = verifyAdrCatalog({
    records: catalog({
      '0249-chatgpt-style-logical-project-groups.md': 'ADR 0249: Logical project groups',
      '0249-plugin-runtime-theme-apis.md': 'ADR 0249 — Plugin runtime theme APIs',
    }),
    malformed: [],
  }).failures

  assert.equal(duplicated.length, 1)
  assert.match(duplicated[0], /decision id 0249 is already owned by 0249-chatgpt-style-logical-project-groups\.md/)

  const mismatched = verifyAdrCatalog({
    records: catalog({ '0251-chat-file-refs.md': 'ADR 0252: Chat file references' }),
    malformed: [],
  }).failures

  assert.match(mismatched.join('\n'), /H1 does not declare 0251/)

  const unprefixed = verifyAdrCatalog({
    records: catalog({ '0255-plugin-appearance-extensions.md': '0255 — Plugin Appearance Extensions' }),
    malformed: [],
  }).failures

  assert.match(unprefixed.join('\n'), /H1 must start with "ADR"/)
})

test('a qualified heading still counts as the required section', () => {
  const { failures } = verifyAdrCatalog({
    records: catalog({
      '0003-agent-in-main-process.md': {
        id: '0003',
        h1: 'ADR 0003: Agent in the main process',
        source: '# ADR 0003: Agent in the main process\n\n- Status: Superseded\n\n## Context\nx\n\n## Original Decision\nx\n\n## Consequences\nx\n',
      },
    }),
    malformed: [],
  })

  assert.deepEqual(failures, [])
})

test('every record needs one index row, and a row must own its link', () => {
  const records = catalog({
    '0001-use-electron.md': 'ADR 0001: Use Electron',
    '0002-use-pi.md': 'ADR 0002: Use pi',
  })

  assert.deepEqual(verifyAdrIndex([
    { id: '0001', title: 'Use Electron', status: 'Accepted', link: '0001-use-electron.md' },
  ], records).join('\n'), 'adr/0002-use-pi.md: missing from the adr/README.md index')

  assert.match(verifyAdrIndex([
    { id: '0001', title: 'a', status: 'Accepted', link: null },
    { id: '0001', title: 'b', status: 'Accepted', link: null },
  ], records).join('\n'), /0001 is listed twice/)

  assert.match(verifyAdrIndex([
    { id: '0001', title: 'a', status: 'Accepted', link: '0002-use-pi.md' },
  ], records).join('\n'), /0001 links 0002-use-pi\.md, whose decision id is 0002/)
})

test('citations resolve, and prose beside a citation is not read as one', () => {
  const records = catalog({
    '0206-ten-provider-retries.md': 'ADR 0206: Ten provider retries',
    '0062-bounded-subagents.md': 'ADR 0062: Bounded subagents',
    '0063-subagent-ui.md': 'ADR 0063: Subagent UI',
  })
  const root = fixture({
    'spec/ok.md': 'See ADR 0206 and ADR 0062 / 0063.\n',
    'spec/date.md': 'Decision D378 (ADR 0206, 2026-09-10) raised both budgets.\n',
    'spec/log.md': 'See ADR 0062, decisions-log D201 for the detail.\n',
    'spec/retired.md': 'Both D366 and ADR 0199 stay retired; do not reuse them.\n',
    'spec/dangling.md': 'See ADR 0249 for the rule.\n',
  })

  const citations = collectAdrCitations([
    'spec/ok.md', 'spec/date.md', 'spec/log.md', 'spec/retired.md', 'spec/dangling.md',
  ], root)

  assert.deepEqual(citations, [
    { relativePath: 'spec/ok.md', id: '0206' },
    { relativePath: 'spec/ok.md', id: '0062' },
    { relativePath: 'spec/ok.md', id: '0063' },
    { relativePath: 'spec/date.md', id: '0206' },
    { relativePath: 'spec/log.md', id: '0062' },
    { relativePath: 'spec/retired.md', id: '0199' },
    { relativePath: 'spec/dangling.md', id: '0249' },
  ])
  assert.deepEqual(verifyAdrCitations(citations, records), [
    'spec/dangling.md: cites ADR 0249, which no ADR record declares',
  ])
})

test('a Chinese page must mirror an English page, where README and index are one page', () => {
  assert.deepEqual(
    verifyChineseMirrors(['guide/index.md', 'zh-CN/guide/index.md', 'adr/README.md', 'zh-CN/adr/index.md']),
    [],
  )
  assert.deepEqual(
    verifyChineseMirrors(['zh-CN/spec/product/index.md']),
    ['zh-CN/spec/product/index.md: no English page at docs/spec/product/index.md'],
  )
})

test('both spec trees carry the same numbered sections, and NAV lists every page', () => {
  const root = fixture({
    'spec/NAV.md': '# NAV\n\n- [README.md](README.md)\n- [00-baseline.md](00-baseline.md)\n- [01-product/00-overview.md](01-product/00-overview.md)\n',
    'spec/README.md': '# Spec\n',
    'spec/00-baseline.md': '# Baseline\n',
    'spec/01-product/00-overview.md': '# Overview\n',
    'spec/legacy/index.md': '# Legacy\n',
    'zh-CN/spec/NAV.md': '# 导航\n\n- [README.md](/zh-CN/spec/README)\n',
    'zh-CN/spec/README.md': '# 规格\n',
    'zh-CN/spec/legacy/index.md': '# 遗留\n',
  })

  assert.deepEqual(verifySpecTreeSymmetry(root), [
    'docs/spec/legacy: a spec section directory must be numbered, like 01-product',
    'docs/zh-CN/spec/legacy: a spec section directory must be numbered, like 01-product',
  ])
  assert.deepEqual(verifySpecIndex('spec', root), [
    'docs/spec/NAV.md: does not list legacy/index.md',
  ])
  assert.deepEqual(verifySpecIndex('zh-CN/spec', root), [
    'docs/zh-CN/spec/NAV.md: does not list legacy/index.md',
  ])
})

test('the documentation tree in this repository is clean', () => {
  const result = verifyDocumentation()

  assert.ok(result.pages.length > 400, 'expected to discover the documentation tree')
  assert.deepEqual(result.structure, [], 'page structure failures')
  assert.deepEqual(result.adrCatalog, [], 'ADR catalog failures')
  assert.deepEqual(result.adrIndex, [], 'ADR index failures')
  assert.deepEqual(result.adrCitations, [], 'ADR citation failures')
  assert.deepEqual(result.mirrors, [], 'Chinese mirror failures')
  assert.deepEqual(result.specTree, [], 'spec tree failures')
  assert.deepEqual(result.specIndex, [], 'spec index failures')
})
