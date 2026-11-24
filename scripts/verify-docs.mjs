#!/usr/bin/env node
/**
 * N2 docs drift gate (docs/20 §三 Slice BT).
 *
 * Deterministic checks only — no model, no network:
 *   1. relative Markdown links resolve;
 *   2. `DSH_WFXM_*` env vars mentioned in docs exist in code (or are allowlisted);
 *   3. `node scripts/*.mjs` and `pnpm <script>` commands exist;
 *   4. inline `plugins|scripts|docs|config|deploy|bench` file paths exist;
 *   5. docs/status.json is well-formed, evidence exists, and docs/09 §9.3 agrees
 *      (a `done` capability must not be listed as not done);
 *   6. every "N 套件" matches the registered suite count.
 *
 * Deliberately out of scope: volatile numbers (prod version, line counts, test
 * counts) and prose accuracy. Add a rule only when it has a single source.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const problems = []

/**
 * Vars documented ahead of their slice. Keep this list short and dated; a var
 * that ships must be removed from here so the code becomes the only source.
 */
const ENV_ALLOWLIST = new Set([
  // docs/20 §三 Slice CC (budget hard limits) — implemented in the CC slice.
  'DSH_WFXM_TASK_TOKEN_BUDGET',
  'DSH_WFXM_DAILY_TOKEN_BUDGET',
])

const PNPM_SKIP = new Set([
  'install', 'add', 'remove', 'update', 'up', 'exec', 'dlx', 'run', 'why',
  'licenses', 'sbom', 'link', 'unlink', 'pack', 'publish', 'store', 'prune',
])

/**
 * Early analysis docs quoting *other* repos (dsh / WFXM). Their links are
 * still checked; inline path/command claims are not, because a path like
 * `scripts/verify-application-entrypoints.ts` refers to another checkout.
 */
const HISTORICAL = new Set([
  'docs/01-决策背景与现状.md',
  'docs/03-渠道选型.md',
  'docs/04-WFXM-资产盘点.md',
])

/** Only current-status docs are held to the registered suite count. */
const CURRENT_DOCS = new Set(['README.md', 'docs/00-接续指南.md'])

function walk(dir, filter, out = []) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const name of entries) {
    if (name === 'node_modules' || name === '.git') continue
    // `lib/` is compiled output inside plugin packages; `scripts/lib/` is source.
    if (name === 'lib' && dir.startsWith(join(root, 'plugins'))) continue
    const path = join(dir, name)
    const info = statSync(path)
    if (info.isDirectory()) walk(path, filter, out)
    else if (filter(name)) out.push(path)
  }
  return out
}

function docFiles() {
  const docs = readdirSync(join(root, 'docs'))
    .filter((name) => name.endsWith('.md'))
    .map((name) => `docs/${name}`)
  return ['README.md', 'AGENTS.md', ...docs].map((file) => join(root, file))
}

const files = docFiles()

/** Code that may define env vars / commands. */
const codeText = [
  ...walk(join(root, 'plugins'), (name) => name.endsWith('.ts')),
  ...walk(join(root, 'scripts'), (name) => name.endsWith('.mjs')),
  ...walk(join(root, 'deploy'), () => true),
  ...walk(join(root, 'config'), () => true),
].map((path) => readFileSync(path, 'utf8')).join('\n')

const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const pnpmScripts = new Set(Object.keys(packageJson.scripts ?? {}))

const links = []
const envVars = new Map()
for (const file of files) {
  const rel = file.slice(root.length + 1)
  const lines = readFileSync(file, 'utf8').split('\n')
  let inFence = false
  lines.forEach((line, index) => {
    const at = `${rel}:${index + 1}`
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      return
    }
    for (const match of line.matchAll(/\bDSH_WFXM_[A-Z0-9_]+\b/g)) {
      if (!envVars.has(match[0])) envVars.set(match[0], at)
    }
    if (inFence) return
    for (const match of line.matchAll(/\[([^\]]*)\]\(([^)\s]+)\)/g)) {
      links.push({ at, rel, target: match[2], fromDoc: true })
    }
    for (const match of line.matchAll(/`([^`\n]+)`/g)) {
      const token = match[1].trim().replace(/[，。；、,.;:）)】]+$/, '')
      if (/[*<>{}]/.test(token)) continue
      if (!/^(plugins|scripts|docs|config|deploy|bench)\/[^\s`*<>]*/.test(token)) continue
      if (!/\.(ts|mjs|js|json|md|ya?ml|sql|html|sh)$/.test(token)) continue
      links.push({ at, rel, target: token.split('#')[0], fromDoc: false })
    }
  })
}

for (const { at, rel, target, fromDoc } of links) {
  if (!fromDoc && HISTORICAL.has(rel)) continue
  if (/^(https?:|mailto:|file:|#)/.test(target)) continue
  if (target.startsWith('<') || target.includes('{')) continue
  const path = target.split('#')[0]
  if (path === '') continue
  const base = fromDoc ? dirname(at.slice(0, at.lastIndexOf(':'))) : '.'
  if (!existsSync(resolve(root, base, path))) {
    problems.push(`${at}: ${fromDoc ? 'link target' : 'path'} does not exist: ${target}`)
  }
}

for (const [name, at] of envVars) {
  if (ENV_ALLOWLIST.has(name)) continue
  if (codeText.includes(name)) continue
  problems.push(`${at}: env var ${name} is not defined in code`)
}

for (const file of files) {
  const rel = file.slice(root.length + 1)
  const lines = readFileSync(file, 'utf8').split('\n')
  lines.forEach((line, index) => {
    for (const match of line.matchAll(/\bnode\s+(scripts\/[\w./-]+\.mjs)/g)) {
      if (!existsSync(join(root, match[1]))) {
        problems.push(`${rel}:${index + 1}: missing script ${match[1]}`)
      }
    }
    if (HISTORICAL.has(rel)) return
    for (const match of line.matchAll(/\bpnpm\s+([a-z][\w:-]*)/g)) {
      const name = match[1]
      if (PNPM_SKIP.has(name)) continue
      if (pnpmScripts.has(name)) continue
      problems.push(`${rel}:${index + 1}: unknown pnpm script "${name}"`)
    }
  })
}

const status = JSON.parse(readFileSync(join(root, 'docs/status.json'), 'utf8'))
const capById = new Map()
for (const cap of status.capabilities ?? []) {
  const label = `docs/status.json: ${cap.id}`
  if (!['done', 'partial', 'planned'].includes(cap.state)) {
    problems.push(`${label}: invalid state "${cap.state}"`)
  }
  if (!['done', 'v1', 'v2'].includes(cap.phase)) {
    problems.push(`${label}: invalid phase "${cap.phase}"`)
  }
  if (cap.state !== 'planned' && (cap.evidence ?? []).length === 0) {
    problems.push(`${label}: state "${cap.state}" needs at least one evidence path`)
  }
  for (const path of cap.evidence ?? []) {
    if (!existsSync(join(root, path))) problems.push(`${label}: evidence missing: ${path}`)
  }
  if (capById.has(cap.id)) problems.push(`${label}: duplicate id`)
  capById.set(cap.id, cap)
}

const nine = readFileSync(join(root, 'docs/09-能力对照与实现路径.md'), 'utf8').split('\n')
const start = nine.findIndex((line) => /^### 9\.3\b/.test(line))
if (start === -1) {
  problems.push('docs/09: missing §9.3 section')
} else {
  const listed = new Set()
  for (let index = start + 1; index < nine.length; index += 1) {
    const line = nine[index]
    if (/^##\s/.test(line) || /^---\s*$/.test(line)) break
    if (!/^\s*-\s/.test(line)) continue
    for (const match of line.matchAll(/(?<![A-Za-z0-9])([A-O]\d{1,2})(?![0-9])/g)) {
      listed.add(match[1])
    }
  }
  for (const id of listed) {
    if (!capById.has(id)) {
      problems.push(`docs/09 §9.3: ${id} has no docs/status.json entry`)
    }
  }
  for (const [id, cap] of capById) {
    if (!/^[A-O]\d{1,2}$/.test(id)) continue
    if (cap.state === 'done' && listed.has(id)) {
      problems.push(`docs/09 §9.3: ${id} is marked done but still listed as not done`)
    }
    if (cap.state !== 'done' && !listed.has(id)) {
      problems.push(`docs/09 §9.3: ${id} is ${cap.state} but missing from the list`)
    }
  }
}

const verifyAll = readFileSync(join(root, 'scripts/verify-all.mjs'), 'utf8')
const suitesBlock = verifyAll.slice(
  verifyAll.indexOf('const SUITES = ['),
  verifyAll.indexOf('\n]', verifyAll.indexOf('const SUITES = [')),
)
const suiteCount = (suitesBlock.match(/^\s*\{ name: /gm) ?? []).length
for (const file of files) {
  const rel = file.slice(root.length + 1)
  if (!CURRENT_DOCS.has(rel)) continue
  const text = readFileSync(file, 'utf8')
  for (const match of text.matchAll(/(\d+)\s*套件/g)) {
    if (Number(match[1]) === suiteCount) continue
    const before = text.slice(0, match.index)
    const line = before.split('\n').length
    problems.push(`${rel}:${line}: says ${match[1]} suites, verify-all registers ${suiteCount}`)
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.error(problem)
  console.error(`docs FAILED (${problems.length} problem${problems.length === 1 ? '' : 's'})`)
  process.exit(1)
}

console.log(
  `docs ok (${files.length} files, ${links.length} links/paths, `
  + `${envVars.size} env vars, ${suiteCount} suites)`,
)
