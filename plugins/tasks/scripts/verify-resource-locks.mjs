/**
 * B4-b Phase 3: resource lease API (11 §14.6 / 15 §10.4).
 *
 * Real task store (in-memory tasks table on a temp DB) with a controlled clock:
 * expiry and heartbeat are observed, not simulated. Nothing here touches the
 * worktree switch or production data.
 *
 *   node plugins/tasks/scripts/verify-resource-locks.mjs
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  TaskError,
  createResourceLockService,
  createTaskStore,
  createTaskWorker,
  declaredResources,
  normalizeResourceKey,
  normalizeResourceKeys,
} from '../lib/index.js'

let pass = 0
let fail = 0
async function check(name, fn) {
  try {
    const detail = await fn()
    pass += 1
    console.log(`PASS  ${name}${detail === undefined ? '' : `  ${detail}`}`)
  } catch (error) {
    fail += 1
    console.log(`FAIL  ${name}\n        ${error instanceof Error ? error.message : String(error)}`)
  }
}

function rejectsInvalid(fn) {
  try {
    fn()
  } catch (error) {
    return error instanceof TaskError && error.code === 'invalid-input'
  }
  return false
}

const dir = mkdtempSync(join(tmpdir(), 'wfxm-locks-'))
const store = createTaskStore(join(dir, 'ops.sqlite'))
let clock = new Date('2026-11-12T00:00:00.000Z')
const advance = (ms) => {
  clock = new Date(clock.getTime() + ms)
}
const service = createResourceLockService({ store, now: () => clock })

const taskA = store.createTask({ intent: 'resource task A', riskLevel: 'R0' })
const taskB = store.createTask({ intent: 'resource task B', riskLevel: 'R0' })

const dbFile = join(dir, 'Data.SQLite')
writeFileSync(dbFile, '')
const gitRoot = join(dir, 'git-project')
mkdirSync(join(gitRoot, '.git'), { recursive: true })
const plainRoot = join(dir, 'plain-project')
mkdirSync(plainRoot, { recursive: true })

await check('port keys normalise protocol case and leading zeros', () => {
  assert.equal(normalizeResourceKey('port:TCP:08080'), 'port:tcp:8080')
  assert.equal(normalizeResourceKey(' port:udp:53 '), 'port:udp:53')
  assert.ok(rejectsInvalid(() => normalizeResourceKey('port:tcp:0')))
  assert.ok(rejectsInvalid(() => normalizeResourceKey('port:tcp:70000')))
  assert.ok(rejectsInvalid(() => normalizeResourceKey('port:tcp:abc')))
  assert.ok(rejectsInvalid(() => normalizeResourceKey('port:tcp')))
  return 'tcp:8080'
})

await check('db keys use realpath and lowercase the file name only', () => {
  const key = normalizeResourceKey(`db:${dbFile}`)
  assert.equal(key, `db:${join(dir, 'data.sqlite')}`)
  assert.ok(rejectsInvalid(() => normalizeResourceKey(`db:${join(dir, 'missing.sqlite')}`)))
  return 'lowercased'
})

await check('unit / docker / git keys follow their own rules', () => {
  assert.equal(normalizeResourceKey('unit:dsh-wfxm-managed-api.service'), 'unit:dsh-wfxm-managed-api.service')
  assert.ok(rejectsInvalid(() => normalizeResourceKey('unit:dsh-*')))
  assert.equal(normalizeResourceKey('docker:App-Prod'), 'docker:app-prod')
  assert.equal(normalizeResourceKey(`git:${gitRoot}`), `git:${gitRoot}`)
  assert.ok(rejectsInvalid(() => normalizeResourceKey(`git:${plainRoot}`)))
  assert.ok(rejectsInvalid(() => normalizeResourceKey('nope:value')))
  return 'ok'
})

await check('key lists are deduplicated and sorted; empty lists are rejected', () => {
  assert.deepEqual(
    normalizeResourceKeys(['unit:b', 'unit:a', 'unit:b']),
    ['unit:a', 'unit:b'],
  )
  assert.ok(rejectsInvalid(() => normalizeResourceKeys([])))
  return 'sorted'
})

await check('acquire writes one live row per key for the task', () => {
  const result = service.acquire({ taskId: taskA.id, keys: ['unit:check-5'] })
  assert.equal(result.state, 'acquired')
  assert.equal(result.grant.keys.length, 1)
  const live = service.list().filter((lock) => lock.resourceKey === 'unit:check-5')
  assert.equal(live.length, 1)
  assert.equal(live[0].taskId, taskA.id)
  assert.equal(live[0].releasedAt, null)
  assert.ok(live[0].leaseExpiresAt > clock.toISOString())
  return '1 lease'
})

await check('multi-key acquisition is all-or-nothing', () => {
  const held = service.acquire({ taskId: taskA.id, keys: ['unit:block-a', 'unit:block-b'] })
  assert.equal(held.state, 'acquired')

  const blocked = service.acquire({ taskId: taskB.id, keys: ['unit:free-c', 'unit:block-b'] })
  assert.equal(blocked.state, 'conflict')
  assert.deepEqual(blocked.blocking.map((entry) => entry.key), ['unit:block-b'])
  assert.equal(blocked.blocking[0].taskId, taskA.id)
  assert.equal(
    service.list().some((lock) => lock.resourceKey === 'unit:free-c'),
    false,
    'no partial row may be written',
  )
  return 'no partial'
})

await check('a second task on the same key gets conflict, not an exception', () => {
  const result = service.acquire({ taskId: taskB.id, keys: ['unit:check-5'] })
  assert.equal(result.state, 'conflict')
  assert.equal(service.list().filter((lock) => lock.resourceKey === 'unit:check-5').length, 1)
  return 'conflict'
})

await check('expired leases are released and can be re-acquired', () => {
  const short = service.acquire({ taskId: taskA.id, keys: ['unit:ttl'], ttlSec: 1 })
  assert.equal(short.state, 'acquired')
  advance(1_500)
  const taken = service.acquire({ taskId: taskB.id, keys: ['unit:ttl'], ttlSec: 60 })
  assert.equal(taken.state, 'acquired')
  const rows = service.list({ includeReleased: true }).filter((lock) => lock.resourceKey === 'unit:ttl')
  assert.equal(rows.length, 2)
  assert.notEqual(rows.find((lock) => lock.taskId === taskA.id).releasedAt, null)
  return 'expired → released'
})

await check('heartbeat extends only live locks', () => {
  const grant = service.acquire({ taskId: taskA.id, keys: ['unit:hb'], ttlSec: 60 })
  advance(30_000)
  const beat = service.heartbeat({ lockIds: grant.grant.lockIds, ttlSec: 120 })
  assert.equal(beat.extended, 1)
  assert.deepEqual(beat.lost, [])

  advance(60_000) // 90s since acquire > original 60s, still inside the extended window
  assert.equal(service.acquire({ taskId: taskB.id, keys: ['unit:hb'] }).state, 'conflict')

  advance(70_000) // 160s > extended 150s
  assert.equal(service.acquire({ taskId: taskB.id, keys: ['unit:hb'] }).state, 'acquired')

  const lost = service.heartbeat({ lockIds: grant.grant.lockIds, ttlSec: 60 })
  assert.equal(lost.extended, 0)
  assert.deepEqual(lost.lost, grant.grant.lockIds)
  return 'extended then lost'
})

await check('release is idempotent and frees the key', () => {
  const grant = service.acquire({ taskId: taskA.id, keys: ['unit:rel'] })
  assert.equal(service.release(grant.grant.lockIds).released, 1)
  assert.equal(service.release(grant.grant.lockIds).released, 0)
  assert.equal(service.release(['no-such-lock']).released, 0)
  assert.equal(service.acquire({ taskId: taskB.id, keys: ['unit:rel'] }).state, 'acquired')
  return 'idempotent'
})

await check('releaseByTask drops only that task leases', () => {
  const a = service.acquire({ taskId: taskA.id, keys: ['unit:life-a1', 'unit:life-a2'] })
  const b = service.acquire({ taskId: taskB.id, keys: ['unit:life-b'] })
  assert.equal(a.state, 'acquired')
  assert.equal(b.state, 'acquired')

  const before = service.list({ taskId: taskA.id }).length
  assert.ok(before >= 2)
  assert.equal(service.releaseByTask(taskA.id).released, before)
  assert.equal(service.list({ taskId: taskA.id }).length, 0)
  assert.ok(service.list({ taskId: taskB.id }).some((lock) => lock.resourceKey === 'unit:life-b'))
  return `${before} released`
})

await check('unknown task, empty keys and bad ttl are rejected', () => {
  assert.throws(
    () => service.acquire({ taskId: 'no-such-task', keys: ['unit:x'] }),
    (error) => error instanceof TaskError && error.code === 'not-found',
  )
  assert.ok(rejectsInvalid(() => service.acquire({ taskId: taskA.id, keys: [] })))
  assert.ok(rejectsInvalid(() => service.acquire({ taskId: taskA.id, keys: ['unit:x'], ttlSec: 0 })))
  assert.ok(rejectsInvalid(() => service.heartbeat({ lockIds: [], ttlSec: 10 })))
  return 'rejected'
})

await check('same task re-acquiring a held key is idempotent', () => {
  const first = service.acquire({ taskId: taskA.id, keys: ['unit:self'] })
  const again = service.acquire({ taskId: taskA.id, keys: ['unit:self'] })
  assert.equal(first.state, 'acquired')
  assert.equal(again.state, 'acquired')
  assert.deepEqual(again.grant.lockIds, first.grant.lockIds)
  assert.equal(service.list().filter((lock) => lock.resourceKey === 'unit:self').length, 1)
  return 'reused'
})

await check('plan.resources is validated at task creation and readable', () => {
  assert.deepEqual(declaredResources({ resources: ['unit:b', 'unit:a'] }), ['unit:a', 'unit:b'])
  assert.deepEqual(declaredResources(null), [])
  assert.deepEqual(declaredResources({ resources: [] }), [])
  assert.throws(
    () => store.createTask({ intent: 'bad resources', riskLevel: 'R0', plan: { resources: ['bogus:x'] } }),
    (error) => error instanceof TaskError && error.code === 'invalid-task',
  )
  assert.throws(
    () => store.createTask({ intent: 'bad shape', riskLevel: 'R0', plan: { resources: 'unit:a' } }),
    (error) => error instanceof TaskError && error.code === 'invalid-task',
  )
  return 'validated'
})

// --- Slice Y: worker acquires declared resources ---------------------------

const wiringDir = mkdtempSync(join(tmpdir(), 'wfxm-locks-wiring-'))
const wiringStore = createTaskStore(join(wiringDir, 'ops.sqlite'))
let wiringClock = new Date('2026-11-12T01:00:00.000Z')
const wiringAdvance = (ms) => {
  wiringClock = new Date(wiringClock.getTime() + ms)
}
const wiringService = createResourceLockService({ store: wiringStore, now: () => wiringClock })
const plans = (key) => ({ resources: [key] })

function wiringWorker(options = {}) {
  return createTaskWorker({
    store: wiringStore,
    resourceLocks: true,
    now: () => wiringClock,
    leaseMs: 600_000,
    heartbeatMs: 600_000,
    resourceTtlSec: 120,
    resourceRetryMs: 5_000,
    execute: () => ({ status: 'succeeded', summary: 'ok' }),
    ...options,
  })
}

/** A running task that holds a key, so the worker cannot claim it. */
function externalHolder(key) {
  const holder = wiringStore.createTask({ intent: `holder ${key}`, riskLevel: 'R0' })
  const claimed = wiringStore.claimTask({ owner: 'holder', leaseMs: 600_000, now: wiringClock })
  assert.equal(claimed.id, holder.id)
  const grant = wiringService.acquire({ taskId: holder.id, keys: [key], ttlSec: 600 })
  assert.equal(grant.state, 'acquired')
  return holder
}

await check('a resource-blocked task is deferred without consuming an attempt', async () => {
  const holder = externalHolder('unit:wire')
  const task = wiringStore.createTask({ intent: 'wired', riskLevel: 'R0', plan: plans('unit:wire') })
  let calls = 0
  const worker = wiringWorker({
    execute: () => {
      calls += 1
      return { status: 'succeeded', summary: 'ran' }
    },
  })
  const report = await worker.runOnce()
  const row = wiringStore.getTask(task.id)
  const deferred = wiringStore.listEvents(task.id).some((event) => event.type === 'task.deferred')
  assert.equal(report.skipped, 'resource-conflict')
  assert.equal(row.status, 'queued')
  assert.equal(row.attempt, 0)
  assert.equal(calls, 0)
  assert.ok(deferred, 'task.deferred event must be recorded')

  wiringService.releaseByTask(holder.id)
  wiringAdvance(6_000)
  const second = await worker.runOnce()
  assert.equal(second.outcome, 'succeeded')
  assert.equal(wiringStore.getTask(task.id).status, 'succeeded')
  assert.equal(calls, 1)
  assert.equal(wiringService.list({ taskId: task.id }).length, 0)
  return 'deferred then ran'
})

await check('sequential tasks sharing a key run one after the other', async () => {
  const first = wiringStore.createTask({ intent: 'seq first', riskLevel: 'R0', plan: plans('unit:seq') })
  const second = wiringStore.createTask({ intent: 'seq second', riskLevel: 'R0', plan: plans('unit:seq') })
  const worker = wiringWorker()
  assert.equal((await worker.runOnce()).outcome, 'succeeded')
  assert.equal((await worker.runOnce()).outcome, 'succeeded')
  assert.equal(wiringStore.getTask(first.id).status, 'succeeded')
  assert.equal(wiringStore.getTask(second.id).status, 'succeeded')
  assert.equal(wiringService.list().filter((lock) => lock.resourceKey === 'unit:seq').length, 0)
  return 'no deadlock'
})

await check('the switch off means declared resources are ignored', async () => {
  const holder = externalHolder('unit:off')
  const task = wiringStore.createTask({ intent: 'unlocked', riskLevel: 'R0', plan: plans('unit:off') })
  const worker = wiringWorker({ resourceLocks: false })
  const report = await worker.runOnce()
  assert.equal(report.outcome, 'succeeded')
  assert.equal(wiringStore.getTask(task.id).status, 'succeeded')
  assert.equal(wiringService.list({ taskId: holder.id }).length, 1)
  assert.equal(wiringService.list({ taskId: task.id }).length, 0)
  return 'ignored'
})

await check('worker heartbeat extends the resource lease', async () => {
  const task = wiringStore.createTask({ intent: 'beat', riskLevel: 'R0', plan: plans('unit:beat') })
  let before = null
  let after = null
  let beatOk = false
  const worker = wiringWorker({
    execute: (running, hooks) => {
      before = wiringService.list({ taskId: running.id })[0].leaseExpiresAt
      wiringAdvance(30_000)
      beatOk = hooks.heartbeat()
      after = wiringService.list({ taskId: running.id })[0].leaseExpiresAt
      return { status: 'succeeded', summary: 'beat' }
    },
  })
  const report = await worker.runOnce()
  assert.equal(report.outcome, 'succeeded')
  assert.equal(beatOk, true)
  assert.ok(after > before, `${after} should be later than ${before}`)
  assert.equal(wiringService.list({ taskId: task.id }).length, 0)
  return 'extended'
})

await check('losing the resource lease mid-run fails the task', async () => {
  const task = wiringStore.createTask({ intent: 'lose lease', riskLevel: 'R0', plan: plans('unit:lost') })
  let beatOk = true
  const worker = wiringWorker({
    execute: (running, hooks) => {
      wiringStore.releaseTaskResourceLocks(running.id)
      beatOk = hooks.heartbeat()
      return { status: 'succeeded', summary: 'should not succeed' }
    },
  })
  const report = await worker.runOnce()
  assert.equal(beatOk, false)
  assert.equal(report.outcome, 'failed')
  assert.equal(wiringStore.getTask(task.id).status, 'failed')
  return 'failed closed'
})

await check('undeclared tasks stay out of resource_locks', async () => {
  const one = wiringStore.createTask({ intent: 'plain one', riskLevel: 'R0' })
  const two = wiringStore.createTask({ intent: 'plain two', riskLevel: 'R0' })
  const worker = wiringWorker()
  assert.equal((await worker.runOnce()).outcome, 'succeeded')
  assert.equal((await worker.runOnce()).outcome, 'succeeded')
  assert.equal(wiringStore.getTask(one.id).status, 'succeeded')
  assert.equal(wiringStore.getTask(two.id).status, 'succeeded')
  assert.equal(wiringService.list({ taskId: one.id }).length, 0)
  assert.equal(wiringService.list({ taskId: two.id }).length, 0)
  return 'no rows'
})

wiringStore.close()
rmSync(wiringDir, { recursive: true, force: true })

store.close()
rmSync(dir, { recursive: true, force: true })

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exitCode = 1
