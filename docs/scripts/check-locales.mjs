import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const docsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function markdownFiles(directory) {
  return fs.readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => path.relative(directory, path.join(entry.parentPath, entry.name)))
    .sort()
}

/**
 * Route the Chinese notice must link, built from a path relative to `docs/spec`.
 * Routed links are POSIX, but `path.relative` separates with backslashes on
 * Windows, so normalize the separators before assembling the route.
 */
export function noticeRoute(relativePath) {
  return `/spec/${relativePath.split(path.sep).join('/').replace(/\.md$/, '')}`
}

function tableShape(source) {
  return source.split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('|') && line.endsWith('|'))
    .map((line) => [...line].filter((character) => character === '|').length)
}

function themeSection(source) {
  return source.split(/^### 6\.7[^\n]*$/m)[1]?.split(/^### /m)[0]
}

/**
 * Chinese specification pages that must exist. Every other English page is
 * read in English; a Chinese companion is optional, but one that exists must
 * still mirror an English page and carry a valid source notice (ADR
 * chinese-docs-entry-points-only).
 */
export const REQUIRED_SPEC_MIRRORS = ['README.md']

export function verifyLocalePairs(root = docsRoot) {
  const englishRoot = path.join(root, 'spec')
  const chineseRoot = path.join(root, 'zh-CN/spec')
  const chineseFiles = fs.existsSync(chineseRoot) ? markdownFiles(chineseRoot) : []
  const englishFiles = [...new Set([...REQUIRED_SPEC_MIRRORS, ...chineseFiles])].sort()
  const missing = []
  const invalid = []

  for (const relativePath of englishFiles) {
    const translatedPath = path.join(chineseRoot, relativePath)
    const englishPath = path.join(englishRoot, relativePath)
    if (!fs.existsSync(translatedPath)) {
      missing.push(relativePath)
      continue
    }
    if (!fs.existsSync(englishPath)) {
      invalid.push(relativePath)
      continue
    }

    const source = fs.readFileSync(translatedPath, 'utf8')
    const englishSource = fs.readFileSync(englishPath, 'utf8')
    const englishRoute = noticeRoute(relativePath)
    const tableStructureMatches = JSON.stringify(tableShape(source)) === JSON.stringify(tableShape(englishSource))
    const fenceStructureMatches = (source.match(/^```/gm) ?? []).length === (englishSource.match(/^```/gm) ?? []).length
    if (
      !/^#\s+\S+/m.test(source)
      || !/[\u3400-\u9fff]/.test(source)
      || !source.includes(`[英文源规格](${englishRoute})`)
      || source.includes('PIHOLDTOKEN')
      || !tableStructureMatches
      || !fenceStructureMatches
    ) {
      invalid.push(relativePath)
    }
  }

  // The standalone guide is not in spec/. Its theme contract must preserve
  // literal JSON/CSS examples, not merely the number of code fences. Other
  // guide sections are outside this theme-contract check.
  const guide = 'plugin-development.md'
  englishFiles.push(guide)
  const mirror = path.join(root, 'zh-CN', guide)
  if (!fs.existsSync(mirror)) {
    missing.push(guide)
  } else {
    const source = fs.readFileSync(mirror, 'utf8')
    const englishTheme = themeSection(fs.readFileSync(path.join(root, guide), 'utf8'))
    const chineseTheme = themeSection(source)
    const snippets = (section) => section.match(/^```[^\n]*\n[\s\S]*?^```/gm) ?? []
    if (!/^#\s+\S+/m.test(source) || !/[\u3400-\u9fff]/.test(source)
      || !source.includes('[英文源页面](/plugin-development)') || source.includes('PIHOLDTOKEN')
      || !englishTheme || !chineseTheme
      || JSON.stringify(snippets(englishTheme)) !== JSON.stringify(snippets(chineseTheme))
      || JSON.stringify(tableShape(englishTheme)) !== JSON.stringify(tableShape(chineseTheme))) {
      invalid.push(guide)
    }
  }

  return { englishFiles, missing, invalid }
}

function main() {
  const { englishFiles, missing, invalid } = verifyLocalePairs()

  if (missing.length || invalid.length) {
    if (missing.length) console.error(`Missing required Chinese pages:\n${missing.join('\n')}`)
    if (invalid.length) console.error(`Invalid Chinese pages (no English source, bad notice, or diverging structure):\n${invalid.join('\n')}`)
    process.exitCode = 1
  } else {
    console.log(`Verified ${englishFiles.length} English/Chinese documentation pairs.`)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
