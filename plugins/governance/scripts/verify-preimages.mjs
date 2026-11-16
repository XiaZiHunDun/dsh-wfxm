import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import DatabaseConstructor from 'better-sqlite3'
import { apply, setTaskContextResolver } from '../lib/index.js'
import {
  createPreimageRollbackPort,
  createSnapshotStore,
  rollbackPreimages,
  restorePreimage,
} from '@dsh-wfxm/snapshot'
import {
  createTaskStore,
  createTaskWorker,
  currentCheckpointId,
  currentTaskContext,
  rollbackTask,
  runWithCheckpoint,
} from '@dsh-wfxm/tasks'

const root = mkdtempSync(join(tmpdir(), 'gov-preimage-'))
const dbPath = join(root, 'ops.sqlite')
const policyPath = join(root, 'policy.yaml')
const workspace = join(root, 'ws')
mkdirSync(workspace, { recursive: true })

process.env.DSH_WFXM_AUDIT_DB = dbPath
process.env.DSH_WFXM_POLICY = policyPath

function writePolicy(options = {}) {
  writeFileSync(policyPath, `
version: 1
killSwitchFile: KILL
writeRoots:
  - ${workspace}
readRoots:
  - ${workspace}
concurrency:
  writeSerialization: true
  conflictLimit: 3
preimages:
  enabled: ${options.enabled ?? true}
  roots: []
  inlineLimit: 32
  contentDir: ${join(root, 'spill')}
`)
}

let pass = 0
let fail = 0
async function check(label, fn) {
  try {
    const ok = await fn()
    if (ok) {
      pass++
      console.log(`PASS  ${label}`)
    } else {
      fail++
      console.log(`FAIL  ${label}`)
    }
  } catch (error) {
    fail++
    console.log(`FAIL  ${label} — ${error instanceof Error ? error.message : String(error)}`)
  }
}

function mount() {
  const listeners = new Map()
  const ctx = {
    on(event, listener) {
      listeners.set(event, listener)
    },
    logger: { info() {}, warn() {}, error() {} },
  }
  apply(ctx)
  const pre = listeners.get('tools/pre-execute')
  if (!pre) throw new Error('tools/pre-execute listener not registered')
  return { pre, listeners }
}

function rows() {
  const db = new DatabaseConstructor(dbPath, { readonly: true })
  const preimages = db.prepare('SELECT * FROM file_preimages').all()
  const version = db.prepare("SELECT version FROM schema_migrations WHERE module = 'snapshot'").get()
  db.close()
  return { preimages, version }
}

writePolicy()
let { pre } = mount()

// ---- capture on the way in ---------------------------------------------------

await check('a write captures the previous bytes before next() runs', async () => {
  const target = join(workspace, 'app.conf')
  writeFileSync(target, 'listen 80;\n')
  let nextCalled = false
  const decision = await pre(
    { callId: 'call_w1', name: 'write', arguments: { path: target, content: 'broken' } },
    async () => {
      nextCalled = true
      writeFileSync(target, 'broken')
      return { kind: 'allow' }
    },
  )
  const { preimages, version } = rows()
  const row = preimages.find((item) => item.tool_call_id === 'call_w1')
  return nextCalled
    && decision?.kind === 'allow'
    && version.version === 1
    && row !== undefined
    && row.state === 'present'
    && row.content_ref.startsWith('inline:')
    && row.path === target
})

await check('the captured pre-image restores the file after the tool damaged it', async () => {
  const target = join(workspace, 'app.conf')
  const store = createSnapshotStore(dbPath)
  const row = store.getPreimage('call_w1', target)
  restorePreimage({ preimage: row })
  store.close()
  return readFileSync(target, 'utf8') === 'listen 80;\n'
})

await check('edit uses file_path and an absent target becomes a tombstone', async () => {
  const target = join(workspace, 'new.conf')
  let nextCalled = false
  await pre(
    { callId: 'call_e1', name: 'edit', arguments: { file_path: target, old: '', new: 'x' } },
    async () => {
      nextCalled = true
      writeFileSync(target, 'x')
      return { kind: 'allow' }
    },
  )
  const { preimages } = rows()
  const row = preimages.find((item) => item.tool_call_id === 'call_e1')
  return nextCalled && row !== undefined && row.state === 'absent' && row.content_ref === null
})

await check('content above the inline limit is spilled to contentDir', async () => {
  const target = join(workspace, 'big.conf')
  writeFileSync(target, 'y'.repeat(64))
  await pre(
    { callId: 'call_big', name: 'write', arguments: { path: target } },
    async () => ({ kind: 'allow' }),
  )
  const { preimages } = rows()
  const row = preimages.find((item) => item.tool_call_id === 'call_big')
  return row !== undefined
    && row.content_ref.startsWith('file:')
    && existsSync(row.content_ref.slice('file:'.length))
})

await check('read and shell calls never capture a pre-image', async () => {
  await pre({ callId: 'call_r1', name: 'read', arguments: { path: join(workspace, 'app.conf') } },
    async () => ({ kind: 'allow' }))
  await pre({ callId: 'call_s1', name: 'bash', arguments: { command: 'ls' } },
    async () => ({ kind: 'allow' }))
  const { preimages } = rows()
  return !preimages.some((row) => row.tool_call_id === 'call_r1' || row.tool_call_id === 'call_s1')
})

await check('a relative path is skipped instead of guessed', async () => {
  let nextCalled = false
  await pre({ callId: 'call_rel', name: 'write', arguments: { path: 'src/app.ts' } },
    async () => {
      nextCalled = true
      return { kind: 'allow' }
    })
  const { preimages } = rows()
  return nextCalled && !preimages.some((row) => row.tool_call_id === 'call_rel')
})

// ---- fail-closed -------------------------------------------------------------

await check('an unreadable target denies the call (preimage-failed)', async () => {
  const target = join(workspace, 'secret.conf')
  writeFileSync(target, 'precious\n')
  chmodSync(target, 0o000)
  let nextCalled = false
  const decision = await pre(
    { callId: 'call_deny', name: 'write', arguments: { path: target, content: 'x' } },
    async () => {
      nextCalled = true
      return { kind: 'allow' }
    },
  )
  chmodSync(target, 0o644)
  const { preimages } = rows()
  return !nextCalled
    && decision?.kind === 'deny'
    && /^preimage-failed/.test(decision.reason ?? '')
    && !preimages.some((row) => row.tool_call_id === 'call_deny')
})

await check('a target outside the pre-image roots is not captured', async () => {
  const outside = join(root, 'outside.conf')
  writeFileSync(outside, 'x')
  let nextCalled = false
  await pre({ callId: 'call_out', name: 'write', arguments: { path: outside } },
    async () => {
      nextCalled = true
      return { kind: 'allow' }
    })
  const { preimages } = rows()
  return !nextCalled || !preimages.some((row) => row.tool_call_id === 'call_out')
})

// ---- ⑤ → ④ task attribution ------------------------------------------------

setTaskContextResolver(null)
await check('outside a task the pre-image keeps task_id NULL', async () => {
  const target = join(workspace, 'notask.conf')
  writeFileSync(target, 'a')
  await pre({ callId: 'call_notask', name: 'write', arguments: { path: target } },
    async () => ({ kind: 'allow' }))
  const row = rows().preimages.find((item) => item.tool_call_id === 'call_notask')
  return row !== undefined && row.task_id === null
})

setTaskContextResolver(() => ({ taskId: 'task_ctx_1' }))
await check('a wired task context stamps task_id on the pre-image', async () => {
  const target = join(workspace, 'attributed.conf')
  writeFileSync(target, 'a')
  await pre({ callId: 'call_ctx', name: 'write', arguments: { path: target } },
    async () => ({ kind: 'allow' }))
  const row = rows().preimages.find((item) => item.tool_call_id === 'call_ctx')
  return row !== undefined && row.task_id === 'task_ctx_1'
})

setTaskContextResolver(() => {
  throw new Error('resolver exploded')
})
await check('a throwing resolver still captures, task_id stays NULL', async () => {
  const target = join(workspace, 'broken-resolver.conf')
  writeFileSync(target, 'a')
  let nextCalled = false
  const decision = await pre({ callId: 'call_ctx_boom', name: 'write', arguments: { path: target } },
    async () => {
      nextCalled = true
      return { kind: 'allow' }
    })
  const row = rows().preimages.find((item) => item.tool_call_id === 'call_ctx_boom')
  return nextCalled && decision?.kind === 'allow' && row !== undefined && row.task_id === null
})
setTaskContextResolver(null)

// The worker runs the executor inside ⑤'s ambient context; the gate reads it
// through the same host wiring production uses.
setTaskContextResolver(currentTaskContext)
const e2eStore = createTaskStore(join(root, 'task-e2e.sqlite'))
await check('a worker run stamps step ids and rolls back only the failed step', async () => {
  const first = join(workspace, 'step1.conf')
  const second = join(workspace, 'step2.conf')
  writeFileSync(first, 'one-original\n')
  writeFileSync(second, 'two-original\n')
  const seen = []
  let stepOne = null
  let stepTwo = null
  const worker = createTaskWorker({
    store: e2eStore,
    owner: 'e2e-worker',
    leaseMs: 5_000,
    heartbeatMs: 60_000,
    now: () => new Date('2026-11-09T12:00:00.000Z'),
    execute: async (task) => {
      // Step 1 succeeds and stays put.
      stepOne = e2eStore.beginCheckpoint({ taskId: task.id, label: 'write step1' })
      await runWithCheckpoint(stepOne.id, async () => {
        await pre(
          { callId: 'call_e2e_1', name: 'write', arguments: { path: first } },
          async () => {
            writeFileSync(first, 'one-changed\n')
            return { kind: 'allow' }
          },
        )
      })
      e2eStore.closeCheckpoint(stepOne.id, 'committed')

      // Step 2 writes, then fails: undo this step only.
      stepTwo = e2eStore.beginCheckpoint({ taskId: task.id, label: 'write step2' })
      await runWithCheckpoint(stepTwo.id, async () => {
        await pre(
          { callId: 'call_e2e_2', name: 'write', arguments: { path: second } },
          async () => {
            writeFileSync(second, 'two-changed\n')
            return { kind: 'allow' }
          },
        )
        seen.push(currentCheckpointId())
      })
      e2eStore.closeCheckpoint(stepTwo.id, 'aborted')
      return { status: 'succeeded', summary: 'two steps, step2 aborted' }
    },
  })
  const task = e2eStore.createTask({ intent: 'e2e step attribution', riskLevel: 'R1' })
  const report = await worker.runOnce()

  const store = createSnapshotStore(dbPath)
  const forTask = store.listPreimages({ taskId: task.id })
  const step2Rows = store.listPreimages({ taskId: task.id, checkpointId: stepTwo.id })
  const undone = rollbackTask({
    store: e2eStore,
    port: createPreimageRollbackPort(store),
    taskId: task.id,
    checkpointId: stepTwo.id,
  })
  const afterStep = { first: readFileSync(first, 'utf8'), second: readFileSync(second, 'utf8') }
  rollbackTask({ store: e2eStore, port: createPreimageRollbackPort(store), taskId: task.id })
  const afterTask = { first: readFileSync(first, 'utf8'), second: readFileSync(second, 'utf8') }
  store.close()

  const checkpoints = e2eStore.listCheckpoints(task.id)
  return report.taskId === task.id
    && report.outcome === 'succeeded'
    && seen[0] === stepTwo.id
    && currentCheckpointId() === null
    && forTask.length === 2
    && forTask[0].checkpointId === stepOne.id
    && forTask[0].toolCallId === 'call_e2e_1'
    && step2Rows.length === 1
    && step2Rows[0].toolCallId === 'call_e2e_2'
    && undone.restored.length === 1
    && undone.closedCheckpoints.length === 0
    && undone.checkpoints.length === 2
    && afterStep.first === 'one-changed\n'
    && afterStep.second === 'two-original\n'
    && afterTask.first === 'one-original\n'
    && afterTask.second === 'two-original\n'
    && checkpoints.length === 2
    && checkpoints[0].seq === 1 && checkpoints[0].status === 'committed'
    && checkpoints[1].seq === 2 && checkpoints[1].status === 'aborted'
    && e2eStore.getTask(task.id).status === 'succeeded'
})
setTaskContextResolver(null)
e2eStore.close()

// ---- disabled by policy ------------------------------------------------------

writePolicy({ enabled: false })
;({ pre } = mount())
await check('disabling pre-images in the policy records nothing', async () => {
  const target = join(workspace, 'off.conf')
  writeFileSync(target, 'x')
  let nextCalled = false
  await pre({ callId: 'call_off', name: 'write', arguments: { path: target } },
    async () => {
      nextCalled = true
      return { kind: 'allow' }
    })
  const { preimages } = rows()
  return nextCalled && !preimages.some((row) => row.tool_call_id === 'call_off')
})

assert.ok(pass + fail > 0)
console.log(`\npreimages: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exitCode = 1
rmSync(root, { recursive: true, force: true })
