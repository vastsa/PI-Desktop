#!/usr/bin/env node
/**
 * Whole-tree documentation check: every page under `docs/`, not just the
 * English/Chinese specification pairs that `check-locales.mjs` owns.
 *
 * Checks:
 *  1. Page structure for every markdown page: exactly one H1 (a VitePress
 *     `layout: home` page renders a hero instead), no leftover placeholder
 *     token, balanced code fences, and tables whose rows agree on their column
 *     count.
 *  2. ADR catalog (`docs/adr`): file naming, unique decision ids, the decision
 *     id in the H1 matching the file name, and the required sections. A record
 *     that predates a section is reported as a note, not a failure.
 *  3. ADR index (`docs/adr/README.md`): every record has exactly one row, every
 *     row resolves to a record, ids are unique, and a linked row points at the
 *     file that owns its id.
 *  4. ADR citations anywhere under `docs/`: `ADR 0249`, `ADR 0249 §5`,
 *     `ADRs 0062 / 0063`, and slug citations like `ADR session-content-search`
 *     must resolve to a record. Retired ids stay citable by design.
 *  5. Chinese pages: every page under `docs/zh-CN` must mirror an English page,
 *     so a translation never outlives the page it translates. `index.md` and
 *     `README.md` are the same page in both trees.
 *
 * Dead links are deliberately not re-implemented here: the VitePress build
 * fails on them for every page, and `docs-check.yml` runs that build right
 * after this script.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const docsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const ignoredDirectories = new Set(['node_modules', '.vitepress', 'dist', 'cache'])
const PLACEHOLDER = 'PIHOLDTOKEN'
const REQUIRED_ADR_SECTIONS = ['Context', 'Decision']
const OPTIONAL_ADR_SECTIONS = ['Consequences']
const INDEX_FILE = 'README.md'

/**
 * Decision ids that were deliberately retired, so citing one is legitimate even
 * though no record exists. `08-meta/decisions-log.md` states the rule:
 * "Both D366 and ADR 0199 stay retired; do not reuse them."
 */
const RETIRED_ADR_IDS = new Set(['0199'])

/**
 * A decision id is either the zero-padded number that leads a record file name
 * or a slug. Slug citations must contain a hyphen so ordinary prose ("the ADR
 * numbering", "an ADR policy") is never mistaken for a citation.
 */
const NUMBERED_ID = '\\d{4}'
const SLUG_ID = '[a-z0-9]+(?:-[a-z0-9]+)+'
/** A date like `2026-09-10` must never read as a decision number. */
const NUMBERED_CITATION = `${NUMBERED_ID}(?![-\\d])`
const CITATION = `(?:${NUMBERED_CITATION}|${SLUG_ID})`
/** A chain such as `ADR 0062 / 0063` or `ADR 0166 and 0189` only chains numbers. */
const CHAINED_CITATION = NUMBERED_CITATION

function markdownFiles(directory) {
  return fs.readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => path.relative(directory, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
    .filter((relativePath) => !relativePath.split('/').some((segment) => ignoredDirectories.has(segment)))
    .sort()
}

function read(relativePath, root = docsRoot) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8')
}

function firstMatch(source, pattern) {
  return pattern.exec(source)?.[1]
}

function heading(source, level) {
  return firstMatch(source, new RegExp(`^#{${level}}\\s+(.+?)\\s*$`, 'm'))
}

function topSection(source, title) {
  const start = new RegExp(`^##\\s+${title}\\s*$`, 'm').exec(source)
  if (!start) return null
  const rest = source.slice(start.index + start[0].length)
  const end = /^##\s+/m.exec(rest)
  return end ? rest.slice(0, end.index) : rest
}

/** A VitePress `layout: home` page renders a hero instead of a markdown H1. */
function isHomeLayout(source) {
  const frontmatter = /^---\n([\s\S]*?)\n---/.exec(source)?.[1]
  return Boolean(frontmatter && /^layout:\s*home\s*$/m.test(frontmatter))
}

/**
 * Walk every line outside a fenced code block. Fences carry shell and markdown
 * samples whose `#` lines and `|` rows are content, not document structure.
 */
function forEachProseLine(source, visit) {
  let fenced = false
  source.split('\n').forEach((line, index) => {
    if (/^ {0,3}(```|~~~)/.test(line)) {
      fenced = !fenced
      visit(null, index)
      return
    }
    if (fenced) {
      visit(null, index)
      return
    }
    visit(line, index)
  })
  return fenced
}

/** Strip inline code so a `|` inside backticks never counts as a table pipe. */
function tableColumns(line) {
  return line.replace(/`[^`]*`/g, '').replace(/\\\|/g, '').split('|').length - 2
}

export function verifyPageStructure(relativePaths, root = docsRoot) {
  const failures = []

  for (const relativePath of relativePaths) {
    const source = read(relativePath, root)
    const prose = []
    const unbalanced = forEachProseLine(source, (line) => prose.push(line))
    if (unbalanced) {
      failures.push(`${relativePath}: unbalanced code fence`)
    }

    const h1Count = prose.filter((line) => line !== null && /^#\s+\S/.test(line)).length
    if (h1Count !== 1 && !isHomeLayout(source)) {
      failures.push(`${relativePath}: expected exactly one H1, found ${h1Count}`)
    }

    if (source.includes(PLACEHOLDER)) {
      failures.push(`${relativePath}: contains the ${PLACEHOLDER} placeholder`)
    }

    let tableStart = 0
    let tableWidth = null
    prose.forEach((line, index) => {
      if (line === null || !line.trimStart().startsWith('|')) {
        tableWidth = null
        return
      }
      const columns = tableColumns(line.trim())
      if (tableWidth === null) {
        tableWidth = columns
        tableStart = index + 1
        return
      }
      if (columns !== tableWidth) {
        failures.push(
          `${relativePath}:${index + 1}: table started at line ${tableStart} has ${tableWidth} columns but this row has ${columns}`,
        )
      }
    })
  }

  return failures
}

export function adrIdFromFileName(fileName) {
  const numbered = new RegExp(`^(${NUMBERED_ID})-[a-z0-9]+(?:-[a-z0-9]+)*\\.md$`).exec(fileName)
  if (numbered) return numbered[1]
  const slug = new RegExp(`^(${SLUG_ID})\\.md$`).exec(fileName)
  return slug?.[1] ?? null
}

export function readAdrCatalog(adrRoot = path.join(docsRoot, 'adr')) {
  const records = new Map()
  const malformed = []

  for (const fileName of fs.readdirSync(adrRoot).sort()) {
    if (!fileName.endsWith('.md') || fileName === INDEX_FILE) continue
    const id = adrIdFromFileName(fileName)
    if (!id) {
      malformed.push(fileName)
      continue
    }
    const source = fs.readFileSync(path.join(adrRoot, fileName), 'utf8')
    records.set(fileName, { id, h1: heading(source, 1), source })
  }

  return { records, malformed }
}

export function verifyAdrCatalog({ records, malformed }) {
  const failures = []
  const notes = []
  const owners = new Map()

  for (const fileName of malformed) {
    failures.push(`adr/${fileName}: file name must be NNNN-slug.md or slug.md`)
  }

  for (const [fileName, { id, h1, source }] of records) {
    const existing = owners.get(id)
    if (existing) {
      failures.push(`adr/${fileName}: decision id ${id} is already owned by ${existing}`)
    } else {
      owners.set(id, fileName)
    }

    if (!h1) {
      failures.push(`adr/${fileName}: missing an H1`)
    } else if (!/^ADR\b/.test(h1)) {
      failures.push(`adr/${fileName}: H1 must start with "ADR", found ${JSON.stringify(h1)}`)
    } else if (new RegExp(`^(${NUMBERED_ID})$`).test(id) && firstMatch(h1, /^ADR\s+(\d{4})\b/) !== id) {
      failures.push(`adr/${fileName}: H1 does not declare ${id}`)
    }

    const hasStatus = /^#{2,3}\s+Status\b/m.test(source) || /^[-*]\s+\*{0,2}Status\*{0,2}\s*:/m.test(source)
    if (!hasStatus) failures.push(`adr/${fileName}: no Status heading or "Status:" line`)
    for (const title of REQUIRED_ADR_SECTIONS) {
      // A heading may qualify the word, as "## Original Decision" does.
      if (!new RegExp(`^#{2,3}\\s+.*\\b${title}\\b`, 'm').test(source)) {
        failures.push(`adr/${fileName}: missing the "${title}" section`)
      }
    }
    for (const title of OPTIONAL_ADR_SECTIONS) {
      if (!new RegExp(`^#{2,3}\\s+.*\\b${title}\\b`, 'm').test(source)) {
        notes.push(`adr/${fileName}: no "${title}" section, which adr/${INDEX_FILE} lists in the format`)
      }
    }
  }

  return { failures, notes }
}

export function readAdrIndex(indexPath = path.join(docsRoot, 'adr', INDEX_FILE)) {
  if (!fs.existsSync(indexPath)) return []

  const rows = []
  for (const line of (topSection(fs.readFileSync(indexPath, 'utf8'), 'Index') ?? '').split('\n')) {
    const match = /^\|\s*([^|]+?)\s*\|\s*(.+?)\s*\|\s*([^|]*?)\s*\|\s*$/.exec(line)
    if (!match) continue
    const [, rawId, title, status] = match
    if (/^[:\-\s]+$/.test(rawId) || /^id$/i.test(rawId)) continue
    rows.push({
      id: rawId.trim(),
      title: title.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').trim(),
      status: status.trim(),
      link: /\(([^)\s]+\.md)\)/.exec(title)?.[1]?.split('/').pop() ?? null,
    })
  }

  return rows
}

export function verifyAdrIndex(rows, records) {
  const failures = []
  const byId = new Map()
  for (const [fileName, { id }] of records) byId.set(id, fileName)

  const seen = new Map()
  for (const row of rows) {
    const fileName = byId.get(row.id)
    if (!fileName) {
      failures.push(`adr/${INDEX_FILE}: row ${row.id} has no ADR record`)
      continue
    }
    if (seen.has(row.id)) {
      failures.push(`adr/${INDEX_FILE}: ${row.id} is listed twice (${seen.get(row.id)} and ${fileName})`)
      continue
    }
    seen.set(row.id, fileName)

    if (!row.link) continue
    if (!records.has(row.link)) {
      failures.push(`adr/${INDEX_FILE}: ${row.id} links ${row.link}, which is not an ADR record`)
    } else if (records.get(row.link).id !== row.id) {
      failures.push(`adr/${INDEX_FILE}: ${row.id} links ${row.link}, whose decision id is ${records.get(row.link).id}`)
    }
  }

  for (const [fileName, { id }] of records) {
    if (!seen.has(id)) failures.push(`adr/${fileName}: missing from the adr/${INDEX_FILE} index`)
  }

  return failures
}

export function collectAdrCitations(relativePaths, root = docsRoot) {
  const citations = []
  // A citation never spans a line break and only chains numbers, so prose like
  // "ADR 0206, 2026-09-10" keeps its date out and "ADR 0062, decisions-log
  // D201" keeps the decision log out.
  const pattern = new RegExp(`\\bADRs?[- \\t]+(${CITATION})((?:[ \\t]*(?:/|,|、|and|与|及)[ \\t]*(${CHAINED_CITATION}))*)`, 'g')
  const trailing = new RegExp(`(?:^|[/,、]|and|与|及)[ \\t]*(${CHAINED_CITATION})`, 'g')

  for (const relativePath of relativePaths) {
    const source = read(relativePath, root)
    for (const match of source.matchAll(pattern)) {
      citations.push({ relativePath, id: match[1] })
      for (const extra of (match[2] ?? '').matchAll(trailing)) {
        citations.push({ relativePath, id: extra[1] })
      }
    }
  }

  return citations
}

export function verifyAdrCitations(citations, records) {
  const failures = []
  const ids = new Set(RETIRED_ADR_IDS)
  for (const { id } of records.values()) ids.add(id)

  const reported = new Set()
  for (const { relativePath, id } of citations) {
    const key = `${relativePath}:${id}`
    if (ids.has(id) || reported.has(key)) continue
    reported.add(key)
    failures.push(`${relativePath}: cites ADR ${id}, which no ADR record declares`)
  }

  return failures
}

/** `index.md` and `README.md` are the same page in VitePress. */
function pageKey(relativePath) {
  return relativePath.replace(/(^|\/)README\.md$/, '$1index.md')
}

export function verifyChineseMirrors(relativePaths) {
  const failures = []
  const english = new Set(
    relativePaths.filter((relativePath) => !relativePath.startsWith('zh-CN/')).map(pageKey),
  )

  for (const relativePath of relativePaths) {
    if (!relativePath.startsWith('zh-CN/')) continue
    const counterpart = pageKey(relativePath.slice('zh-CN/'.length))
    if (!english.has(counterpart)) {
      failures.push(`${relativePath}: no English page at docs/${counterpart}`)
    }
  }

  return failures
}

/**
 * `docs/spec` is the numbered domain tree and `docs/zh-CN/spec` mirrors it
 * path-for-path, so both must hold the same section directories.
 */
export function verifySpecTreeSymmetry(root = docsRoot) {
  const failures = []
  const sections = (localeRoot) => fs.readdirSync(path.join(root, localeRoot), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()

  const english = sections('spec')
  const chinese = sections('zh-CN/spec')

  for (const [localeRoot, names] of [['spec', english], ['zh-CN/spec', chinese]]) {
    for (const name of names) {
      if (!/^\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
        failures.push(`docs/${localeRoot}/${name}: a spec section directory must be numbered, like 01-product`)
      }
    }
  }
  for (const name of chinese.filter((entry) => !english.includes(entry))) {
    failures.push(`docs/zh-CN/spec/${name}: no English section directory at docs/spec/${name}`)
  }

  return failures
}

/**
 * `NAV.md` is the specification index for its own tree, so every page in that
 * tree must be listed. Dead NAV links are caught by the VitePress build.
 */
export function verifySpecIndex(localeRoot, root = docsRoot) {
  const failures = []
  const specRoot = path.join(root, localeRoot)
  const navPath = path.join(specRoot, 'NAV.md')
  if (!fs.existsSync(navPath)) return failures

  // The English tree links files relatively; the Chinese tree links routed
  // paths (`/zh-CN/spec/01-product/00-overview`), which resolve to a `.md` file
  // under this tree.
  const prefixes = [`/${localeRoot}/`, '/spec/']
  const listed = new Set()
  for (const match of fs.readFileSync(navPath, 'utf8').matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = match[1]
    if (target.endsWith('.md')) {
      listed.add(target.replace(/^\.\//, ''))
      continue
    }
    const prefix = prefixes.find((candidate) => target.startsWith(candidate))
    if (prefix) listed.add(`${target.slice(prefix.length)}.md`)
  }

  for (const relativePath of markdownFiles(specRoot)) {
    if (relativePath === 'NAV.md') continue
    if (!listed.has(relativePath)) failures.push(`docs/${localeRoot}/NAV.md: does not list ${relativePath}`)
  }

  return failures
}

export function verifyDocumentation() {
  const pages = markdownFiles(docsRoot)
  const { records, malformed } = readAdrCatalog()
  const catalog = verifyAdrCatalog({ records, malformed })

  return {
    pages,
    structure: verifyPageStructure(pages),
    adrCatalog: catalog.failures,
    adrNotes: catalog.notes,
    adrIndex: verifyAdrIndex(readAdrIndex(), records),
    adrCitations: verifyAdrCitations(collectAdrCitations(pages), records),
    mirrors: verifyChineseMirrors(pages),
    specTree: verifySpecTreeSymmetry(),
    specIndex: [...verifySpecIndex('spec'), ...verifySpecIndex('zh-CN/spec')],
  }
}

function main() {
  const result = verifyDocumentation()
  const groups = [
    ['Page structure', result.structure],
    ['ADR catalog', result.adrCatalog],
    ['ADR index', result.adrIndex],
    ['ADR citations', result.adrCitations],
    ['Chinese mirrors', result.mirrors],
    ['Spec tree', result.specTree],
    ['Spec index', result.specIndex],
  ]
  const failures = groups.flatMap(([, group]) => group)

  for (const [label, group] of groups) {
    if (!group.length) continue
    console.error(`\n${label}:`)
    for (const failure of group) console.error(`  - ${failure}`)
  }

  if (result.adrNotes.length) {
    console.log(`\nNotes (not failures):`)
    for (const note of result.adrNotes) console.log(`  - ${note}`)
  }

  if (failures.length) {
    console.error(`\n${failures.length} documentation problem(s) across ${result.pages.length} pages.`)
    process.exitCode = 1
    return
  }

  console.log(`Verified ${result.pages.length} documentation pages.`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
