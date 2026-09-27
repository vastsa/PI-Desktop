import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const docsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const englishRoot = path.join(docsRoot, 'spec')
const chineseRoot = path.join(docsRoot, 'zh-CN/spec')

function markdownFiles(directory) {
  return fs.readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => path.relative(directory, path.join(entry.parentPath, entry.name)))
    .sort()
}

const englishFiles = markdownFiles(englishRoot)
const missing = []
const invalid = []

function tableShape(source) {
  return source.split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('|') && line.endsWith('|'))
    .map((line) => [...line].filter((character) => character === '|').length)
}

for (const relativePath of englishFiles) {
  const translatedPath = path.join(chineseRoot, relativePath)
  if (!fs.existsSync(translatedPath)) {
    missing.push(relativePath)
    continue
  }

  const source = fs.readFileSync(translatedPath, 'utf8')
  const englishSource = fs.readFileSync(path.join(englishRoot, relativePath), 'utf8')
  const englishRoute = `/spec/${relativePath.replace(/\.md$/, '')}`
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

if (missing.length || invalid.length) {
  if (missing.length) console.error(`Missing Chinese specifications:\n${missing.join('\n')}`)
  if (invalid.length) console.error(`Invalid Chinese source notices:\n${invalid.join('\n')}`)
  process.exitCode = 1
} else {
  console.log(`Verified ${englishFiles.length} English/Chinese specification pairs.`)
}
