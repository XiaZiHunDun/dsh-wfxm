/**
 * `@dsh-wfxm/changes`（Slice AV）：表、状态机、半应用查询与 ⑤ 端口。
 *
 * 运行：node plugins/changes/scripts/verify-changes.mjs
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createChangeStore, createTaskChangePort } from '../lib/index.js'

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

const dir = mkdtempSync(join(tmpdir(), 'dsh-changes-'))
const dbPath = join(dir, 'ops.sqlite')
const store = createChangeStore(dbPath)

await check('begin creates an applying row with the task/snapshot/target fields', async () => {
  const result = store.begin({
    taskId: 'task-1',
    kind: 'task',
    target: '/srv/app',
    snapshotId: 'snap_1',
    now: new Date('2026-11-18T10:00:00.000Z'),
  })
  return result.ok
    && result.change.status === 'applying'
    && result.change.rollbackStatus === 'none'
    && result.change.kind === 'task'
    && result.change.target === '/srv/app'
    && result.change.snapshotId === 'snap_1'
    && result.change.closedAt === null
    && result.change.id.startsWith('chg_')
})

await check('begin is idempotent per task and never overwrites the first row', async () => {
  const again = store.begin({ taskId: 'task-1', target: 'ignored' })
  const first = store.getByTask('task-1')
  return again.ok
    && again.change.id === first.id
    && again.change.target === '/srv/app'
    && store.listRecent().length === 1
})

await check('applying → applied → verified → kept walks the happy path', async () => {
  const applied = store.markApplied('task-1', 'wrote 2 files')
  const verified = store.markVerified('task-1')
  const kept = store.keep('task-1')
  return applied.ok && applied.change.status === 'applied'
    && verified.ok && verified.change.status === 'verified'
    && kept.ok && kept.change.status === 'kept' && kept.change.closedAt !== null
})

await check('illegal transitions are refused with a code, not an exception', async () => {
  const again = store.keep('task-1')
  const back = store.markApplied('task-1')
  const unknown = store.markApplied('no-such-task')
  return again.ok === false && again.code === 'invalid-transition'
    && back.ok === false && back.code === 'invalid-transition'
    && unknown.ok === false && unknown.code === 'not-found'
})

await check('a terminal failure is reachable from applying only', async () => {
  store.begin({ taskId: 'task-2', target: '/srv/app' })
  const failed = store.markFailed('task-2', 'executor said no')
  const keptAfterFailed = store.keep('task-2')
  return failed.ok && failed.change.status === 'failed'
    && keptAfterFailed.ok === false
    && keptAfterFailed.code === 'invalid-transition'
})

await check('claimRollback succeeds exactly once and is required before rolled_back', async () => {
  const early = store.markRolledBack('task-2')
  const claimed = store.claimRollback('task-2')
  const twice = store.claimRollback('task-2')
  const rolled = store.markRolledBack('task-2', 'restored preimages')
  return early.ok === false && early.code === 'invalid-transition'
    && claimed === true
    && twice === false
    && rolled.ok
    && rolled.change.status === 'rolled_back'
    && rolled.change.rollbackStatus === 'done'
    && rolled.change.closedAt !== null
})

await check('markRollbackFailed needs a claimed rollback and keeps the change status', async () => {
  store.begin({ taskId: 'task-3', target: '/srv/app' })
  const early = store.markRollbackFailed('task-3', 'nothing claimed')
  store.claimRollback('task-3')
  const late = store.markRollbackFailed('task-3', 'restic locator cannot restore')
  return early.ok === false && early.code === 'invalid-transition'
    && late.ok
    && late.change.rollbackStatus === 'failed'
    && late.change.status === 'applying'
    && late.change.detail === 'restic locator cannot restore'
})

await check('listHalfApplied returns rows still awaiting a rollback, not ones already failed', async () => {
  store.begin({ taskId: 'task-4', target: '/srv/app' })
  store.begin({ taskId: 'task-5', target: '/srv/app' })
  store.markFailed('task-5', 'boom')
  store.claimRollback('task-5')
  store.begin({ taskId: 'task-6', target: '/srv/app' })
  store.keep('task-6')
  const rows = store.listHalfApplied()
  const ids = rows.map((row) => row.taskId)
  return ids.includes('task-4')
    && ids.includes('task-5')
    && !ids.includes('task-3')
    && !ids.includes('task-6')
    && !ids.includes('task-1')
    && !ids.includes('task-2')
})

await check('a claimed-but-unfinished rollback stays visible to the next startup', async () => {
  const rows = store.listHalfApplied()
  const row = rows.find((item) => item.taskId === 'task-5')
  return row?.rollbackStatus === 'ready'
})

await check('reopening the same database does not re-run the migration or lose rows', async () => {
  store.close()
  const reopened = createChangeStore(dbPath)
  const row = reopened.getByTask('task-1')
  reopened.close()
  return row?.status === 'kept'
})

await check('the ⑤ port maps begin/keep/markFailed and defaults kind=task/target=taskId', async () => {
  const portStore = createChangeStore(join(dir, 'port.sqlite'))
  const port = createTaskChangePort(portStore)
  const begun = port.begin({ taskId: 'task-port' })
  const kept = port.keep({ taskId: 'task-port', detail: 'done' })
  const row = portStore.getByTask('task-port')
  portStore.close()
  return begun.ok
    && kept.ok
    && row?.status === 'kept'
    && row?.kind === 'task'
    && row?.target === 'task-port'
    && row?.snapshotId === null
})

rmSync(dir, { recursive: true, force: true })

console.log(`\n${pass} passed · ${fail} failed`)
if (fail > 0) process.exit(1)
