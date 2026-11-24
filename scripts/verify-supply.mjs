#!/usr/bin/env node
/**
 * M10 supply-chain gate (docs/20 §二 M10).
 *
 * Deterministic, offline, read-only. Direct dependencies only — the transitive
 * closure is covered by the lockfile integrity check in `pnpm install`.
 *
 *   1. workspace manifests: internal deps use `workspace:` and point at a real
 *      plugin; external deps use registry ranges (no file:/link:/git/http/npm
 *      aliases, no `*` / `latest`);
 *   2. provenance: every external dep is recorded in pnpm-lock.yaml;
 *   3. lockfile importers cover every package that declares dependencies;
 *   4. installed direct deps carry an allowlisted license (skipped, with a
 *      notice, when node_modules is absent).
 *
 * The lockfile is intentionally NOT rewritten here: docs/00 §3 forbids
 * `pnpm install` in this repo. Known pre-existing importer drift is baselined
 * below so new drift still fails.
 */

import assert from 'node:assert/strict'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const INTERNAL_PREFIX = '@dsh-wfxm/'
/** Protocols that bypass the registry or cannot be audited. */
const NON_REGISTRY = /^(file:|link:|portal:|git\+|git:|github:|https?:|npm:)/
/** `1.2.3`, `^1.2.3`, `~1.2.3`, `1.2.3-rc.1` — no wildcards, tags or open ranges. */
const PINNED = /^[~^]?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const LICENSE_ALLOWLIST = new Set([
  '0BSD', 'Apache-2.0', 'BlueOak-1.0.0', 'BSD-2-Clause', 'BSD-3-Clause',
  'CC0-1.0', 'ISC', 'MIT', 'Unlicense',
])

/**
 * Pre-existing lockfile drift (2026-11-24): these packages declared deps after
 * the last lockfile refresh. Regenerate the lockfile in an environment that
 * permits `pnpm install`, then delete the matching entry.
 */
const IMPORTER_BASELINE = new Set([
  'plugins/calendar',
  'plugins/changes',
  'plugins/mail',
  'plugins/reminder',
])

const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']

export function readManifest(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

export function loadWorkspace(root) {
  const packages = new Map()
  const rootManifest = readManifest(join(root, 'package.json'))
  packages.set('', { dir: '.', manifest: rootManifest })
  for (const name of readdirSync(join(root, 'plugins')).sort()) {
    const file = join(root, 'plugins', name, 'package.json')
    if (!existsSync(file)) continue
    const manifest = readManifest(file)
    packages.set(`plugins/${name}`, { dir: `plugins/${name}`, manifest })
  }
  return packages
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function depsOf(manifest) {
  const out = []
  for (const field of DEP_FIELDS) {
    for (const [name, spec] of Object.entries(manifest[field] ?? {})) out.push({ name, spec, field })
  }
  return out
}

function licenseOf(manifest) {
  if (typeof manifest.license === 'string') return manifest.license
  if (manifest.license && typeof manifest.license.type === 'string') return manifest.license.type
  return null
}

function licenseAllowed(expression) {
  const tokens = expression.replace(/[()]/g, ' ').split(/\s+(?:OR|AND)\s+|\s+/).filter(Boolean)
  return tokens.length > 0 && tokens.every((token) => LICENSE_ALLOWLIST.has(token))
}

function lockfileImporters(text) {
  const start = text.indexOf('\nimporters:')
  if (start === -1) return new Set()
  const end = text.indexOf('\npackages:', start)
  const block = end === -1 ? text.slice(start) : text.slice(start, end)
  const found = new Set()
  for (const match of block.matchAll(/^  ([a-z.][\w./@-]*):(?: \{\})?$/gm)) found.add(match[1])
  return found
}

function installedManifest(root, dir, name) {
  const bases = [
    join(root, dir, 'node_modules', name),
    join(root, 'node_modules', name),
  ]
  for (const base of bases) {
    if (!existsSync(base)) continue
    try {
      return readManifest(join(realpathSync(base), 'package.json'))
    } catch {
      continue
    }
  }
  return null
}

/**
 * @returns {{ findings: string[], advisories: string[], stats: Record<string, number> }}
 */
export function runChecks(root) {
  const findings = []
  const advisories = []
  const packages = loadWorkspace(root)
  const workspaceNames = new Map()
  for (const [dir, { manifest }] of packages) {
    if (!manifest.name) findings.push(`${dir || '.'}: package.json has no name`)
    else if (workspaceNames.has(manifest.name)) findings.push(`duplicate package name ${manifest.name}`)
    else workspaceNames.set(manifest.name, dir)
  }

  const external = new Map()
  let internalEdges = 0
  for (const [dir, { manifest }] of packages) {
    const label = dir || '.'
    for (const { name, spec, field } of depsOf(manifest)) {
      if (name.startsWith(INTERNAL_PREFIX)) {
        internalEdges++
        if (!spec.startsWith('workspace:')) {
          findings.push(`${label} ${field}: ${name} must use workspace: protocol, got "${spec}"`)
        } else if (!workspaceNames.has(name)) {
          findings.push(`${label} ${field}: ${name} is not an installed workspace package`)
        }
        continue
      }
      if (spec.startsWith('workspace:')) {
        findings.push(`${label} ${field}: ${name} is external but uses workspace: protocol`)
        continue
      }
      if (NON_REGISTRY.test(spec)) {
        findings.push(`${label} ${field}: ${name} uses non-registry protocol "${spec}"`)
        continue
      }
      if (!PINNED.test(spec)) {
        findings.push(`${label} ${field}: ${name} range "${spec}" is not pinned to a version range`)
      }
      const seen = external.get(name)
      if (!seen) external.set(name, { spec, dir })
      else if (seen.spec !== spec) {
        findings.push(`${name} declared with conflicting ranges "${seen.spec}" and "${spec}"`)
      }
    }
  }

  const lockPath = join(root, 'pnpm-lock.yaml')
  let lockText = null
  if (!existsSync(lockPath)) {
    findings.push('pnpm-lock.yaml is missing')
  } else {
    lockText = readFileSync(lockPath, 'utf8')
  }

  let provenanceOk = 0
  for (const name of external.keys()) {
    const encoded = name.replace('/', '+')
    const recorded = lockText !== null
      && (lockText.includes(`'${name}'`) || lockText.includes(`${encoded}@`))
    if (recorded) provenanceOk++
    else findings.push(`pnpm-lock.yaml has no record of external dependency ${name}`)
  }

  let importersCovered = 0
  const baselineHit = []
  if (lockText !== null) {
    const importers = lockfileImporters(lockText)
    for (const [dir, { manifest }] of packages) {
      if (dir === '') continue
      if (depsOf(manifest).length === 0) continue
      if (importers.has(dir)) {
        importersCovered++
        if (IMPORTER_BASELINE.has(dir)) advisories.push(`${dir}: baselined importer drift is fixed — drop it from IMPORTER_BASELINE`)
      } else if (IMPORTER_BASELINE.has(dir)) {
        baselineHit.push(dir)
        advisories.push(`${dir}: missing from pnpm-lock.yaml importers (known baseline, regenerate lockfile)`)
      } else {
        findings.push(`${dir}: declares dependencies but has no pnpm-lock.yaml importer entry`)
      }
    }
  }

  const installed = []
  const unchecked = []
  for (const [name, { spec, dir }] of external) {
    const manifest = installedManifest(root, dir, name)
    if (!manifest) {
      unchecked.push(name)
      continue
    }
    const license = licenseOf(manifest)
    if (!license) {
      findings.push(`${name}@${manifest.version} has no license field`)
    } else if (!licenseAllowed(license)) {
      findings.push(`${name}@${manifest.version} license "${license}" is not allowlisted (${spec})`)
    } else {
      installed.push(name)
    }
  }
  if (unchecked.length > 0) {
    advisories.push(`license check skipped for ${unchecked.length} dep(s) not installed: ${unchecked.join(', ')}`)
  }

  return {
    findings,
    advisories,
    stats: {
      packages: packages.size,
      internalEdges,
      external: external.size,
      provenance: provenanceOk,
      importers: importersCovered,
      baseline: baselineHit.length,
      licensed: installed.length,
      unchecked: unchecked.length,
    },
  }
}

function fixtureRoot(files) {
  const root = mkdtempSync(join(tmpdir(), 'supply-'))
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, typeof content === 'string' ? content : JSON.stringify(content, null, 2))
  }
  return root
}

const LOCK = [
  "lockfileVersion: '9.0'",
  '',
  'importers:',
  '',
  '  .: {}',
  '',
  '  plugins/a:',
  '    dependencies:',
  "      'left-pad':",
  '        specifier: 1.3.0',
  '        version: 1.3.0',
  '',
  'packages:',
  '',
  '  left-pad@1.3.0:',
  '    resolution: {integrity: sha512-x}',
  '',
].join('\n')

function cleanFixture(extra = {}) {
  return {
    'package.json': { name: 'root', private: true },
    'plugins/a/package.json': {
      name: '@dsh-wfxm/a',
      dependencies: { 'left-pad': '1.3.0' },
      devDependencies: { '@dsh-wfxm/b': 'workspace:*' },
    },
    'plugins/b/package.json': { name: '@dsh-wfxm/b' },
    'plugins/a/node_modules/left-pad/package.json': { name: 'left-pad', version: '1.3.0', license: 'MIT' },
    'pnpm-lock.yaml': LOCK,
    ...extra,
  }
}

const cases = []
function check(name, fn) {
  cases.push({ name, fn })
}

check('clean workspace passes', () => {
  const root = fixtureRoot(cleanFixture())
  try {
    const { findings, advisories } = runChecks(root)
    assert.deepEqual(findings, [])
    assert.deepEqual(advisories, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

check('non-registry protocol is rejected', () => {
  const root = fixtureRoot(cleanFixture({
    'plugins/a/package.json': {
      name: '@dsh-wfxm/a',
      dependencies: { 'left-pad': 'file:../left-pad' },
    },
  }))
  try {
    const { findings } = runChecks(root)
    assert.ok(findings.some((item) => item.includes('non-registry protocol')), JSON.stringify(findings))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

check('floating range is rejected', () => {
  const root = fixtureRoot(cleanFixture({
    'plugins/a/package.json': {
      name: '@dsh-wfxm/a',
      dependencies: { 'left-pad': '*' },
    },
  }))
  try {
    const { findings } = runChecks(root)
    assert.ok(findings.some((item) => item.includes('not pinned')), JSON.stringify(findings))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

check('internal dep must use workspace: and exist', () => {
  const root = fixtureRoot(cleanFixture({
    'plugins/a/package.json': {
      name: '@dsh-wfxm/a',
      dependencies: { '@dsh-wfxm/b': '^1.0.0', '@dsh-wfxm/ghost': 'workspace:*' },
    },
  }))
  try {
    const { findings } = runChecks(root)
    assert.ok(findings.some((item) => item.includes('must use workspace:')), JSON.stringify(findings))
    assert.ok(findings.some((item) => item.includes('not an installed workspace package')), JSON.stringify(findings))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

check('dependency missing from lockfile is rejected', () => {
  const root = fixtureRoot(cleanFixture({
    'plugins/a/package.json': { name: '@dsh-wfxm/a', dependencies: { 'left-pad': '1.3.0', 'no-such-pkg': '1.0.0' } },
    'plugins/a/node_modules/no-such-pkg/package.json': { name: 'no-such-pkg', version: '1.0.0', license: 'MIT' },
  }))
  try {
    const { findings } = runChecks(root)
    assert.ok(findings.some((item) => item.includes('no record of external dependency no-such-pkg')), JSON.stringify(findings))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

check('non-allowlisted license is rejected', () => {
  const root = fixtureRoot(cleanFixture({
    'plugins/a/node_modules/left-pad/package.json': { name: 'left-pad', version: '1.3.0', license: 'GPL-3.0-only' },
  }))
  try {
    const { findings } = runChecks(root)
    assert.ok(findings.some((item) => item.includes('not allowlisted')), JSON.stringify(findings))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

check('unbaselined missing importer fails, baselined one only advises', () => {
  const root = fixtureRoot(cleanFixture({
    'plugins/c/package.json': { name: '@dsh-wfxm/c', dependencies: { 'left-pad': '1.3.0' } },
    'plugins/c/node_modules/left-pad/package.json': { name: 'left-pad', version: '1.3.0', license: 'MIT' },
    'plugins/calendar/package.json': { name: '@dsh-wfxm/calendar', dependencies: { 'left-pad': '1.3.0' } },
    'plugins/calendar/node_modules/left-pad/package.json': { name: 'left-pad', version: '1.3.0', license: 'MIT' },
  }))
  try {
    const { findings, advisories } = runChecks(root)
    assert.ok(findings.some((item) => item.includes('plugins/c: declares dependencies')), JSON.stringify(findings))
    assert.ok(!findings.some((item) => item.includes('plugins/calendar: declares')), JSON.stringify(findings))
    assert.ok(advisories.some((item) => item.includes('plugins/calendar: missing from pnpm-lock.yaml')), JSON.stringify(advisories))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let failed = 0
for (const { name, fn } of cases) {
  try {
    fn()
    console.log(`PASS  ${name}`)
  } catch (error) {
    failed++
    console.log(`FAIL  ${name} — ${error instanceof Error ? error.message : String(error)}`)
  }
}

const { findings, advisories, stats } = runChecks(root)
for (const advisory of advisories) console.log(`ADVISORY  ${advisory}`)
for (const finding of findings) console.log(`FAIL  ${finding}`)

if (failed > 0 || findings.length > 0) {
  console.error(`supply FAILED (${failed + findings.length} problem${failed + findings.length === 1 ? '' : 's'})`)
  process.exit(1)
}

console.log(
  `supply ok (${stats.packages} packages, ${stats.internalEdges} internal edges, `
  + `${stats.external} external deps, ${stats.licensed} licenses checked, `
  + `${stats.importers} importers, ${stats.baseline} baseline drift)`,
)
