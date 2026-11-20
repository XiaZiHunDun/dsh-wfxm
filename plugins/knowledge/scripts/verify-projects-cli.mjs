/**
 * Slice W acceptance: `scripts/projects.mjs` (project registry CLI).
 *
 * Runs the real entry point as a subprocess against a throwaway ops.sqlite and
 * throwaway git repos; nothing here touches production data or the worktree switch.
 */

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import DatabaseConstructor from 'better-sqlite3'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const cliPath = join(repoRoot, 'scripts/projects.mjs')

let pass = 0
let fail = 0
async function check(name, fn) {
  try {
    const ok = await fn()
    if (ok) {
      pass++
      console.log(`PASS  ${name}`)
    } else {
      fail++
      console.log(`FAIL  ${name}`)
    }
  } catch (error) {
    fail++
    console.log(`FAIL  ${name} — ${error instanceof Error ? error.message : String(error)}`)
  }
}

const dir = mkdtempSync(join(tmpdir(), 'projects-cli-'))
const dbPath = join(dir, 'ops.sqlite')

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=verify', '-c', 'user.email=verify@example.com', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function makeGitRepo(name, withRemote = false) {
  const root = join(dir, name)
  mkdirSync(root, { recursive: true })
  git(root, 'init')
  writeFileSync(join(root, 'README.md'), '# temp\n')
  git(root, 'add', 'README.md')
  git(root, 'commit', '-m', 'init')
  if (withRemote) git(root, 'remote', 'add', 'origin', 'https://example.invalid/repo.git')
  return root
}

const gitRepo = makeGitRepo('repo-a')
const plainDir = join(dir, 'plain')
mkdirSync(plainDir)
const plainDir2 = join(dir, 'plain-2')
mkdirSync(plainDir2)
const otherGitRepo = makeGitRepo('repo-b', true)
const thirdGitRepo = makeGitRepo('repo-c', true)
const bareGitRepo = makeGitRepo('repo-d')
const detectRepo = makeGitRepo('repo-detect')
writeFileSync(join(detectRepo, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
writeFileSync(join(detectRepo, 'package-lock.json'), '{}\n')
writeFileSync(join(detectRepo, 'AGENTS.md'), '# rules\n')
const npmRepo = makeGitRepo('repo-npm')
writeFileSync(join(npmRepo, 'package-lock.json'), '{}\n')
const explicitRepo = makeGitRepo('repo-explicit')
const missingRoot = join(dir, 'missing')
const filePath = join(dir, 'a-file')
writeFileSync(filePath, 'not a directory\n')

function run(args, env = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: 'utf8',
    env: { ...process.env, DSH_WFXM_DB: dbPath, ...env },
  })
}

function listJson(args = []) {
  const result = run(['list', '--json', ...args])
  assert.equal(result.status, 0, `list failed: ${result.stderr}`)
  return JSON.parse(result.stdout)
}

function byName(name) {
  return listJson().find((project) => project.name === name) ?? null
}

await check('add a git repo → vcs=git, merge_mode=manual, absolute root', () => {
  const result = run([
    'add', '--name', 'alpha', '--root', gitRepo, '--prepare-cmd', 'pnpm install',
  ])
  assert.equal(result.status, 0, result.stderr)
  const project = byName('alpha')
  assert.ok(project !== null)
  assert.equal(project.vcs, 'git')
  assert.equal(project.mergeMode, 'manual')
  assert.equal(project.prepareCmd, 'pnpm install')
  assert.equal(project.worktreeRoot, null)
  assert.equal(project.rootPath, gitRepo)
  return true
})

await check('add a non-git dir → vcs=none; explicit --vcs git rejected', () => {
  const result = run(['add', '--name', 'plain', '--root', plainDir])
  assert.equal(result.status, 0, result.stderr)
  assert.equal(byName('plain').vcs, 'none')

  const rejected = run(['add', '--name', 'fake-git', '--root', plainDir2, '--vcs', 'git'])
  assert.equal(rejected.status, 1)
  assert.match(rejected.stderr, /no \.git/)
  assert.ok(byName('fake-git') === null)
  return true
})

await check('missing root / file root rejected without writing', () => {
  const before = listJson().length
  const missing = run(['add', '--name', 'nope', '--root', missingRoot])
  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /does not exist/)

  const file = run(['add', '--name', 'file-root', '--root', filePath])
  assert.equal(file.status, 1)
  assert.match(file.stderr, /not a directory/)

  assert.equal(listJson().length, before)
  return true
})

await check('worktree_root outside root rejected; inside accepted', () => {
  const outside = run([
    'add', '--name', 'escape', '--root', otherGitRepo, '--worktree-root', join(dir, 'outside'),
  ])
  assert.equal(outside.status, 1)
  assert.match(outside.stderr, /inside --root/)
  assert.ok(byName('escape') === null)

  const inside = run([
    'add', '--name', 'beta', '--root', otherGitRepo, '--worktree-root', '.agents/wt',
  ])
  assert.equal(inside.status, 0, inside.stderr)
  assert.equal(byName('beta').worktreeRoot, join(otherGitRepo, '.agents/wt'))
  return true
})

await check('duplicate name / duplicate root rejected, existing row untouched', () => {
  const duplicateName = run(['add', '--name', 'alpha', '--root', plainDir])
  assert.equal(duplicateName.status, 1)
  assert.match(duplicateName.stderr, /name already registered/)

  const duplicateRoot = run(['add', '--name', 'alpha-2', '--root', gitRepo])
  assert.equal(duplicateRoot.status, 1)
  assert.match(duplicateRoot.stderr, /root already registered/)
  assert.ok(byName('alpha-2') === null)

  const alpha = byName('alpha')
  assert.equal(alpha.rootPath, gitRepo)
  assert.equal(alpha.prepareCmd, 'pnpm install')
  return true
})

await check('update changes fields; empty value clears prepare and worktree_root', () => {
  const updated = run(['update', 'alpha', '--prepare-cmd', 'pnpm run build', '--worktree-root', 'wt'])
  assert.equal(updated.status, 0, updated.stderr)
  let alpha = byName('alpha')
  assert.equal(alpha.prepareCmd, 'pnpm run build')
  assert.equal(alpha.worktreeRoot, join(gitRepo, 'wt'))

  const cleared = run(['update', 'alpha', '--prepare-cmd', '', '--worktree-root', ''])
  assert.equal(cleared.status, 0, cleared.stderr)
  alpha = byName('alpha')
  assert.equal(alpha.prepareCmd, null)
  assert.equal(alpha.worktreeRoot, null)
  assert.equal(alpha.mergeMode, 'manual')
  return true
})

await check('remove archives (hidden by default, visible with --all, idempotent)', () => {
  const removed = run(['remove', 'plain'])
  assert.equal(removed.status, 0, removed.stderr)
  assert.ok(byName('plain') === null)
  assert.ok(listJson(['--all']).some((project) => project.name === 'plain' && project.archivedAt !== null))

  const again = run(['remove', 'plain'])
  assert.equal(again.status, 0)
  assert.match(again.stdout, /already archived/)
  return true
})

await check('--merge-mode pr needs a configured remote', () => {
  const rejected = run(['add', '--name', 'gamma', '--root', bareGitRepo, '--merge-mode', 'pr'])
  assert.equal(rejected.status, 1)
  assert.match(rejected.stderr, /configured git remote/)
  assert.ok(byName('gamma') === null)

  const accepted = run(['add', '--name', 'delta', '--root', thirdGitRepo, '--merge-mode', 'pr'])
  assert.equal(accepted.status, 0, accepted.stderr)
  assert.equal(byName('delta').mergeMode, 'pr')
  return true
})

await check('unknown command / missing arguments exit 1', () => {
  const unknown = run(['frobnicate'])
  assert.equal(unknown.status, 1)
  assert.match(unknown.stderr, /unknown command/)

  const noRoot = run(['add', '--name', 'incomplete'])
  assert.equal(noRoot.status, 1)
  assert.match(noRoot.stderr, /--root/)
  return true
})

await check('B2: add auto-detects prepareCmd (pnpm > npm) and rulesDoc (AGENTS > README)', () => {
  const detected = run(['add', '--name', 'auto', '--root', detectRepo])
  assert.equal(detected.status, 0, detected.stderr)
  const project = byName('auto')
  assert.equal(project.prepareCmd, 'pnpm install --frozen-lockfile')
  assert.equal(project.rulesDoc, 'AGENTS.md')

  const npm = run(['add', '--name', 'npm-auto', '--root', npmRepo])
  assert.equal(npm.status, 0, npm.stderr)
  assert.equal(byName('npm-auto').prepareCmd, 'npm ci')
  assert.equal(byName('npm-auto').rulesDoc, 'README.md')
  return true
})

await check('B2: explicit --prepare-cmd/--rules-doc override detection; empty clears', () => {
  const explicit = run([
    'add', '--name', 'explicit', '--root', explicitRepo,
    '--prepare-cmd', 'make build', '--rules-doc', 'README.md',
  ])
  assert.equal(explicit.status, 0, explicit.stderr)
  assert.equal(byName('explicit').prepareCmd, 'make build')
  assert.equal(byName('explicit').rulesDoc, 'README.md')

  const cleared = run(['update', 'explicit', '--prepare-cmd', '', '--rules-doc', ''])
  assert.equal(cleared.status, 0, cleared.stderr)
  assert.equal(byName('explicit').prepareCmd, null)
  assert.equal(byName('explicit').rulesDoc, null)
  return true
})

await check('B2: an explicit rulesDoc must be an existing file inside the root', () => {
  const missing = run(['update', 'explicit', '--rules-doc', 'missing.md'])
  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /does not exist or is not a file/)

  const escape = run(['update', 'explicit', '--rules-doc', '../outside.md'])
  assert.equal(escape.status, 1)
  assert.match(escape.stderr, /inside --root/)
  assert.equal(byName('explicit').rulesDoc, null)
  return true
})

await check('projects table stays at migration v3 after CLI writes', () => {
  const db = new DatabaseConstructor(dbPath, { readonly: true })
  const version = db.prepare('SELECT version FROM schema_migrations WHERE module = ?').get('memory')
  const rows = db.prepare('SELECT COUNT(*) AS total FROM projects').get()
  db.close()
  assert.equal(version.version, 3)
  assert.ok(rows.total >= 3, `projects rows: ${rows.total}`)
  return true
})

console.log(`\n${pass}/${pass + fail} passed`)
rmSync(dir, { recursive: true, force: true })
process.exitCode = fail === 0 ? 0 : 1
