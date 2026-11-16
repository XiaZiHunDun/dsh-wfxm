/**
 * Slice AA: `scripts/locks.mjs` (resource-lock ops view / release).
 *
 * Runs the real entry point as a subprocess against a temp ops.sqlite; seeds
 * locks through the real store, then observes list/release output.
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createResourceLockService, createTaskStore } from '../lib/index.js'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const cliPath = join(repoRoot, 'scripts/locks.mjs')
const dir = mkdtempSync(join(tmpdir(), 'wfxm-locks-cli-'))
const dbPath = join(dir, 'ops.sqlite')

let pass = 0
let fail = 0
function check(name, fn) {
  try {
    fn()
    pass += 1
    console.log(`PASS  ${name}`)
  } catch (error) {
    fail += 1
    console.log(`FAIL  ${name}\n        ${error instanceof Error ? error.message : String(error)}`)
  }
}

function run(args) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: 'utf8',
    env: { ...process.env, DSH_WFXM_DB: dbPath },
  })
}

function listJson(args = []) {
  const result = run(['list', '--json', ...args])
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

check('empty database lists no locks', () => {
  const result = run(['list'])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /no resource locks/)
})

const store = createTaskStore(dbPath)
const service = createResourceLockService({ store })
const taskA = store.createTask({ intent: 'lock cli A', riskLevel: 'R0' })
const taskB = store.createTask({ intent: 'lock cli B', riskLevel: 'R0' })
const grantA = service.acquire({ taskId: taskA.id, keys: ['unit:cli-a1', 'unit:cli-a2'] })
const grantB = service.acquire({ taskId: taskB.id, keys: ['unit:cli-b'] })
assert.equal(grantA.state, 'acquired')
assert.equal(grantB.state, 'acquired')
store.close()

check('list --json shows live locks with camelCase fields', () => {
  const locks = listJson()
  assert.equal(locks.length, 3)
  const keys = locks.map((lock) => lock.resourceKey).sort()
  assert.deepEqual(keys, ['unit:cli-a1', 'unit:cli-a2', 'unit:cli-b'])
  for (const lock of locks) {
    assert.equal(typeof lock.id, 'string')
    assert.equal(typeof lock.taskId, 'string')
    assert.equal(lock.releasedAt, null)
    assert.ok(lock.leaseExpiresAt > new Date().toISOString())
  }
  return '3 live'
})

check('plain list prints key, task and expiry', () => {
  const result = run(['list'])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /unit:cli-a1/)
  assert.match(result.stdout, new RegExp(`task=${taskA.id}`))
  assert.match(result.stdout, /expires=/)
  return 'printed'
})

check('release <lockId> frees one lock and is idempotent', () => {
  const lockId = grantA.grant.lockIds[0]
  const first = run(['release', lockId])
  assert.equal(first.status, 0, first.stderr)
  assert.match(first.stdout, /released/)
  assert.equal(listJson().length, 2)

  const again = run(['release', lockId])
  assert.equal(again.status, 0)
  assert.match(again.stdout, /already released/)
  return 'idempotent'
})

check('release --task accepts taskRef and only drops that task locks', () => {
  const result = run(['release', '--task', taskA.taskRef])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /released 1 lock/)
  const remaining = listJson()
  assert.equal(remaining.length, 1)
  assert.equal(remaining[0].resourceKey, 'unit:cli-b')
  return `taskRef ${taskA.taskRef}`
})

check('list --all includes released rows', () => {
  const all = listJson(['--all'])
  assert.equal(all.length, 3)
  assert.equal(all.filter((lock) => lock.releasedAt !== null).length, 2)
  return '3 rows, 2 released'
})

check('unknown task / unknown command exit 1', () => {
  const missing = run(['release', '--task', 'no-such-task'])
  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /task not found/)

  const unknown = run(['frobnicate'])
  assert.equal(unknown.status, 1)
  assert.match(unknown.stderr, /unknown command/)
  return 'rejected'
})

rmSync(dir, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exitCode = 1
