#!/usr/bin/env node
/**
 * Dependency-free style gate (no eslint/prettier binary is installed here).
 *
 * It only enforces rules the repo already follows, so it never blocks on
 * taste: CRLF, trailing whitespace, missing final newline, `debugger`,
 * `.only(` in tests, and `console.log` in plugin sources (they use ctx.logger).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const root = process.cwd()
const violations = []

function walk(dir, out = []) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const name of entries) {
    if (name === 'node_modules' || name === 'lib' || name === '.git') continue
    const path = join(dir, name)
    const info = statSync(path)
    if (info.isDirectory()) walk(path, out)
    else if (/\.(ts|mjs)$/.test(name)) out.push(relative(root, path))
  }
  return out
}

const files = [...walk('plugins'), ...walk('scripts'), ...walk('bench')]

for (const file of files) {
  const text = readFileSync(file, 'utf8')
  const lines = text.split('\n')
  if (text.includes('\r')) violations.push(`${file}: CRLF line endings`)
  if (!text.endsWith('\n') || text.endsWith('\n\n')) violations.push(`${file}: must end with exactly one newline`)
  lines.forEach((line, index) => {
    if (line.trimEnd() !== line) violations.push(`${file}:${index + 1}: trailing whitespace`)
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return
    // This file necessarily contains the patterns it looks for.
    if (file.endsWith('check-style.mjs')) return
    if (/\bdebugger\b/.test(line)) violations.push(`${file}:${index + 1}: debugger statement`)
    if (file.startsWith('plugins/') && file.includes('/src/') && /console\.log\(/.test(line)) {
      violations.push(`${file}:${index + 1}: console.log in plugin source (use ctx.logger)`)
    }
    if (/\.(only)\(/.test(line)) violations.push(`${file}:${index + 1}: focused test (.only)`)
  })
}

if (violations.length > 0) {
  for (const violation of violations) console.error(`style: ${violation}`)
  console.error(`\n${violations.length} style violation(s)`)
  process.exit(1)
}
console.log(`style ok (${files.length} files)`)
