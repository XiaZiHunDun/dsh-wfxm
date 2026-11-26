import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync, existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import DatabaseConstructor from 'better-sqlite3'
import {
  TASK_TOOL_RISK,
  TaskError,
  apply,
  completeTask,
  createTaskStore,
  createTaskWorker,
  currentCheckpointId,
  currentTaskId,
  evaluateAssertion,
  inject,
  name,
  parseExpertDirective,
  prepareAssertions,
  registerTaskTools,
  rollbackTask,
  runWithCheckpoint,
  runWithTaskContext,
  verifyTask,
} from '../lib/index.js'
// Cross-module acceptance only: ① consumes `v_task_anchors` (docs/15 §9.5).
import {
  createGatewayStore,
  createOutboxDispatcher,
  createReceiptRelay,
  ingestInbound,
  resolveFollowUp,
} from '@dsh-wfxm/gateway'

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

const dir = mkdtempSync(join(tmpdir(), 'tasks-'))
const dbPath = join(dir, 'ops.sqlite')
const store = createTaskStore(dbPath)

// ---- Slice CH (O1): expert column + directive parser -----------------------

await check('v15: tasks.expert migrates, persists and defaults to null', () => {
  const meta = new DatabaseConstructor(dbPath)
  const row = meta
    .prepare("SELECT MAX(version) AS version FROM schema_migrations WHERE module = 'tasks'")
    .get()
  meta.close()
  assert.equal(row.version, 15)

  const explicit = store.createTask({ intent: '修 bug', riskLevel: 'R1', expert: 'dsh' })
  assert.equal(explicit.expert, 'dsh')
  assert.equal(store.getTask(explicit.id).expert, 'dsh')

  const plain = store.createTask({ intent: '看日志', riskLevel: 'R1' })
  assert.equal(plain.expert, null)
  assert.equal(store.getTask(plain.id).expert, null)
  return true
})

await check('/expert directive: strips the prefix, flags an empty body, leaves other text alone', () => {
  assert.deepEqual(parseExpertDirective('/expert dsh 修 bug'), { expert: 'dsh', intent: '修 bug', usage: false })
  assert.deepEqual(parseExpertDirective('/EXPERT dsh'), { expert: 'dsh', intent: '', usage: true })
  assert.deepEqual(parseExpertDirective('/expert'), { expert: null, intent: '', usage: true })
  assert.deepEqual(parseExpertDirective('修 bug'), { expert: null, intent: '修 bug', usage: false })
  assert.deepEqual(parseExpertDirective('/experts dsh 修 bug'), { expert: null, intent: '/experts dsh 修 bug', usage: false })
  return true
})

const fixturePath = join(dir, 'nginx.conf')
writeFileSync(fixturePath, 'server { listen 80; }\n')
const fixtureSha = createHash('sha256').update(readFileSync(fixturePath)).digest('hex')

// ---- tool surface -----------------------------------------------------------

const registered = []
const ctx = { tools: { register: (tool) => registered.push(tool) } }
const rollbackCalls = []
registerTaskTools(ctx, {
  store,
  rollbackPort: {
    rollback: (input) => {
      rollbackCalls.push(input)
      return [{ path: fixturePath, state: 'present' }]
    },
  },
  assertionOptions: {
    allowedPaths: [dir],
    allowedUnits: ['nginx.service'],
    allowedHosts: ['127.0.0.1'],
  },
})
const tools = new Map(registered.map((tool) => [tool.name, tool]))
const submit = (args) => tools.get('task_submit').execute(args)
const status = (args) => tools.get('task_status').execute(args)
const control = (args) => tools.get('task_control').execute(args)
const rollback = (args) => tools.get('task_rollback').execute(args)
/** L0: `running` is entered only through `claimTask`; tests claim a specific row. */
const startTask = (taskId, target = store, owner = 'verify') => {
  const claimed = target.claimTask({ owner, leaseMs: 60_000, taskId })
  if (claimed === null) throw new Error(`task ${taskId} is not claimable`)
  return claimed
}

const R2 = (overrides = {}) => ({
  intent: 'reload nginx and confirm the config is live',
  riskLevel: 'R2',
  assertions: [{ kind: 'file_exists', path: fixturePath }],
  ...overrides,
})

// ---- schema -----------------------------------------------------------------

await check('migration creates the four base tables at v1 and the v2 additions', () => {
  const db = new DatabaseConstructor(dbPath, { readonly: true })
  const names = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => row.name)
  const version = db
    .prepare('SELECT MAX(version) AS version FROM schema_migrations WHERE module = ?')
    .get('tasks')
  const objects = db
    .prepare("SELECT name FROM sqlite_master WHERE type IN ('index','trigger','view')")
    .all()
    .map((row) => row.name)
  const columns = db.prepare('PRAGMA table_info(tasks)').all().map((row) => row.name)
  db.close()
  return names.includes('tasks')
    && names.includes('task_events')
    && names.includes('task_assertions')
    && names.includes('receipts')
    && names.includes('task_threads')
    && names.includes('task_inputs')
    && names.includes('task_checkpoints')
    && names.includes('resource_locks')
    && names.includes('task_usage_daily')
    && version.version === 15
    && ['input_tokens', 'output_tokens', 'cost_usd', 'approved_level', 'expert'].every((column) =>
      columns.includes(column))
    && objects.includes('ux_task_events_seq')
    && objects.includes('task_events_no_update')
    && objects.includes('task_events_no_delete')
    && objects.includes('ux_receipts_round')
    && objects.includes('ux_tasks_task_ref')
    && objects.includes('ux_task_thread_live')
    && objects.includes('ux_thread_default_owner')
    && objects.includes('ix_task_threads_thread')
    && objects.includes('ux_task_input_dedup')
    && objects.includes('ix_task_inputs_pending')
    && objects.includes('v_task_anchors')
    && objects.includes('ix_tasks_wake')
    && objects.includes('ux_task_checkpoints_seq')
    && objects.includes('ix_tasks_isolation')
    && objects.includes('ux_tasks_worktree_path')
    && objects.includes('ux_resource_lock_live')
    && objects.includes('ix_resource_locks_lease')
})

await check('BK usage accumulates token/cost across attempts', () => {
  const usageTask = store.createTask({ intent: 'usage bookkeeping', riskLevel: 'R1' })
  store.recordUsage(usageTask.id, { inputTokens: 1_200, outputTokens: 300, costUsd: 0.0021 })
  store.recordUsage(usageTask.id, { inputTokens: 800, outputTokens: 200, costUsd: 0.0009 })
  const task = store.getTask(usageTask.id)
  return task.inputTokens === 2_000
    && task.outputTokens === 500
    && Math.abs(task.costUsd - 0.003) < 1e-9
})

await check('CC daily usage rolls up per local day (M8)', () => {
  const usageTask = store.createTask({ intent: 'daily rollup', riskLevel: 'R1' })
  store.recordUsage(
    usageTask.id,
    { inputTokens: 1_000, outputTokens: 200, costUsd: 0.001 },
    new Date(2026, 2, 10, 9, 0, 0),
  )
  store.recordUsage(
    usageTask.id,
    { inputTokens: 500, outputTokens: 100, costUsd: 0.0005 },
    new Date(2026, 2, 10, 18, 0, 0),
  )
  store.recordUsage(
    usageTask.id,
    { inputTokens: 300, outputTokens: 50, costUsd: 0.0002 },
    new Date(2026, 2, 11, 1, 0, 0),
  )
  const today = store.dailyUsage('2026-03-10')
  const tomorrow = store.dailyUsage('2026-03-11')
  const empty = store.dailyUsage('2026-03-12')
  return today.inputTokens === 1_500
    && today.outputTokens === 300
    && Math.abs(today.costUsd - 0.0015) < 1e-9
    && tomorrow.inputTokens === 300
    && empty.inputTokens === 0
    && empty.costUsd === 0
})

await check('a v1 database upgrades in place to v3 without rebuilding old tables', () => {
  const upgradeDb = join(dir, 'upgrade.sqlite')
  const first = createTaskStore(upgradeDb)
  const kept = first.createTask({ intent: 'survives the upgrade', riskLevel: 'R1' })
  first.close()

  // Roll the schema back to the v1 shape (v2 objects dropped, version = 1).
  const raw = new DatabaseConstructor(upgradeDb)
  raw.exec(`
    DROP VIEW v_task_anchors;
    DROP TABLE task_inputs;
    DROP TABLE task_threads;
    DROP INDEX ux_tasks_task_ref;
    ALTER TABLE tasks DROP COLUMN task_ref;
    ALTER TABLE tasks DROP COLUMN origin_msg_id;
    DROP INDEX ix_tasks_wake;
    ALTER TABLE tasks DROP COLUMN next_attempt_at;
    DROP INDEX ux_tasks_worktree_path;
    DROP INDEX ix_tasks_isolation;
    ALTER TABLE tasks DROP COLUMN prepared_at;
    ALTER TABLE tasks DROP COLUMN prepare_state;
    ALTER TABLE tasks DROP COLUMN merge_state;
    ALTER TABLE tasks DROP COLUMN branch;
    ALTER TABLE tasks DROP COLUMN base_commit;
    ALTER TABLE tasks DROP COLUMN worktree_path;
    ALTER TABLE tasks DROP COLUMN isolation;
    ALTER TABLE tasks DROP COLUMN input_tokens;
    ALTER TABLE tasks DROP COLUMN output_tokens;
    ALTER TABLE tasks DROP COLUMN cost_usd;
    ALTER TABLE tasks DROP COLUMN approved_level;
    ALTER TABLE tasks DROP COLUMN expert;
    DELETE FROM schema_migrations WHERE module = 'tasks' AND version > 1;
  `)
  raw.close()

  const upgraded = createTaskStore(upgradeDb)
  const keptTask = upgraded.listTasks().find((task) => task.id === kept.id)
  const fresh = upgraded.createTask({ intent: 'created after the upgrade', riskLevel: 'R1' })
  const db = new DatabaseConstructor(upgradeDb, { readonly: true })
  const version = db.prepare('SELECT MAX(version) AS version FROM schema_migrations WHERE module = ?').get('tasks')
  const view = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'view' AND name = 'v_task_anchors'")
    .get()
  const viewColumns = db
    .prepare('PRAGMA table_info(v_task_anchors)')
    .all()
    .map((row) => row.name)
  db.close()
  upgraded.close()
  return keptTask !== undefined
    && keptTask.intent === 'survives the upgrade'
    && keptTask.taskRef === null
    && fresh.taskRef !== null
    && fresh.taskRef.length === 10
    && version.version === 15
    && keptTask.isolation === 'serial'
    && fresh.isolation === 'serial'
    && fresh.worktreePath === null
    && view !== undefined
    && viewColumns.includes('project_id')
})

await check('migration is idempotent on reopen', () => {
  const second = createTaskStore(dbPath)
  const ok = second.listTasks().length === store.listTasks().length
  second.close()
  return ok
})

// ---- submit / criteria ------------------------------------------------------

await check('registers four tools with their risk baseline', () => {
  return registered.length === 4
    && tools.has('task_submit')
    && tools.has('task_status')
    && tools.has('task_control')
    && tools.has('task_rollback')
    && TASK_TOOL_RISK.task_submit === 'R1'
    && TASK_TOOL_RISK.task_status === 'R0'
    && TASK_TOOL_RISK.task_control === 'R1'
    && TASK_TOOL_RISK.task_rollback === 'R1'
})

await check('apply opens the configured database, registers tools and closes on dispose', () => {
  const previous = process.env.DSH_WFXM_AUDIT_DB
  const applyDb = join(dir, 'apply.sqlite')
  process.env.DSH_WFXM_AUDIT_DB = applyDb
  const applied = []
  let disposed = null
  try {
    apply({
      tools: { register: (tool) => applied.push(tool) },
      logger: {},
      on: (event, handler) => {
        if (event === 'dispose') disposed = handler
      },
    })
  } finally {
    if (previous === undefined) delete process.env.DSH_WFXM_AUDIT_DB
    else process.env.DSH_WFXM_AUDIT_DB = previous
  }
  const created = existsSync(applyDb)
  if (typeof disposed === 'function') disposed()
  return applied.length === 4
    && applied.some((tool) => tool.name === 'task_rollback')
    && created
    && name === 'dsh-wfxm-tasks'
    && inject.includes('tools')
})

await check('R1 task without assertions is accepted as queued', async () => {
  const value = await submit({ intent: 'read the nginx config', riskLevel: 'R1' })
  const events = store.listEvents(value.task.id)
  return value.task.status === 'queued'
    && value.task.attempt === 0
    && value.task.startedAt === null
    && value.assertionIds.length === 0
    && events.length === 1
    && events[0].type === 'task.created'
    && events[0].seq === 1
})

await check('R2 task without assertions is rejected (criteria-required)', async () => {
  const before = store.listTasks().length
  await assert.rejects(
    () => submit({ intent: 'restart nginx', riskLevel: 'R2' }),
    (error) => error instanceof TaskError && error.code === 'criteria-required',
  )
  return store.listTasks().length === before
})

await check('R2 task with a real assertion is accepted', async () => {
  const value = await submit(R2())
  const assertions = store.listAssertions(value.task.id)
  return value.task.status === 'queued'
    && value.task.riskLevel === 'R2'
    && value.assertionIds.length === 1
    && assertions.length === 1
    && assertions[0].kind === 'file_exists'
    && assertions[0].status === 'pending'
    && assertions[0].spec.path === fixturePath
})

await check('unknown assertion kind is rejected', () => {
  assert.throws(
    () => prepareAssertions([{ kind: 'curl_ok' }]),
    (error) => error instanceof TaskError && error.code === 'invalid-assertion',
  )
  return true
})

await check('more than eight assertions are rejected', () => {
  const nine = Array.from({ length: 9 }, (_, index) => ({
    kind: 'file_exists',
    path: join(dir, `f${index}.conf`),
  }))
  assert.throws(
    () => prepareAssertions(nine),
    (error) => error instanceof TaskError && error.code === 'invalid-assertion',
  )
  return true
})

await check('shell fragments in a unit are rejected', () => {
  assert.throws(
    () => prepareAssertions([{ kind: 'service_active', unit: 'nginx.service;rm -rf /' }]),
    (error) => error instanceof TaskError && error.code === 'invalid-assertion',
  )
  return true
})

await check('wildcard paths are rejected', () => {
  assert.throws(
    () => prepareAssertions([{ kind: 'file_exists', path: join(dir, '*.conf') }]),
    (error) => error instanceof TaskError && error.code === 'invalid-assertion',
  )
  return true
})

await check('paths outside the allowlisted roots are rejected', () => {
  assert.throws(
    () => prepareAssertions(
      [{ kind: 'file_exists', path: '/etc/passwd' }],
      { allowedPaths: [dir] },
    ),
    (error) => error instanceof TaskError && error.code === 'invalid-assertion',
  )
  return true
})

await check('credentials embedded in a URL are rejected', () => {
  assert.throws(
    () => prepareAssertions([{ kind: 'http_status', url: 'http://user:pass@127.0.0.1/health' }]),
    (error) => error instanceof TaskError && error.code === 'invalid-assertion',
  )
  return true
})

await check('mail_archived accepts defaults and a folder, rejects bad minCount/control chars', () => {
  const defaults = prepareAssertions([{ kind: 'mail_archived' }])
  const folder = prepareAssertions([{ kind: 'mail_archived', folder: '已归档', minCount: 3 }])
  let badCount = false
  let badFolder = false
  try {
    prepareAssertions([{ kind: 'mail_archived', minCount: 0 }])
  } catch {
    badCount = true
  }
  try {
    prepareAssertions([{ kind: 'mail_archived', folder: 'a\u0001b' }])
  } catch {
    badFolder = true
  }
  return defaults.length === 1
    && defaults[0].kind === 'mail_archived'
    && defaults[0].spec.minCount === 1
    && defaults[0].spec.folder === undefined
    && folder[0].spec.folder === '已归档'
    && folder[0].spec.minCount === 3
    && badCount
    && badFolder
})

await check('mail_archived survives the v10 CHECK constraint on a real row', () => {
  const task = store.createTask({ intent: 'mail archive row', riskLevel: 'R2' })
  for (const prepared of prepareAssertions([{ kind: 'mail_archived' }])) {
    store.addAssertion(task.id, prepared)
  }
  const row = store.listAssertions(task.id)[0]
  return row.kind === 'mail_archived' && row.status === 'pending'
})

await check('mail_sent / mail_drafted take defaults and a folder, reject bad minCount', () => {
  const sent = prepareAssertions([{ kind: 'mail_sent' }])
  const drafted = prepareAssertions([{ kind: 'mail_drafted', folder: '草稿箱', minCount: 2 }])
  let bad = false
  try {
    prepareAssertions([{ kind: 'mail_sent', minCount: 0 }])
  } catch {
    bad = true
  }
  return sent.length === 1 && sent[0].kind === 'mail_sent' && sent[0].spec.minCount === 1
    && drafted.length === 1 && drafted[0].kind === 'mail_drafted'
    && drafted[0].spec.folder === '草稿箱' && drafted[0].spec.minCount === 2
    && bad
})

await check('mail_sent / mail_drafted survive the v11 CHECK constraint on real rows', () => {
  const task = store.createTask({ intent: 'mail send row', riskLevel: 'R3' })
  for (const prepared of prepareAssertions([{ kind: 'mail_sent' }, { kind: 'mail_drafted' }])) {
    store.addAssertion(task.id, prepared)
  }
  const kinds = store.listAssertions(task.id).map((row) => row.kind).sort()
  return kinds.join(',') === 'mail_drafted,mail_sent'
})

await check('calendar_event takes defaults and rejects out-of-range windows', () => {
  const prepared = prepareAssertions([{ kind: 'calendar_event' }])
  const custom = prepareAssertions([{ kind: 'calendar_event', minCount: 2, windowDays: 30 }])
  let badDays = false
  let badCount = false
  try {
    prepareAssertions([{ kind: 'calendar_event', windowDays: 32 }])
  } catch {
    badDays = true
  }
  try {
    prepareAssertions([{ kind: 'calendar_event', minCount: 0 }])
  } catch {
    badCount = true
  }
  return prepared.length === 1 && prepared[0].kind === 'calendar_event'
    && prepared[0].spec.minCount === 1 && prepared[0].spec.windowDays === 7
    && custom[0].spec.minCount === 2 && custom[0].spec.windowDays === 30
    && badDays && badCount
})

await check('calendar_event survives the v12 CHECK constraint on real rows', () => {
  const task = store.createTask({ intent: 'calendar row', riskLevel: 'R2' })
  for (const prepared of prepareAssertions([{ kind: 'calendar_event' }])) {
    store.addAssertion(task.id, prepared)
  }
  return store.listAssertions(task.id).map((row) => row.kind).join(',') === 'calendar_event'
})

await check('duplicate assertions are rejected', () => {
  assert.throws(
    () => prepareAssertions([
      { kind: 'file_exists', path: fixturePath },
      { kind: 'file_exists', path: fixturePath },
    ]),
    (error) => error instanceof TaskError && error.code === 'invalid-assertion',
  )
  return true
})

await check('relative file paths are rejected', () => {
  assert.throws(
    () => prepareAssertions([{ kind: 'file_exists', path: 'nginx.conf' }]),
    (error) => error instanceof TaskError && error.code === 'invalid-assertion',
  )
  return true
})

// ---- state machine ----------------------------------------------------------

const machineTask = (await submit({ intent: 'state machine walk', riskLevel: 'R1' })).task

await check('queued -> running only through claimTask (lease + attempt + started_at)', () => {
  const claimed = startTask(machineTask.id)
  const events = store.listEvents(machineTask.id)
  return claimed.status === 'running'
    && claimed.attempt === 1
    && claimed.startedAt !== null
    && claimed.leaseOwner === 'verify'
    && claimed.leaseExpiresAt !== null
    && events.some((event) => event.type === 'task.started')
})

await check('transition refuses to start a task (single entry)', () => {
  const queued = store.createTask({ intent: 'edge probe', riskLevel: 'R1' })
  assert.throws(
    () => store.transition(queued.id, { to: 'running' }),
    (error) => error instanceof TaskError && error.code === 'invalid-transition',
  )
  assert.throws(
    () => store.transition(machineTask.id, { to: 'running' }),
    (error) => error instanceof TaskError && error.code === 'invalid-transition',
  )
  return store.getTask(queued.id).status === 'queued'
})

await check('task_control no longer advertises or accepts start', async () => {
  const advertised = tools.get('task_control').parameters?.action?.enum ?? []
  // Schema validation is the first line of defence; the runtime default below
  // it stays fail-closed for direct callers.
  await assert.rejects(
    () => control({ taskId: machineTask.id, action: 'start' }),
    /must be one of/,
  )
  return !advertised.includes('start')
})

await check('resume re-queues a paused task instead of starting it', async () => {
  const paused = await control({ taskId: machineTask.id, action: 'pause', reason: 'waiting for window' })
  const resumed = await control({ taskId: machineTask.id, action: 'resume' })
  const again = await control({ taskId: machineTask.id, action: 'resume' })
  const events = store.listEvents(machineTask.id).map((event) => event.type)
  return paused.task.status === 'paused'
    && resumed.task.status === 'queued'
    && again.task.status === 'queued'
    && resumed.task.attempt === 0
    && events.includes('task.paused')
    && events.includes('task.resumed')
})

await check('an illegal edge is refused by the store', () => {
  // A queued row cannot jump to succeeded; a terminal move needs a receipt summary.
  assert.throws(
    () => store.transition(machineTask.id, { to: 'succeeded', summary: '' }),
    (error) => error instanceof TaskError && error.code === 'invalid-transition',
  )
  const temp = store.createTask({ intent: 'edge probe 2', riskLevel: 'R1' })
  assert.throws(
    () => store.transition(temp.id, { to: 'cancelled' }),
    (error) => error instanceof TaskError && error.code === 'invalid-task',
  )
  startTask(temp.id)
  store.transition(temp.id, { to: 'cancelled', summary: 'probe' })
  assert.throws(() => startTask(temp.id), /not claimable/)
  return true
})

await check('event seq is contiguous and append-only triggers fire', () => {
  const seqs = store.listEvents(machineTask.id).map((event) => event.seq)
  const contiguous = seqs.every((seq, index) => seq === index + 1)
  const db = new DatabaseConstructor(dbPath)
  let updateBlocked = false
  let deleteBlocked = false
  try {
    db.prepare("UPDATE task_events SET type = 'task.failed' WHERE task_id = ?").run(machineTask.id)
  } catch (error) {
    updateBlocked = /append-only/.test(String(error.message))
  }
  try {
    db.prepare('DELETE FROM task_events WHERE task_id = ?').run(machineTask.id)
  } catch (error) {
    deleteBlocked = /append-only/.test(String(error.message))
  }
  db.close()
  return contiguous && updateBlocked && deleteBlocked
})

await check('cancel is terminal, writes a receipt and refuses further moves', async () => {
  const value = await control({
    taskId: machineTask.id,
    action: 'cancel',
    summary: 'owner cancelled the walk',
  })
  const receipts = store.listReceipts(machineTask.id)
  const events = store.listEvents(machineTask.id)
  let refused = false
  try {
    startTask(machineTask.id)
  } catch (error) {
    refused = error instanceof Error && /not claimable/.test(error.message)
  }
  return value.task.status === 'cancelled'
    && value.task.finishedAt !== null
    && receipts.length === 1
    && receipts[0].summary === 'owner cancelled the walk'
    && receipts[0].round === 1
    && receipts[0].deliveredAt === null
    && events.some((event) => event.type === 'task.cancelled')
    && events.some((event) => event.type === 'task.receipt')
    && refused
})

await check('a second receipt for the same task round is refused', () => {
  assert.throws(() => store.writeReceipt({
    taskId: machineTask.id,
    round: 1,
    summary: 'duplicate',
  }))
  return true
})

// ---- thread subscriptions (TaskSubscriptionApi, 15 §9.6) --------------------

const ownerTask = (await submit({ intent: 'own the thread', riskLevel: 'R1' })).task
const otherTask = (await submit({ intent: 'wants the same thread', riskLevel: 'R1' })).task
const threadId = 'thread-0001'

await check('bind default_owner creates one live subscription', () => {
  const bound = store.bindThread({ taskId: ownerTask.id, threadId, relation: 'default_owner' })
  const live = store.listTaskThreads({ threadId, liveOnly: true })
  return bound.relation === 'default_owner'
    && bound.releasedAt === null
    && live.length === 1
    && live[0].taskId === ownerTask.id
})

await check('bind is idempotent on the same live key', () => {
  const again = store.bindThread({ taskId: ownerTask.id, threadId, relation: 'default_owner' })
  return store.listTaskThreads({ threadId, liveOnly: true }).length === 1
    && again.id === store.listTaskThreads({ threadId })[0].id
})

await check('a second live default_owner is Conflict and is never preempted', () => {
  assert.throws(
    () => store.bindThread({ taskId: otherTask.id, threadId, relation: 'default_owner' }),
    (error) => error instanceof TaskError && error.code === 'conflict',
  )
  const live = store.listTaskThreads({ threadId, liveOnly: true })
  return live.length === 1 && live[0].taskId === ownerTask.id
})

await check('anchor subscriptions need an anchor message and allow several per task', () => {
  assert.throws(
    () => store.bindThread({ taskId: ownerTask.id, threadId, relation: 'anchor' }),
    (error) => error instanceof TaskError && error.code === 'invalid-input',
  )
  const first = store.bindThread({
    taskId: ownerTask.id,
    threadId,
    relation: 'anchor',
    anchorMsgId: 'msg-start',
  })
  const duplicate = store.bindThread({
    taskId: ownerTask.id,
    threadId,
    relation: 'anchor',
    anchorMsgId: 'msg-start',
  })
  const second = store.bindThread({
    taskId: ownerTask.id,
    threadId,
    relation: 'anchor',
    anchorMsgId: 'msg-result',
  })
  return first.id === duplicate.id
    && second.id !== first.id
    && store.listTaskThreads({ taskId: ownerTask.id, liveOnly: true }).length === 3
})

await check('bind rejects unknown tasks and empty threads', () => {
  assert.throws(
    () => store.bindThread({ taskId: 'missing', threadId, relation: 'default_owner' }),
    (error) => error instanceof TaskError && error.code === 'not-found',
  )
  assert.throws(
    () => store.bindThread({ taskId: ownerTask.id, threadId: '  ', relation: 'default_owner' }),
    (error) => error instanceof TaskError && error.code === 'invalid-input',
  )
  return true
})

await check('occupancy reports the default owner, live and wakeable tasks', async () => {
  const before = store.occupancy(threadId)
  startTask(ownerTask.id)
  const running = store.occupancy(threadId)
  await control({ taskId: ownerTask.id, action: 'cancel', summary: 'done for now' })
  return before.defaultOwnerTaskId === ownerTask.id
    && before.live.includes(ownerTask.id)
    && running.live.includes(ownerTask.id)
    && running.wakeable.length === 0
    && store.occupancy(threadId).live.includes(ownerTask.id) === false
})

await check('release stamps the reason and is idempotent', () => {
  const released = store.releaseThread({ taskId: ownerTask.id, threadId, reason: 'handback' })
  const again = store.releaseThread({ taskId: ownerTask.id, threadId, reason: 'handback' })
  return released.length === 3
    && released.every((thread) => thread.releasedAt !== null && thread.releaseReason === 'handback')
    && again.length === 0
    && store.listTaskThreads({ threadId, liveOnly: true }).length === 0
    && store.occupancy(threadId).defaultOwnerTaskId === null
})

await check('release rejects an unknown reason', () => {
  assert.throws(
    () => store.releaseThread({ taskId: ownerTask.id, threadId, reason: 'whatever' }),
    (error) => error instanceof TaskError && error.code === 'invalid-input',
  )
  return true
})

await check('v_task_anchors falls back to tasks.origin_msg_id and hides released rows', () => {
  const anchored = store.createTask({
    intent: 'anchored by the original message',
    riskLevel: 'R1',
    originMsgId: 'msg-origin',
  })
  store.bindThread({ taskId: anchored.id, threadId: 'thread-0002', relation: 'default_owner' })
  const db = new DatabaseConstructor(dbPath, { readonly: true })
  const live = db
    .prepare('SELECT task_id, anchor_msg_id, round, status FROM v_task_anchors WHERE thread_id = ?')
    .all('thread-0002')
  store.releaseThread({ taskId: anchored.id, threadId: 'thread-0002', reason: 'stopped' })
  const after = db
    .prepare('SELECT * FROM v_task_anchors WHERE thread_id = ?')
    .all('thread-0002')
  db.close()
  return live.length === 1
    && live[0].task_id === anchored.id
    && live[0].anchor_msg_id === 'msg-origin'
    && live[0].round === 1
    && live[0].status === 'queued'
    && after.length === 0
})

// ---- Slice AP: same-thread execution context --------------------------------

await check('recentThreadResults lists only earlier succeeded receipts on the same thread', () => {
  const contextStore = createTaskStore(join(dir, 'thread-results.sqlite'))
  const thread = 'thread-results'
  const finished = (summary, boundThread) => {
    const task = contextStore.createTask({ intent: summary, riskLevel: 'R1' })
    if (boundThread !== undefined) {
      contextStore.bindThread({ taskId: task.id, threadId: boundThread, relation: 'default_owner' })
    }
    startTask(task.id, contextStore)
    // A terminal transition writes the receipt for the task's round itself.
    contextStore.transition(task.id, { to: 'succeeded', summary })
    return task
  }
  finished('旧结果一', thread)
  finished('旧结果二', thread)
  finished('别的线程', 'thread-results-other')
  const failed = contextStore.createTask({ intent: '失败任务', riskLevel: 'R1' })
  contextStore.bindThread({ taskId: failed.id, threadId: thread, relation: 'anchor', anchorMsgId: 'msg-failed' })
  startTask(failed.id, contextStore)
  contextStore.transition(failed.id, { to: 'failed', summary: '失败回执' })

  const current = contextStore.createTask({ intent: '当前任务', riskLevel: 'R1' })
  contextStore.bindThread({ taskId: current.id, threadId: thread, relation: 'anchor', anchorMsgId: 'msg-current' })
  const results = contextStore.recentThreadResults(current.id)
  const limited = contextStore.recentThreadResults(current.id, 1)
  contextStore.close()
  return results.length === 2
    && results.every((row) => row.summary.startsWith('旧结果') && row.taskRef !== null)
    && limited.length === 1
    && results.every((row) => row.summary !== '别的线程' && row.summary !== '失败回执')
})

// ---- pending inputs (TaskInputApi, 15 §9.6) ---------------------------------

const inputTask = store.createTask({ intent: 'collect follow-ups', riskLevel: 'R1', round: 3 })

await check('enqueue takes the round from the task, not from the caller', () => {
  const input = store.enqueueInput({ taskId: inputTask.id, inboxId: 'inbox-1' })
  return input.taskId === inputTask.id
    && input.inboxId === 'inbox-1'
    && input.round === 3
    && input.status === 'pending'
    && input.deliveredAt === null
    && input.readAt === null
})

await check('enqueue is idempotent on (task_id, inbox_id)', () => {
  const first = store.enqueueInput({ taskId: inputTask.id, inboxId: 'inbox-1' })
  const second = store.enqueueInput({ taskId: inputTask.id, inboxId: 'inbox-1' })
  const db = new DatabaseConstructor(dbPath, { readonly: true })
  const rows = db
    .prepare('SELECT COUNT(*) AS count FROM task_inputs WHERE task_id = ?')
    .get(inputTask.id)
  db.close()
  return second.id === first.id && rows.count === 1
})

await check('pending lists only undelivered inputs in round order', () => {
  store.enqueueInput({ taskId: inputTask.id, inboxId: 'inbox-2' })
  const pending = store.pendingInputs(inputTask.id)
  return pending.length === 2
    && pending.every((input) => input.status === 'pending' && input.round === 3)
    && pending[0].inboxId === 'inbox-1'
})

await check('markDelivered then markRead walk the status whitelist', () => {
  const pending = store.pendingInputs(inputTask.id)[0]
  const delivered = store.markInputDelivered(pending.id)
  const read = store.markInputRead(pending.id)
  const again = store.markInputRead(pending.id)
  return delivered.status === 'delivered'
    && delivered.deliveredAt !== null
    && read.status === 'read'
    && read.readAt !== null
    && again.readAt === read.readAt
    && store.pendingInputs(inputTask.id).length === 1
})

await check('markRead on a pending input is Conflict; unknown ids are NotFound', () => {
  const pending = store.pendingInputs(inputTask.id)[0]
  assert.throws(
    () => store.markInputRead(pending.id),
    (error) => error instanceof TaskError && error.code === 'conflict',
  )
  assert.throws(
    () => store.markInputDelivered('missing'),
    (error) => error instanceof TaskError && error.code === 'not-found',
  )
  return true
})

await check('enqueue rejects unknown tasks and empty inbox ids', () => {
  assert.throws(
    () => store.enqueueInput({ taskId: 'missing', inboxId: 'inbox-9' }),
    (error) => error instanceof TaskError && error.code === 'not-found',
  )
  assert.throws(
    () => store.enqueueInput({ taskId: inputTask.id, inboxId: '' }),
    (error) => error instanceof TaskError && error.code === 'invalid-input',
  )
  return true
})

// ---- AR37 wake: succeeded → queued with round + 1 ---------------------------

const wakeTarget = store.createTask({
  intent: 'wake into a new round',
  riskLevel: 'R1',
  round: 2,
})
store.bindThread({ taskId: wakeTarget.id, threadId: 'thread-wake', relation: 'default_owner' })
startTask(wakeTarget.id)
store.transition(wakeTarget.id, { to: 'succeeded', summary: 'round one done' })

await check('wakeTask re-queues a succeeded task into round + 1 and resets the attempt', () => {
  const woken = store.wakeTask({ taskId: wakeTarget.id, reason: 'owner replied in the thread' })
  const events = store.listEvents(wakeTarget.id)
  const receipts = store.listReceipts(wakeTarget.id)
  return woken.status === 'queued'
    && woken.round === 3
    && woken.attempt === 0
    && woken.leaseOwner === null
    && woken.leaseExpiresAt === null
    && woken.startedAt === null
    && woken.finishedAt === null
    && events.some((event) => event.type === 'task.woken'
      && event.payload.from === 'succeeded'
      && event.payload.round === 3
      && event.payload.previousRound === 2
      && event.payload.reason === 'owner replied in the thread')
    && receipts.length === 1
})

await check('a woken task walks queued → running again inside the new round', () => {
  const running = startTask(wakeTarget.id)
  return running.status === 'running' && running.attempt === 1 && running.round === 3
})

await check('waking a task that is not succeeded is refused', () => {
  const queued = store.createTask({ intent: 'not finished yet', riskLevel: 'R1' })
  store.bindThread({ taskId: queued.id, threadId: 'thread-wake-open', relation: 'default_owner' })
  assert.throws(
    () => store.wakeTask({ taskId: queued.id }),
    (error) => error instanceof TaskError && error.code === 'conflict',
  )
  return store.getTask(queued.id).status === 'queued'
})

await check('waking without a live thread is refused and leaves the task succeeded', () => {
  const lonely = store.createTask({ intent: 'no thread to wake into', riskLevel: 'R1' })
  startTask(lonely.id)
  store.transition(lonely.id, { to: 'succeeded', summary: 'done, nobody attached' })
  assert.throws(
    () => store.wakeTask({ taskId: lonely.id }),
    (error) => error instanceof TaskError && error.code === 'conflict',
  )
  return store.getTask(lonely.id).status === 'succeeded'
})

await check('a released thread no longer wakes, and an unknown task is NotFound', () => {
  const released = store.createTask({ intent: 'thread handed back', riskLevel: 'R1' })
  store.bindThread({
    taskId: released.id,
    threadId: 'thread-wake-released',
    relation: 'default_owner',
  })
  startTask(released.id)
  store.transition(released.id, { to: 'succeeded', summary: 'done' })
  store.releaseThread({ taskId: released.id, threadId: 'thread-wake-released', reason: 'handback' })
  assert.throws(
    () => store.wakeTask({ taskId: released.id }),
    (error) => error instanceof TaskError && error.code === 'conflict',
  )
  assert.throws(
    () => store.wakeTask({ taskId: 'missing' }),
    (error) => error instanceof TaskError && error.code === 'not-found',
  )
  return true
})

await check('@dsh-wfxm/gateway consumes the real view: resolveFollowUp hits the anchor', () => {
  const gateway = createGatewayStore(dbPath)
  const thread = gateway.resolveThread({
    channelId: 'feishu',
    chatId: 'chat-1',
    rootMsgId: 'msg-origin-2',
  })
  const task = store.createTask({
    intent: 'anchored task for the gateway',
    riskLevel: 'R1',
    originMsgId: 'msg-origin-2',
  })
  store.bindThread({ taskId: task.id, threadId: thread.id, relation: 'default_owner' })
  const hasView = gateway.hasTaskAnchorView()
  const hit = resolveFollowUp(gateway, {
    channelId: 'feishu',
    chatId: 'chat-1',
    replyToMsgId: 'msg-origin-2',
  })
  const single = resolveFollowUp(gateway, { channelId: 'feishu', chatId: 'chat-1' })
  gateway.close()
  return hasView
    && hit.available
    && hit.matchedBy === 'anchor'
    && hit.taskId === task.id
    && hit.round === 1
    && hit.requiresGrantCheck === false
    && single.matchedBy === 'single-live'
    && single.taskId === task.id
})

await check('① ingest relays a follow-up into task_inputs end to end', async () => {
  const gateway = createGatewayStore(dbPath)
  const owner = gateway.createActor({ kind: 'owner' })
  gateway.bindChannel({ actorId: owner.id, channelId: 'feishu', externalUserId: 'open_e2e' })
  const thread = gateway.resolveThread({
    channelId: 'feishu',
    chatId: 'chat-e2e',
    rootMsgId: 'root-e2e',
  })
  const task = store.createTask({
    intent: 'receives follow-ups through ①',
    riskLevel: 'R1',
    originMsgId: 'root-e2e',
  })
  store.bindThread({ taskId: task.id, threadId: thread.id, relation: 'default_owner' })

  // The host composes this adapter from ⑤'s public API; ① never touches ⑤'s tables.
  const relay = {
    attach: (input) => ({ id: store.bindThread({ ...input, relation: 'anchor' }).id }),
    enqueue: (input) => ({ id: store.enqueueInput(input).id }),
  }
  const input = {
    channelId: 'feishu',
    msgId: 'e2e-msg-1',
    externalUserId: 'open_e2e',
    content: { text: '继续做' },
    chatId: 'chat-e2e',
    replyToMsgId: 'root-e2e',
  }
  const result = await ingestInbound({ store: gateway, relay }, input)
  const replay = await ingestInbound({ store: gateway, relay }, input)
  const pending = store.pendingInputs(task.id)
  const subscriptions = store.listTaskThreads({ taskId: task.id, threadId: thread.id, liveOnly: true })
  gateway.close()
  return result.bypassReason === 'task-anchor'
    && result.relay.enqueued === true
    && result.relay.attached === true
    && pending.length === 1
    && pending[0].inboxId === result.inbox.id
    && pending[0].round === 1
    && pending[0].status === 'pending'
    && replay.duplicate === true
    && store.pendingInputs(task.id).length === 1
    && subscriptions.length === 2
    && subscriptions.some((sub) => sub.relation === 'default_owner')
    && subscriptions.some((sub) => sub.relation === 'anchor' && sub.anchorMsgId === 'root-e2e')
})

// ---- receipt closure (⑤ → ① → channel → ⑤, 15 §9.6) ------------------------

const receiptTask = store.createTask({ intent: 'announce its receipt', riskLevel: 'R1' })
store.bindThread({ taskId: receiptTask.id, threadId: 'thread-receipt', relation: 'default_owner' })
store.bindThread({
  taskId: receiptTask.id,
  threadId: 'thread-receipt-anchor',
  relation: 'anchor',
  anchorMsgId: 'msg-receipt',
})
const receipt = store.writeReceipt({
  taskId: receiptTask.id,
  round: 1,
  summary: '部署完成',
  evidenceLocator: 'run:7',
})

await check('pendingReceipts exposes the announcement thread and the task metadata', () => {
  const pending = store.pendingReceipts().find((entry) => entry.id === receipt.id)
  const task = store.getTask(receiptTask.id)
  return pending !== undefined
    && pending.threadId === 'thread-receipt'
    && pending.round === 1
    && pending.summary === '部署完成'
    && pending.evidenceLocator === 'run:7'
    && pending.deliveredAt === null
    && pending.taskRef === task?.taskRef
    && pending.status === task?.status
})

await check('markReceiptDelivered stamps the ack once and is idempotent', () => {
  const delivered = store.markReceiptDelivered(receipt.id, 'ext-rc-1')
  const again = store.markReceiptDelivered(receipt.id, 'ext-rc-2')
  const pending = store.pendingReceipts().find((entry) => entry.id === receipt.id)
  return delivered.deliveredAt !== null
    && delivered.externalMsgId === 'ext-rc-1'
    && again.externalMsgId === 'ext-rc-1'
    && pending === undefined
})

await check('receipt ack rejects unknown ids and empty message ids', () => {
  assert.throws(
    () => store.markReceiptDelivered('missing', 'ext'),
    (error) => error instanceof TaskError && error.code === 'not-found',
  )
  assert.throws(
    () => store.markReceiptDelivered(receipt.id, '  '),
    (error) => error instanceof TaskError && error.code === 'invalid-input',
  )
  return true
})

// L3: a receipt without an addressable thread (Web-only) must not occupy the
// delivery window and starve receipts that do have a thread.
await check('pendingReceipts keeps thread-less receipts out of the delivery window', () => {
  const l3 = createTaskStore(join(dir, 'l3-receipts.sqlite'))
  const parkedTask = l3.createTask({ intent: 'web-only task', riskLevel: 'R1' })
  l3.writeReceipt({ taskId: parkedTask.id, round: 1, summary: '只在 Web 里完成' })
  const threadedTask = l3.createTask({ intent: 'chat task', riskLevel: 'R1' })
  l3.bindThread({ taskId: threadedTask.id, threadId: 'thread-l3', relation: 'default_owner' })
  l3.writeReceipt({ taskId: threadedTask.id, round: 1, summary: '会话里完成' })

  const first = l3.pendingReceipts(1)
  const all = l3.pendingReceipts(10)
  l3.close()
  return first.length === 1
    && first[0].taskId === threadedTask.id
    && first[0].threadId === 'thread-l3'
    && all.length === 2
    && all.some((entry) => entry.taskId === parkedTask.id && entry.threadId === null)
})

await check('① receipt relay closes the loop back into ⑤', async () => {
  const gateway = createGatewayStore(dbPath)
  const owner = gateway.createActor({ kind: 'owner' })
  gateway.bindChannel({ actorId: owner.id, channelId: 'feishu', externalUserId: 'open_rc' })
  const thread = gateway.resolveThread({
    channelId: 'feishu',
    chatId: 'chat-rc',
    rootMsgId: 'root-rc',
  })
  const task = store.createTask({
    intent: 'announce completion through ①',
    riskLevel: 'R1',
    originMsgId: 'root-rc',
  })
  store.bindThread({ taskId: task.id, threadId: thread.id, relation: 'default_owner' })
  const written = store.writeReceipt({ taskId: task.id, round: 1, summary: '备份完成' })

  const relay = createReceiptRelay({ store: gateway, receipts: store })
  const pump = relay.pump()
  const queued = gateway
    .listOutbox({ status: 'pending' })
    .filter((row) => row.payload.receiptId === written.id)
  const dispatcher = createOutboxDispatcher({
    store: gateway,
    transport: { transport: 'fake', async send() { return { externalMsgId: 'ext-rc-e2e' } } },
    owner: 'E2E',
    onSent: (item, externalMsgId) => {
      const receiptId = relay.receiptIdOf(item)
      if (receiptId !== null) relay.settle(receiptId, externalMsgId)
    },
  })
  const report = await dispatcher.runOnce()
  const settled = store.listReceipts(task.id)[0]
  gateway.close()
  return pump.enqueued >= 1
    && queued.length === 1
    && queued[0].threadId === thread.id
    && report.sent >= 1
    && settled.deliveredAt !== null
    && settled.externalMsgId === 'ext-rc-e2e'
})

// ---- control commands (① → ⑤ task_control, 11 §5.3) ------------------------

const CONTROL_TO_STATUS = { cancel: 'cancelled', pause: 'paused' }
const controlPort = {
  control: ({ taskId, action, checkpointId }) => {
    // L0: like the real host port, "resume" re-queues; only claimTask runs.
    if (action === 'resume') return { status: store.resumeTask(taskId).status }
    if (action === 'rollback') {
      const undone = rollbackTask({
        store,
        port: {
          rollback: (input) => {
            rollbackCalls.push(input)
            return [{ path: fixturePath, state: 'present' }]
          },
        },
        taskId,
        ...checkpointId === undefined ? {} : { checkpointId },
      })
      return { status: undone.task.status }
    }
    return {
      status: store.transition(taskId, {
        to: CONTROL_TO_STATUS[action],
        summary: `foreground ${action}`,
        reason: 'foreground-control',
      }).status,
    }
  },
}

async function controlFixture(suffix) {
  const gateway = createGatewayStore(dbPath)
  const owner = gateway.createActor({ kind: 'owner' })
  gateway.bindChannel({
    actorId: owner.id,
    channelId: 'feishu',
    externalUserId: `open_${suffix}`,
  })
  const rootMsgId = `root-${suffix}`
  const thread = gateway.resolveThread({
    channelId: 'feishu',
    chatId: `chat-${suffix}`,
    rootMsgId,
  })
  const task = store.createTask({ intent: `control ${suffix}`, riskLevel: 'R1', originMsgId: rootMsgId })
  store.bindThread({ taskId: task.id, threadId: thread.id, relation: 'default_owner' })
  startTask(task.id)
  return {
    gateway,
    task,
    send: (msgId, content) => ingestInbound({ store: gateway, control: controlPort }, {
      channelId: 'feishu',
      msgId,
      externalUserId: `open_${suffix}`,
      kind: 'control',
      content,
      chatId: `chat-${suffix}`,
      replyToMsgId: rootMsgId,
    }),
  }
}

await check('① stop reaches ⑤, cancels the anchored task and writes a receipt', async () => {
  const fixture = await controlFixture('ctl-stop')
  const result = await fixture.send('ctl-stop-1', { control: 'stop' })
  const cancelled = store.getTask(fixture.task.id)
  const receipts = store.listReceipts(fixture.task.id)
  fixture.gateway.close()
  return result.bypassReason === 'control'
    && result.error === null
    && result.control?.executed === true
    && result.control.action === 'cancel'
    && result.target.kind === 'control'
    && result.target.taskId === fixture.task.id
    && cancelled.status === 'cancelled'
    && receipts.length === 1
    && receipts[0].summary === 'foreground cancel'
})

await check('① pause / resume / status map onto ⑤ without side effects for status', async () => {
  const fixture = await controlFixture('ctl-pause')
  const paused = await fixture.send('ctl-pause-1', { control: 'pause' })
  const pausedTask = store.getTask(fixture.task.id)
  const resumed = await fixture.send('ctl-pause-2', { control: 'resume' })
  const resumedTask = store.getTask(fixture.task.id)
  const status = await fixture.send('ctl-pause-3', { control: 'status' })
  const afterStatus = store.getTask(fixture.task.id)
  const receipts = store.listReceipts(fixture.task.id)
  fixture.gateway.close()
  return paused.control?.executed === true
    && paused.control.action === 'pause'
    && pausedTask.status === 'paused'
    && resumed.control?.executed === true
    && resumed.control.action === 'resume'
    && resumedTask.status === 'queued'
    && resumedTask.leaseOwner === null
    && status.control?.executed === false
    && status.control.skipped === 'status-only'
    && afterStatus.status === 'queued'
    && receipts.length === 0
})

// ---- step rollback (⑤ task_rollback / rollbackTask, 13 §3.4) ----------------

const rollbackStore = createTaskStore(join(dir, 'rollback.sqlite'))
const rollbackRegistered = []
registerTaskTools(
  { tools: { register: (tool) => rollbackRegistered.push(tool) } },
  {
    store: rollbackStore,
    rollbackPort: {
      rollback: (input) => {
        rollbackCalls.push(input)
        return [{ path: fixturePath, state: 'present' }]
      },
    },
  },
)
const rollbackTool = (args) =>
  rollbackRegistered.find((tool) => tool.name === 'task_rollback').execute(args)

await check('task_rollback undoes one step and closes only that open checkpoint', async () => {
  const task = rollbackStore.createTask({ intent: 'rollback step', riskLevel: 'R1' })
  const other = rollbackStore.beginCheckpoint({ taskId: task.id, label: 'keep open' })
  const step = rollbackStore.beginCheckpoint({ taskId: task.id, label: 'undo me' })
  rollbackCalls.length = 0
  const out = await rollbackTool({ taskId: task.id, checkpointId: step.id, reason: 'user asked' })
  const events = rollbackStore.listEvents(task.id).filter((event) => event.type === 'task.rollback')
  return rollbackCalls.length === 1
    && rollbackCalls[0].taskId === task.id
    && rollbackCalls[0].checkpointId === step.id
    && out.checkpointId === step.id
    && out.restored.length === 1
    && out.closedCheckpoints.join(',') === step.id
    && rollbackStore.getCheckpoint(step.id).status === 'aborted'
    && rollbackStore.getCheckpoint(other.id).status === 'open'
    && events.length === 1
    && events[0].payload.scope === 'checkpoint'
    && events[0].payload.reason === 'user asked'
})

await check('task_rollback without a checkpoint rewinds the task and closes open steps', async () => {
  const task = rollbackStore.createTask({ intent: 'rollback all', riskLevel: 'R1' })
  const first = rollbackStore.beginCheckpoint({ taskId: task.id })
  rollbackStore.closeCheckpoint(first.id, 'committed')
  const second = rollbackStore.beginCheckpoint({ taskId: task.id })
  rollbackCalls.length = 0
  const out = await rollbackTool({ taskId: task.id })
  const events = rollbackStore.listEvents(task.id).filter((event) => event.type === 'task.rollback')
  return out.checkpointId === null
    && rollbackCalls[0].checkpointId === undefined
    && out.closedCheckpoints.join(',') === second.id
    && rollbackStore.getCheckpoint(first.id).status === 'committed'
    && events[0].payload.scope === 'task'
})

await check('task_rollback refuses an unknown or foreign checkpoint', async () => {
  const mine = rollbackStore.createTask({ intent: 'mine', riskLevel: 'R1' })
  const other = rollbackStore.createTask({ intent: 'other', riskLevel: 'R1' })
  const foreign = rollbackStore.beginCheckpoint({ taskId: other.id })
  let notFound = false
  try {
    await rollbackTool({ taskId: mine.id, checkpointId: 'cp-missing' })
  } catch (error) {
    notFound = error.code === 'not-found'
  }
  let foreignRejected = false
  try {
    await rollbackTool({ taskId: mine.id, checkpointId: foreign.id })
  } catch (error) {
    foreignRejected = error.code === 'invalid-input'
  }
  return notFound && foreignRejected
})

await check('task_rollback without a port fails loudly (no silent skip)', async () => {
  const bare = []
  registerTaskTools({ tools: { register: (tool) => bare.push(tool) } }, { store: rollbackStore })
  let code = null
  try {
    await bare.find((tool) => tool.name === 'task_rollback').execute({ taskId: 'whatever' })
  } catch (error) {
    code = error.code
  }
  return code === 'rollback-failed'
})

await check('① rollback reaches ⑤ even when the task is already finished', async () => {
  const fixture = await controlFixture('ctl-rollback')
  store.transition(fixture.task.id, { to: 'cancelled', summary: 'foreground stop' })
  const step = store.beginCheckpoint({ taskId: fixture.task.id, label: 'edit config' })
  rollbackCalls.length = 0
  const result = await fixture.send('ctl-rb-1', { control: 'rollback', checkpointId: step.id })
  fixture.gateway.close()
  return result.bypassReason === 'control'
    && result.error === null
    && result.control?.executed === true
    && result.control.action === 'rollback'
    && rollbackCalls[0]?.checkpointId === step.id
    && store.getCheckpoint(step.id).status === 'aborted'
})

// ---- worker: lease + retry grading + snapshot gate (13 §3.3 / §3.4) ---------

const workerDbPath = join(dir, 'worker.sqlite')
const workerStore = createTaskStore(workerDbPath)
let workerClock = new Date('2026-11-09T10:00:00.000Z')
const workerNow = () => new Date(workerClock)
const workerAdvance = (ms) => {
  workerClock = new Date(workerClock.getTime() + ms)
}

function workerFixture(options = {}) {
  const calls = []
  const worker = createTaskWorker({
    store: workerStore,
    owner: options.owner ?? 'worker-A',
    leaseMs: 1_000,
    heartbeatMs: 60_000,
    backoffMs: [1_000, 5_000],
    now: workerNow,
    snapshot: options.snapshot ?? null,
    ...options.changes === undefined ? {} : { changes: options.changes },
    execute: options.execute ?? ((task) => {
      calls.push(task.id)
      return { status: 'succeeded', summary: 'done' }
    }),
  })
  return { worker, calls }
}

await check('claimTask is exclusive, increments attempt once and leases the row', () => {
  const task = workerStore.createTask({ intent: 'claim me', riskLevel: 'R1' })
  const claimed = workerStore.claimTask({ owner: 'worker-A', leaseMs: 1_000, now: workerNow() })
  const again = workerStore.claimTask({ owner: 'worker-B', leaseMs: 1_000, now: workerNow() })
  const row = workerStore.getTask(task.id)
  return claimed !== null
    && claimed.id === task.id
    && claimed.status === 'running'
    && claimed.attempt === 1
    && claimed.leaseOwner === 'worker-A'
    && claimed.leaseExpiresAt === '2026-11-09T10:00:01.000Z'
    && again === null
    && row.status === 'running'
})

await check('renewLease only works for the current owner', () => {
  const task = workerStore.listTasks({ status: 'running' })[0]
  const byOther = workerStore.renewLease({ taskId: task.id, owner: 'worker-B', leaseMs: 1_000, now: workerNow() })
  const byOwner = workerStore.renewLease({ taskId: task.id, owner: 'worker-A', leaseMs: 5_000, now: workerNow() })
  return byOther === false
    && byOwner === true
    && workerStore.getTask(task.id).leaseExpiresAt === '2026-11-09T10:00:05.000Z'
})

await check('a queued task runs once to succeeded with a receipt', async () => {
  const { worker, calls } = workerFixture()
  const task = workerStore.createTask({ intent: 'happy path', riskLevel: 'R1' })
  const report = await worker.runOnce()
  const settled = workerStore.getTask(task.id)
  const receipts = workerStore.listReceipts(task.id)
  return report.taskId === task.id
    && report.outcome === 'succeeded'
    && calls.length === 1
    && settled.status === 'succeeded'
    && settled.leaseOwner === null
    && receipts.length === 1
    && receipts[0].summary === 'done'
})

await check('BK worker persists usage on the settled task', async () => {
  const { worker } = workerFixture({
    execute: () => ({
      status: 'succeeded',
      summary: 'done',
      usage: { inputTokens: 1_000, outputTokens: 200, costUsd: 0.001 },
    }),
  })
  const task = workerStore.createTask({ intent: 'usage path', riskLevel: 'R1' })
  await worker.runOnce()
  const settled = workerStore.getTask(task.id)
  return settled.status === 'succeeded'
    && settled.inputTokens === 1_000
    && settled.outputTokens === 200
    && Math.abs(settled.costUsd - 0.001) < 1e-9
})

await check('the executor sees its task id in ambient context, outside it is null', async () => {
  let seen = null
  const { worker } = workerFixture({
    execute: () => {
      seen = currentTaskId()
      return { status: 'succeeded', summary: 'ok' }
    },
  })
  const task = workerStore.createTask({ intent: 'context', riskLevel: 'R1' })
  await worker.runOnce()
  return seen === task.id && currentTaskId() === null
})

await check('the worker hands earlier same-thread results to the executor', async () => {
  const contextStore = createTaskStore(join(dir, 'worker-thread-context.sqlite'))
  const thread = 'thread-worker-context'
  const earlier = contextStore.createTask({ intent: '第一轮', riskLevel: 'R1' })
  contextStore.bindThread({ taskId: earlier.id, threadId: thread, relation: 'default_owner' })
  startTask(earlier.id, contextStore)
  contextStore.transition(earlier.id, { to: 'succeeded', summary: '第一轮已完成：写入了 hello.txt' })

  const current = contextStore.createTask({ intent: '接着改一下', riskLevel: 'R1' })
  contextStore.bindThread({ taskId: current.id, threadId: thread, relation: 'anchor', anchorMsgId: 'msg-ctx' })
  let seen = null
  const worker = createTaskWorker({
    store: contextStore,
    owner: 'worker-A',
    leaseMs: 1_000,
    heartbeatMs: 60_000,
    now: workerNow,
    execute: (claimed) => {
      seen = claimed
      return { status: 'succeeded', summary: 'done' }
    },
  })
  const report = await worker.runOnce()
  contextStore.close()
  return report.outcome === 'succeeded'
    && typeof seen?.threadContext === 'string'
    && seen.threadContext.startsWith('同线程此前已完成的任务')
    && seen.threadContext.includes('第一轮已完成：写入了 hello.txt')
    && !seen.threadContext.includes('接着改一下')
})

await check('checkpoints get increasing seq, close once, and log their phases', async () => {
  // A dedicated store: a queued task here would be claimed by later workers.
  const checkpointStore = createTaskStore(join(dir, 'checkpoints.sqlite'))
  const task = checkpointStore.createTask({ intent: 'checkpoints', riskLevel: 'R1' })
  const first = checkpointStore.beginCheckpoint({ taskId: task.id, label: 'step one' })
  const second = checkpointStore.beginCheckpoint({ taskId: task.id })
  const done = checkpointStore.closeCheckpoint(first.id, 'committed')
  let conflict = false
  try {
    checkpointStore.closeCheckpoint(first.id, 'aborted')
  } catch (error) {
    conflict = error.code === 'conflict'
  }
  const aborted = checkpointStore.closeCheckpoint(second.id, 'aborted')
  const events = checkpointStore.listEvents(task.id).filter((event) => event.type === 'task.checkpoint')
  const result = first.seq === 1 && second.seq === 2
    && first.status === 'open' && done.status === 'committed' && done.closedAt !== null
    && second.label === null && aborted.status === 'aborted'
    && conflict
    && checkpointStore.listCheckpoints(task.id).map((item) => item.status).join(',') === 'committed,aborted'
    && events.length === 4
    && events[0].payload.phase === 'opened' && events[1].payload.phase === 'opened'
    && events[2].payload.phase === 'committed' && events[3].payload.phase === 'aborted'
  checkpointStore.close()
  return result
})

await check('runWithCheckpoint nests the step and restores the outer context', async () => {
  let inside = null
  let after = null
  await runWithTaskContext(
    { taskId: 'ctx-task', projectId: null, attempt: 1, checkpointId: null },
    async () => {
      await runWithCheckpoint('cp-1', async () => {
        inside = currentCheckpointId()
      })
      after = currentCheckpointId()
    },
  )
  let outside = 'unset'
  await runWithCheckpoint('cp-2', async () => {
    outside = currentCheckpointId()
  })
  return inside === 'cp-1' && after === null && outside === null && currentTaskId() === null
})

await check('a transient failure requeues with backoff and is not re-claimable early', async () => {
  const { worker, calls } = workerFixture({
    execute: () => ({ status: 'failed', summary: 'network blip', failure: 'transient' }),
  })
  const task = workerStore.createTask({ intent: 'retry me', riskLevel: 'R1', maxAttempts: 2 })
  const first = await worker.runOnce()
  const afterFirst = workerStore.getTask(task.id)
  const tooEarly = await worker.runOnce()
  workerAdvance(1_500)
  const second = await worker.runOnce()
  const afterSecond = workerStore.getTask(task.id)
  const receipts = workerStore.listReceipts(task.id)
  const events = workerStore.listEvents(task.id).map((event) => event.type)
  return first.outcome === 'retried'
    && first.attempt === 1
    && afterFirst.status === 'queued'
    && afterFirst.leaseOwner === null
    && tooEarly.skipped === 'idle'
    && second.outcome === 'failed'
    && afterSecond.status === 'failed'
    && afterSecond.attempt === 2
    && receipts.length === 1
    && events.includes('task.retried')
    && calls.length === 0
})

await check('non-transient failures go terminal without a second attempt', async () => {
  const { worker } = workerFixture({
    execute: () => ({ status: 'failed', summary: 'no permission', failure: 'permission_denied' }),
  })
  const task = workerStore.createTask({ intent: 'denied', riskLevel: 'R1', maxAttempts: 3 })
  await worker.runOnce()
  const settled = workerStore.getTask(task.id)
  const retried = workerStore.listEvents(task.id).some((event) => event.type === 'task.retried')
  return settled.status === 'failed'
    && settled.attempt === 1
    && retried === false
})

await check('a thrown executor error is classified from its kind', async () => {
  const { worker } = workerFixture({
    execute: () => {
      const error = new Error('port timeout')
      error.kind = 'transient'
      throw error
    },
  })
  const task = workerStore.createTask({ intent: 'throws', riskLevel: 'R1', maxAttempts: 3 })
  const report = await worker.runOnce()
  const row = workerStore.getTask(task.id)
  return report.outcome === 'retried'
    && report.failure === 'transient'
    && row.status === 'queued'
})

await check('R3 without a snapshot port is refused before the executor runs', async () => {
  const { worker, calls } = workerFixture()
  const task = workerStore.createTask({ intent: 'r3 no snapshot', riskLevel: 'R3' })
  const report = await worker.runOnce()
  const row = workerStore.getTask(task.id)
  return report.outcome === 'failed'
    && report.skipped === 'snapshot-refused'
    && calls.length === 0
    && row.status === 'failed'
})

await check('a failed snapshot refuses execution and records the snapshot event only on success', async () => {
  const { worker: failing, calls } = workerFixture({
    snapshot: {
      capture: () => {
        throw new Error('baseline mismatch')
      },
    },
  })
  const refused = workerStore.createTask({ intent: 'r3 bad snapshot', riskLevel: 'R3' })
  const refusedReport = await failing.runOnce()
  const refusedRow = workerStore.getTask(refused.id)
  const refusedReceipt = workerStore.listReceipts(refused.id)

  const okWorker = workerFixture({ snapshot: { capture: () => ({ snapshotId: 'snap_1', baselineRef: 'HEAD' }) } })
  const allowed = workerStore.createTask({ intent: 'r3 good snapshot', riskLevel: 'R3' })
  // R3 requires executable criteria (17 §8.4): the Verifier now gates success,
  // so a passing assertion is mandatory or completion would be refused.
  const marker = join(dir, 'r3-marker.txt')
  writeFileSync(marker, 'ok')
  for (const prepared of prepareAssertions([{ kind: 'file_exists', path: marker }])) {
    workerStore.addAssertion(allowed.id, prepared)
  }
  const allowedReport = await okWorker.worker.runOnce()
  const allowedRow = workerStore.getTask(allowed.id)
  const allowedVerified = workerStore.listEvents(allowed.id).find((event) => event.type === 'task.verified')
  const snapshotEvent = workerStore.listEvents(allowed.id).find((event) => event.type === 'task.snapshot')
  return refusedReport.skipped === 'snapshot-refused'
    && calls.length === 0
    && refusedRow.status === 'failed'
    && refusedReceipt.length === 1
    && refusedReceipt[0].summary.includes('baseline mismatch')
    && allowedReport.outcome === 'succeeded'
    && allowedRow.status === 'succeeded'
    && allowedVerified?.payload.overall === 'pass'
    && snapshotEvent !== undefined
    && snapshotEvent.payload.snapshotId === 'snap_1'
})

// ---- Slice AV: ⑤ 的变更台账（R2/R3 begin → keep / markFailed） ----------------

/** 结构替身：只记状态，不引入 `@dsh-wfxm/changes`（AR32）。 */
function fakeChangePort(options = {}) {
  const rows = new Map()
  const calls = []
  return {
    rows,
    calls,
    begin(input) {
      calls.push(['begin', input])
      if (options.refuseBegin === true) return { ok: false, code: 'invalid-input' }
      if (!rows.has(input.taskId)) rows.set(input.taskId, { ...input, status: 'applying' })
      return { ok: true }
    },
    keep(input) {
      calls.push(['keep', input])
      const row = rows.get(input.taskId)
      if (row === undefined || row.status !== 'applying') return { ok: false, code: 'invalid-transition' }
      row.status = 'kept'
      return { ok: true }
    },
    markFailed(input) {
      calls.push(['markFailed', input])
      const row = rows.get(input.taskId)
      if (row === undefined || row.status !== 'applying') return { ok: false, code: 'invalid-transition' }
      row.status = 'failed'
      return { ok: true }
    },
  }
}

await check('an R2 success opens the ledger before running and keeps it after verification', async () => {
  const ledger = fakeChangePort()
  const store = createTaskStore(join(dir, 'changes-r2.sqlite'))
  const marker = join(dir, 'changes-r2-marker.txt')
  writeFileSync(marker, 'ok')
  const task = store.createTask({ intent: 'r2 change', riskLevel: 'R2' })
  // R2 cannot complete without criteria (17 §8.4).
  for (const prepared of prepareAssertions([{ kind: 'file_exists', path: marker }])) {
    store.addAssertion(task.id, prepared)
  }
  const worker = createTaskWorker({
    store,
    owner: 'worker-A',
    leaseMs: 1_000,
    heartbeatMs: 60_000,
    now: workerNow,
    changes: ledger,
    execute: () => ({ status: 'succeeded', summary: 'wrote app.conf' }),
  })
  const report = await worker.runOnce()
  const row = ledger.rows.get(task.id)
  store.close()
  return report.outcome === 'succeeded'
    && row?.status === 'kept'
    && row?.kind === 'task'
    && row?.snapshotId === null
    && ledger.calls.filter(([action]) => action === 'begin').length === 1
})

await check('an R3 ledger row records the snapshot id taken before execution', async () => {
  const ledger = fakeChangePort()
  const store = createTaskStore(join(dir, 'changes-r3.sqlite'))
  const marker = join(dir, 'changes-r3-marker.txt')
  writeFileSync(marker, 'ok')
  const task = store.createTask({ intent: 'r3 change', riskLevel: 'R3' })
  for (const prepared of prepareAssertions([{ kind: 'file_exists', path: marker }])) {
    store.addAssertion(task.id, prepared)
  }
  const worker = createTaskWorker({
    store,
    owner: 'worker-A',
    leaseMs: 1_000,
    heartbeatMs: 60_000,
    now: workerNow,
    changes: ledger,
    snapshot: { capture: () => ({ snapshotId: 'snap_av', baselineRef: 'HEAD' }) },
    execute: () => ({ status: 'succeeded', summary: 'restarted the unit' }),
  })
  const report = await worker.runOnce()
  const row = ledger.rows.get(task.id)
  store.close()
  return report.outcome === 'succeeded' && row?.snapshotId === 'snap_av' && row?.status === 'kept'
})

await check('a terminal failure marks the ledger row failed (rollback stays a startup decision)', async () => {
  const ledger = fakeChangePort()
  const store = createTaskStore(join(dir, 'changes-failed.sqlite'))
  const worker = createTaskWorker({
    store,
    owner: 'worker-A',
    leaseMs: 1_000,
    heartbeatMs: 60_000,
    now: workerNow,
    changes: ledger,
    execute: () => ({ status: 'failed', summary: 'no permission', failure: 'permission_denied' }),
  })
  const task = store.createTask({ intent: 'r2 denied', riskLevel: 'R2', maxAttempts: 3 })
  const report = await worker.runOnce()
  const row = ledger.rows.get(task.id)
  store.close()
  return report.outcome === 'failed'
    && row?.status === 'failed'
    && ledger.calls.some(([action]) => action === 'markFailed')
})

await check('a retry re-uses the same ledger row and keeps it only when the retry succeeds', async () => {
  const ledger = fakeChangePort()
  const store = createTaskStore(join(dir, 'changes-retry.sqlite'))
  const marker = join(dir, 'changes-retry-marker.txt')
  writeFileSync(marker, 'ok')
  const task = store.createTask({ intent: 'r2 flaky', riskLevel: 'R2', maxAttempts: 2 })
  for (const prepared of prepareAssertions([{ kind: 'file_exists', path: marker }])) {
    store.addAssertion(task.id, prepared)
  }
  let attempt = 0
  const worker = createTaskWorker({
    store,
    owner: 'worker-A',
    leaseMs: 1_000,
    heartbeatMs: 60_000,
    now: workerNow,
    backoffMs: [1_000],
    changes: ledger,
    execute: () => {
      attempt += 1
      return attempt === 1
        ? { status: 'failed', summary: 'flaky', failure: 'transient' }
        : { status: 'succeeded', summary: 'second try worked' }
    },
  })
  const first = await worker.runOnce()
  const midStatus = ledger.rows.get(task.id)?.status
  workerAdvance(1_500)
  const second = await worker.runOnce()
  const row = ledger.rows.get(task.id)
  const beginCalls = ledger.calls.filter(([action]) => action === 'begin').length
  store.close()
  return first.outcome === 'retried'
    && midStatus === 'applying'
    && second.outcome === 'succeeded'
    && row?.status === 'kept'
    && beginCalls === 2
    && ledger.rows.size === 1
})

await check('a refused ledger refuses execution instead of writing without a record', async () => {
  const ledger = fakeChangePort({ refuseBegin: true })
  const store = createTaskStore(join(dir, 'changes-refused.sqlite'))
  const calls = []
  const worker = createTaskWorker({
    store,
    owner: 'worker-A',
    leaseMs: 1_000,
    heartbeatMs: 60_000,
    now: workerNow,
    changes: ledger,
    execute: (claimed) => {
      calls.push(claimed.id)
      return { status: 'succeeded', summary: 'should never run' }
    },
  })
  const task = store.createTask({ intent: 'r2 unrecorded', riskLevel: 'R2' })
  const report = await worker.runOnce()
  const row = store.getTask(task.id)
  const failedEvent = store.listEvents(task.id).find((event) => event.type === 'task.failed')
  store.close()
  return report.outcome === 'failed'
    && report.skipped === 'change-refused'
    && calls.length === 0
    && row.status === 'failed'
    && failedEvent?.payload.reason === 'change-record-failed'
})

await check('without a change port R2 behaves exactly as before (no rows, no refusals)', async () => {
  const store = createTaskStore(join(dir, 'changes-null.sqlite'))
  const marker = join(dir, 'changes-null-marker.txt')
  writeFileSync(marker, 'ok')
  const worker = createTaskWorker({
    store,
    owner: 'worker-A',
    leaseMs: 1_000,
    heartbeatMs: 60_000,
    now: workerNow,
    execute: () => ({ status: 'succeeded', summary: 'legacy path' }),
  })
  const task = store.createTask({ intent: 'r2 no ledger', riskLevel: 'R2' })
  for (const prepared of prepareAssertions([{ kind: 'file_exists', path: marker }])) {
    store.addAssertion(task.id, prepared)
  }
  const report = await worker.runOnce()
  store.close()
  return report.outcome === 'succeeded' && report.skipped === null
})

await check('an executor claiming success is still gated by a failing assertion', async () => {
  // Dedicated store: unrelated queued rows on `workerStore` would be claimed.
  const verifierStore = createTaskStore(join(dir, 'verifier-fail.sqlite'))
  const missing = join(dir, 'never-created.txt')
  const task = verifierStore.createTask({ intent: 'claims success', riskLevel: 'R2' })
  for (const prepared of prepareAssertions([{ kind: 'file_exists', path: missing }])) {
    verifierStore.addAssertion(task.id, prepared)
  }
  const worker = createTaskWorker({
    store: verifierStore,
    owner: 'worker-A',
    leaseMs: 1_000,
    heartbeatMs: 60_000,
    now: workerNow,
    execute: () => ({ status: 'succeeded', summary: 'the model says it wrote the file' }),
  })
  const report = await worker.runOnce()
  const row = verifierStore.getTask(task.id)
  const receipt = verifierStore.listReceipts(task.id)
  const verified = verifierStore.listEvents(task.id).find((event) => event.type === 'task.verified')
  const failedEvent = verifierStore.listEvents(task.id).filter((event) => event.payload?.to === 'failed').pop()
  const retried = verifierStore.listEvents(task.id).some((event) => event.type === 'task.retried')
  verifierStore.close()
  return report.outcome === 'failed'
    && report.failure === 'unknown'
    && row.status === 'failed'
    && failedEvent?.payload.reason === 'verification-failed'
    && verified?.payload.overall === 'fail'
    && receipt.length === 1
    && receipt[0].summary.includes('assertion')
    && retried === false
})

await check('R2 without assertions can no longer reach succeeded', async () => {
  const verifierStore = createTaskStore(join(dir, 'verifier-criteria.sqlite'))
  const task = verifierStore.createTask({ intent: 'no criteria', riskLevel: 'R2' })
  const worker = createTaskWorker({
    store: verifierStore,
    owner: 'worker-A',
    leaseMs: 1_000,
    heartbeatMs: 60_000,
    now: workerNow,
    execute: () => ({ status: 'succeeded', summary: 'done' }),
  })
  const report = await worker.runOnce()
  const row = verifierStore.getTask(task.id)
  const failedEvent = verifierStore.listEvents(task.id).filter((event) => event.payload?.to === 'failed').pop()
  verifierStore.close()
  return report.outcome === 'failed'
    && row.status === 'failed'
    && failedEvent?.payload.reason === 'criteria-required'
})

await check('mail_archived passes/fails/skips on the read-only Mail probe', async () => {
  const pass = await evaluateAssertion(
    { kind: 'mail_archived', spec: { minCount: 1 } },
    { mailFolderCount: async () => ({ folder: 'Archive', count: 2 }) },
  )
  const empty = await evaluateAssertion(
    { kind: 'mail_archived', spec: { minCount: 1 } },
    { mailFolderCount: async () => ({ folder: 'Archive', count: 0 }) },
  )
  const unavailable = await evaluateAssertion(
    { kind: 'mail_archived', spec: { folder: 'Archive', minCount: 1 } },
    { mailFolderCount: async () => null },
  )
  const noAdapter = await evaluateAssertion({ kind: 'mail_archived', spec: { minCount: 1 } })
  const seen = []
  await evaluateAssertion(
    { kind: 'mail_archived', spec: { folder: '已归档', minCount: 1 } },
    { mailFolderCount: async (folder) => { seen.push(folder); return { folder, count: 1 } } },
  )
  return pass.status === 'pass'
    && pass.evidence.observed === 2
    && empty.status === 'fail'
    && unavailable.status === 'skipped'
    && unavailable.evidence.transient === true
    && noAdapter.status === 'skipped'
    && seen[0] === '已归档'
})

await check('mail_sent / mail_drafted use the Sent/Drafts purpose and pass/fail/skip', async () => {
  const seen = []
  const pass = await evaluateAssertion(
    { kind: 'mail_sent', spec: { minCount: 1 } },
    {
      mailFolderCount: async (folder, purpose) => {
        seen.push([folder, purpose])
        return { folder: 'Sent', count: 3 }
      },
    },
  )
  const empty = await evaluateAssertion(
    { kind: 'mail_drafted', spec: { minCount: 1 } },
    { mailFolderCount: async () => ({ folder: 'Drafts', count: 0 }) },
  )
  const unavailable = await evaluateAssertion(
    { kind: 'mail_sent', spec: { minCount: 1 } },
    { mailFolderCount: async () => null },
  )
  const noAdapter = await evaluateAssertion({ kind: 'mail_drafted', spec: { minCount: 1 } })
  return pass.status === 'pass' && pass.evidence.folder === 'Sent'
    && empty.status === 'fail'
    && unavailable.status === 'skipped' && unavailable.evidence.transient === true
    && noAdapter.status === 'skipped'
    && seen[0][0] === null && seen[0][1] === 'sent'
})

await check('calendar_event counts a future window and skips without an adapter', async () => {
  const windows = []
  const pass = await evaluateAssertion(
    { kind: 'calendar_event', spec: { minCount: 1, windowDays: 7 } },
    {
      calendarEventCount: async (windowDays) => {
        windows.push(windowDays)
        return 2
      },
    },
  )
  const empty = await evaluateAssertion(
    { kind: 'calendar_event', spec: { minCount: 1, windowDays: 7 } },
    { calendarEventCount: async () => 0 },
  )
  const unavailable = await evaluateAssertion(
    { kind: 'calendar_event', spec: { minCount: 1, windowDays: 7 } },
    { calendarEventCount: async () => null },
  )
  const noAdapter = await evaluateAssertion({ kind: 'calendar_event', spec: { minCount: 1, windowDays: 7 } })
  return pass.status === 'pass' && pass.evidence.observed === 2
    && empty.status === 'fail'
    && unavailable.status === 'skipped' && unavailable.evidence.transient === true
    && noAdapter.status === 'skipped'
    && windows[0] === 7
})

await check('R2 mail archive completes only when the Mail probe is mounted', async () => {
  const archiveStore = createTaskStore(join(dir, 'verifier-mail.sqlite'))
  const task = archiveStore.createTask({ intent: 'archive mail', riskLevel: 'R2' })
  for (const prepared of prepareAssertions([{ kind: 'mail_archived' }])) {
    archiveStore.addAssertion(task.id, prepared)
  }
  const worker = createTaskWorker({
    store: archiveStore,
    owner: 'worker-A',
    leaseMs: 1_000,
    heartbeatMs: 60_000,
    now: workerNow,
    verify: { mailFolderCount: async () => ({ folder: 'Archive', count: 3 }) },
    execute: () => ({ status: 'succeeded', summary: 'archived 1 mail' }),
  })
  const report = await worker.runOnce()
  const row = archiveStore.getTask(task.id)

  const bareStore = createTaskStore(join(dir, 'verifier-mail-bare.sqlite'))
  const bare = bareStore.createTask({ intent: 'archive mail', riskLevel: 'R2' })
  for (const prepared of prepareAssertions([{ kind: 'mail_archived' }])) {
    bareStore.addAssertion(bare.id, prepared)
  }
  const bareWorker = createTaskWorker({
    store: bareStore,
    owner: 'worker-A',
    leaseMs: 1_000,
    heartbeatMs: 60_000,
    now: workerNow,
    execute: () => ({ status: 'succeeded', summary: 'archived 1 mail' }),
  })
  const bareReport = await bareWorker.runOnce()
  const bareRow = bareStore.getTask(bare.id)
  archiveStore.close()
  bareStore.close()
  return report.outcome === 'succeeded'
    && row.status === 'succeeded'
    && bareReport.outcome === 'failed'
    && bareRow.status === 'failed'
})

await check('expired leases are reclaimed: requeue while attempts remain, fail with receipt when exhausted', () => {
  // A dedicated store keeps unrelated queued rows from being claimed first.
  const leaseStore = createTaskStore(join(dir, 'lease.sqlite'))
  const retryable = leaseStore.createTask({ intent: 'lease expired', riskLevel: 'R1', maxAttempts: 2 })
  const exhausted = leaseStore.createTask({ intent: 'lease dead', riskLevel: 'R1', maxAttempts: 1 })
  const claimed = leaseStore.claimTask({ owner: 'worker-A', leaseMs: 100, now: workerNow() })
  const claimedAgain = leaseStore.claimTask({ owner: 'worker-A', leaseMs: 100, now: workerNow() })
  workerAdvance(500)
  const first = leaseStore.recoverExpiredLeases({ now: workerNow() })
  const retryableRow = leaseStore.getTask(retryable.id)
  const exhaustedRow = leaseStore.getTask(exhausted.id)
  const receipts = leaseStore.listReceipts(exhausted.id)
  leaseStore.close()
  return claimed.id === retryable.id
    && claimedAgain.id === exhausted.id
    && retryableRow.status === 'queued'
    && retryableRow.leaseOwner === null
    && exhaustedRow.status === 'failed'
    && receipts.length === 1
    && first.requeued.includes(retryable.id)
    && first.failed.includes(exhausted.id)
})

await check('worker.cancel aborts the active attempt and skips settlement', async () => {
  const cancelStore = createTaskStore(join(dir, 'cancel.sqlite'))
  let started = null
  const worker = createTaskWorker({
    store: cancelStore,
    owner: 'worker-A',
    leaseMs: 30_000,
    heartbeatMs: 60_000,
    now: workerNow,
    execute: (task, hooks) => new Promise((resolve) => {
      started = task.id
      hooks.signal?.addEventListener(
        'abort',
        () => resolve({ status: 'failed', failure: 'conflict', summary: 'cancelled by owner' }),
        { once: true },
      )
    }),
  })
  const task = cancelStore.createTask({ intent: 'cancel me', riskLevel: 'R1' })
  const running = worker.runOnce()
  for (let i = 0; i < 200 && started === null; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  const cancelled = worker.cancel(task.id)
  const missing = worker.cancel('no-such-task')
  // Same order as host's control(): abort the child, then flip the row.
  const row = cancelStore.transition(task.id, {
    to: 'cancelled',
    summary: 'stopped by owner',
    reason: 'control:cancel',
  })
  const eventsAfterCancel = cancelStore.listEvents(task.id).length
  const report = await running
  const events = cancelStore.listEvents(task.id)
  const receipts = cancelStore.listReceipts(task.id)
  const settled = cancelStore.getTask(task.id)
  cancelStore.close()
  return started === task.id
    && cancelled === true
    && missing === false
    && row.status === 'cancelled'
    && report.taskId === task.id
    && report.outcome === 'skipped'
    && report.skipped === 'cancelled'
    && report.failure === null
    && settled.status === 'cancelled'
    && events.length === eventsAfterCancel
    && !events.some((event) => event.type === 'task.completed')
    // The control transition owns the one `task.receipt`; settling would add
    // a second one.
    && receipts.length === 1
    && events.filter((event) => event.type === 'task.receipt').length === 1
})

await check('worker skips settlement when the watchdog paused the attempt', async () => {
  const pauseStore = createTaskStore(join(dir, 'pause-skip.sqlite'))
  let started = null
  const worker = createTaskWorker({
    store: pauseStore,
    owner: 'worker-A',
    leaseMs: 30_000,
    heartbeatMs: 60_000,
    now: workerNow,
    execute: (task, hooks) => new Promise((resolve) => {
      started = task.id
      hooks.signal?.addEventListener(
        'abort',
        () => resolve({ status: 'failed', failure: 'conflict', summary: 'paused by watchdog' }),
        { once: true },
      )
    }),
  })
  const task = pauseStore.createTask({ intent: 'pause me', riskLevel: 'R1' })
  const running = worker.runOnce()
  for (let i = 0; i < 200 && started === null; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  worker.cancel(task.id)
  // Same order as the host watchdog: abort the child, then flip the row.
  const paused = pauseStore.transition(task.id, { to: 'paused', reason: 'watchdog:stalled' })
  const eventsAfterPause = pauseStore.listEvents(task.id).length
  const report = await running
  const events = pauseStore.listEvents(task.id)
  const receipts = pauseStore.listReceipts(task.id)
  const settled = pauseStore.getTask(task.id)
  pauseStore.close()
  return started === task.id
    && paused.status === 'paused'
    && report.outcome === 'skipped'
    && report.skipped === 'paused'
    && report.failure === null
    && settled.status === 'paused'
    && events.length === eventsAfterPause
    && !events.some((event) => event.type === 'task.completed' || event.type === 'task.failed')
    && receipts.length === 0
})

await check('resumeTask re-queues a paused task with a fresh attempt budget', () => {
  const resumeStore = createTaskStore(join(dir, 'resume.sqlite'))
  const task = resumeStore.createTask({ intent: 'resume me', riskLevel: 'R1' })
  const claimed = resumeStore.claimTask({ owner: 'worker-A', leaseMs: 60_000, now: workerNow() })
  resumeStore.transition(task.id, { to: 'paused', reason: 'watchdog:stalled' })
  const paused = resumeStore.getTask(task.id)
  const resumed = resumeStore.resumeTask(task.id)
  const event = resumeStore.listEvents(task.id)
    .filter((item) => item.type === 'task.resumed')
    .pop()
  // The lease, wake time and attempt budget are gone: the next claim is immediate.
  const reclaimed = resumeStore.claimTask({ owner: 'worker-B', leaseMs: 60_000, now: workerNow() })
  resumeStore.close()
  return claimed.id === task.id
    && paused.status === 'paused'
    && paused.attempt === 1
    && resumed.status === 'queued'
    && resumed.attempt === 0
    && resumed.leaseOwner === null
    && resumed.leaseExpiresAt === null
    && resumed.startedAt === null
    && event !== undefined
    && event.payload.from === 'paused'
    && event.payload.to === 'queued'
    && event.payload.reason === 'control:resume'
    && reclaimed?.id === task.id
    && reclaimed.attempt === 1
})

await check('resumeTask refuses a task that is not paused', () => {
  const resumeStore = createTaskStore(join(dir, 'resume-running.sqlite'))
  const task = resumeStore.createTask({ intent: 'still running', riskLevel: 'R1' })
  resumeStore.claimTask({ owner: 'worker-A', leaseMs: 60_000, now: workerNow() })
  assert.throws(
    () => resumeStore.resumeTask(task.id),
    (error) => error instanceof TaskError && error.code === 'invalid-transition',
  )
  resumeStore.close()
  return true
})

// ---- Slice I: approval gate (hold → approve → resume, reject stays parked) -----

await check('holdForApproval parks a queued task and records the event', () => {
  const gateStore = createTaskStore(join(dir, 'gate-hold.sqlite'))
  const task = gateStore.createTask({ intent: 'restart nginx', riskLevel: 'R2' })
  const held = gateStore.holdForApproval({ taskId: task.id, reason: 'risk:R2' })
  const event = gateStore.listEvents(task.id).find((item) => item.type === 'task.waiting_approval')
  gateStore.close()
  return held.status === 'waiting_approval'
    && held.attempt === 0
    && held.leaseOwner === null
    && event !== undefined
    && event.payload.from === 'queued'
    && event.payload.to === 'waiting_approval'
    && event.payload.reason === 'risk:R2'
})

await check('holding a task that is not queued is refused; unknown id is NotFound', () => {
  const gateStore = createTaskStore(join(dir, 'gate-hold-conflict.sqlite'))
  const task = gateStore.createTask({ intent: 'already running', riskLevel: 'R2' })
  startTask(task.id, gateStore)
  assert.throws(
    () => gateStore.holdForApproval({ taskId: task.id }),
    (error) => error instanceof TaskError && error.code === 'conflict',
  )
  assert.throws(
    () => gateStore.holdForApproval({ taskId: 'missing' }),
    (error) => error instanceof TaskError && error.code === 'not-found',
  )
  gateStore.close()
  return true
})

await check('a held task is invisible to the worker until it is resumed', async () => {
  const gateStore = createTaskStore(join(dir, 'gate-worker.sqlite'))
  const task = gateStore.createTask({ intent: 'waits for approval', riskLevel: 'R2' })
  gateStore.holdForApproval({ taskId: task.id })
  // R2 completion needs executable criteria; this test is about the gate only.
  for (const prepared of prepareAssertions([{ kind: 'file_exists', path: fixturePath }])) {
    gateStore.addAssertion(task.id, prepared)
  }
  const calls = []
  const worker = createTaskWorker({
    store: gateStore,
    owner: 'worker-A',
    leaseMs: 1_000,
    heartbeatMs: 60_000,
    now: workerNow,
    execute: (claimed) => {
      calls.push(claimed.id)
      return { status: 'succeeded', summary: 'done' }
    },
  })
  const skipped = await worker.runOnce()
  const stillHeld = gateStore.getTask(task.id)
  const resumed = gateStore.resumeFromApproval({
    taskId: task.id,
    approvalId: 'ap_1',
    actorId: 'owner-1',
    now: workerNow(),
  })
  const ranAfter = await worker.runOnce()
  const done = gateStore.getTask(task.id)
  const resumeEvent = gateStore.listEvents(task.id).find((item) => item.type === 'task.resumed')
  gateStore.close()
  return skipped.outcome === 'skipped'
    && skipped.skipped === 'idle'
    && stillHeld.status === 'waiting_approval'
    && calls.length === 1
    && resumed.resumed === true
    && resumed.task.status === 'queued'
    && resumed.task.attempt === 0
    && resumeEvent !== undefined
    && resumeEvent.payload.approvalId === 'ap_1'
    && resumeEvent.payload.actorId === 'owner-1'
    && ranAfter.taskId === task.id
    && done.status === 'succeeded'
})

await check('a second resume is a no-op; an unknown task reports NotFound', () => {
  const gateStore = createTaskStore(join(dir, 'gate-resume-twice.sqlite'))
  const task = gateStore.createTask({ intent: 'resume twice', riskLevel: 'R2' })
  gateStore.holdForApproval({ taskId: task.id })
  const first = gateStore.resumeFromApproval({ taskId: task.id, approvalId: 'ap_1' })
  const second = gateStore.resumeFromApproval({ taskId: task.id, approvalId: 'ap_1' })
  const missing = gateStore.resumeFromApproval({ taskId: 'missing', approvalId: 'ap_1' })
  const resumes = gateStore.listEvents(task.id).filter((item) => item.type === 'task.resumed')
  gateStore.close()
  return first.resumed === true
    && second.resumed === false
    && second.reason === 'not-waiting'
    && second.task.status === 'queued'
    && missing.resumed === false
    && missing.reason === 'not-found'
    && missing.task === null
    && resumes.length === 1
})

// ---- L2 risk grant: only a matching human approval becomes an exemption ----

await check('an approval grants its level only when it matches the task risk', () => {
  const grantStore = createTaskStore(join(dir, 'grant-match.sqlite'))
  try {
    const matching = grantStore.createTask({ intent: 'approved R2 task', riskLevel: 'R2' })
    grantStore.holdForApproval({ taskId: matching.id })
    const granted = grantStore.resumeFromApproval({
      taskId: matching.id,
      approvalId: 'ap_match',
      approvedLevel: 'R2',
    })
    const grantEvent = grantStore
      .listEvents(matching.id)
      .find((item) => item.type === 'task.resumed')

    const mismatched = grantStore.createTask({ intent: 'approval for another level', riskLevel: 'R2' })
    grantStore.holdForApproval({ taskId: mismatched.id })
    const notGranted = grantStore.resumeFromApproval({
      taskId: mismatched.id,
      approvalId: 'ap_mismatch',
      approvedLevel: 'R3',
    })

    const bare = grantStore.createTask({ intent: 'no level supplied', riskLevel: 'R2' })
    grantStore.holdForApproval({ taskId: bare.id })
    const ungranted = grantStore.resumeFromApproval({ taskId: bare.id, approvalId: 'ap_bare' })

    // Re-entering the gate drops a grant that is no longer the current decision.
    const reheld = grantStore.holdForApproval({ taskId: matching.id })

    return granted.resumed === true
      && granted.task.approvedLevel === 'R2'
      && grantEvent?.payload.approvedLevel === 'R2'
      && notGranted.resumed === true
      && notGranted.task.approvedLevel === null
      && ungranted.resumed === true
      && ungranted.task.approvedLevel === null
      && reheld.status === 'waiting_approval'
      && reheld.approvedLevel === null
  } finally {
    grantStore.close()
  }
})

await check('steer and wake revoke an existing grant', () => {
  const revokeStore = createTaskStore(join(dir, 'grant-revoke.sqlite'))
  try {
    const steered = revokeStore.createTask({ intent: 'R2 work', riskLevel: 'R2' })
    revokeStore.holdForApproval({ taskId: steered.id })
    revokeStore.resumeFromApproval({
      taskId: steered.id,
      approvalId: 'ap_steer',
      approvedLevel: 'R2',
    })
    const input = revokeStore.enqueueInput({ taskId: steered.id, inboxId: 'inbox-grant-1' })
    const steerResult = revokeStore.steerTask({
      taskId: steered.id,
      inputId: input.id,
      text: '换个目录',
    })

    const woken = revokeStore.createTask({ intent: 'R2 round one', riskLevel: 'R2' })
    revokeStore.bindThread({
      taskId: woken.id,
      threadId: 'thread-grant-wake',
      relation: 'default_owner',
    })
    revokeStore.holdForApproval({ taskId: woken.id })
    revokeStore.resumeFromApproval({
      taskId: woken.id,
      approvalId: 'ap_wake',
      approvedLevel: 'R2',
    })
    const grantedBeforeRun = revokeStore.getTask(woken.id).approvedLevel
    startTask(woken.id, revokeStore)
    revokeStore.transition(woken.id, { to: 'succeeded', summary: 'round one done' })
    const afterWake = revokeStore.wakeTask({ taskId: woken.id })

    return steerResult.applied === 'merged'
      && steerResult.task.approvedLevel === null
      && grantedBeforeRun === 'R2'
      && afterWake.status === 'queued'
      && afterWake.approvedLevel === null
  } finally {
    revokeStore.close()
  }
})

// ---- verifier: built-in probes ----------------------------------------------

await check('file_exists passes on a real file and records evidence', async () => {
  const outcome = await evaluateAssertion({ kind: 'file_exists', spec: { path: fixturePath } })
  return outcome.status === 'pass' && outcome.evidence.observed === 'present'
})

await check('file_exists sha256 mismatch fails', async () => {
  const outcome = await evaluateAssertion({
    kind: 'file_exists',
    spec: { path: fixturePath, sha256: '0'.repeat(64) },
  })
  return outcome.status === 'fail' && outcome.evidence.expected === '0'.repeat(64)
})

await check('file_exists sha256 match passes', async () => {
  const outcome = await evaluateAssertion({
    kind: 'file_exists',
    spec: { path: fixturePath, sha256: fixtureSha },
  })
  return outcome.status === 'pass' && outcome.evidence.observed === fixtureSha
})

await check('missing file fails (not skipped)', async () => {
  const outcome = await evaluateAssertion({
    kind: 'file_exists',
    spec: { path: join(dir, 'absent.conf') },
  })
  return outcome.status === 'fail' && outcome.evidence.observed === 'missing'
})

await check('exit_code reads recorded evidence; absent evidence is skipped', async () => {
  const pass = await evaluateAssertion({ kind: 'exit_code', spec: { expected: 0 } }, { execExitCode: 0 })
  const failed = await evaluateAssertion({ kind: 'exit_code', spec: { expected: 0 } }, { execExitCode: 2 })
  const skipped = await evaluateAssertion({ kind: 'exit_code', spec: { expected: 0 } })
  return pass.status === 'pass' && failed.status === 'fail' && skipped.status === 'skipped'
})

const httpServer = createServer((request, response) => {
  if (request.url?.startsWith('/health')) {
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end('ok')
    return
  }
  response.writeHead(404)
  response.end()
})
await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
const livePort = httpServer.address().port

await check('port_listening passes on a live port and fails on a closed one', async () => {
  const open = await evaluateAssertion({ kind: 'port_listening', spec: { host: '127.0.0.1', port: livePort } })
  const closedServer = createServer()
  await new Promise((resolve) => closedServer.listen(0, '127.0.0.1', resolve))
  const closedPort = closedServer.address().port
  await new Promise((resolve) => closedServer.close(resolve))
  const closed = await evaluateAssertion({ kind: 'port_listening', spec: { host: '127.0.0.1', port: closedPort } })
  return open.status === 'pass' && open.evidence.observed === 'open'
    && closed.status === 'fail' && closed.evidence.observed === 'closed'
})

await check('http_status compares the real response code and redacts the URL', async () => {
  const url = `http://127.0.0.1:${livePort}/health?token=supersecretvalue123`
  const pass = await evaluateAssertion({ kind: 'http_status', spec: { url, expected: 200 } })
  const wrong = await evaluateAssertion({
    kind: 'http_status',
    spec: { url: `http://127.0.0.1:${livePort}/nope`, expected: 200 },
  })
  if (pass.status !== 'pass' || wrong.status !== 'fail') return false
  if (wrong.evidence.observed !== 404) return false

  // Redaction happens on the write path (verifyTask), never on the raw probe.
  const task = (await submit({
    intent: 'redact the health URL',
    riskLevel: 'R2',
    assertions: [{ kind: 'http_status', url, expected: 200 }],
  })).task
  startTask(task.id)
  await verifyTask(store, task.id)
  const stored = store.listAssertions(task.id)[0]
  const storedUrl = String(stored.evidence.url)
  return stored.status === 'pass'
    && storedUrl.includes('[redacted:')
    && !storedUrl.includes('supersecretvalue123')
})

await check('service_active and page_contains stay skipped without adapters', async () => {
  const service = await evaluateAssertion({ kind: 'service_active', spec: { unit: 'nginx.service' } })
  const page = await evaluateAssertion({
    kind: 'page_contains',
    spec: { url: `http://127.0.0.1:${livePort}/health`, selector: '.ok', expect: 'ok' },
  })
  return service.status === 'skipped' && page.status === 'skipped'
})

await check('service_active honours the injected SvcOps adapter', async () => {
  const context = { serviceStatus: async (unit) => (unit === 'nginx.service' ? 'active' : 'inactive') }
  const active = await evaluateAssertion({ kind: 'service_active', spec: { unit: 'nginx.service' } }, context)
  const inactive = await evaluateAssertion({ kind: 'service_active', spec: { unit: 'other.service' } }, context)
  return active.status === 'pass' && inactive.status === 'fail'
})

await check('unit_restarted compares the unit against task start', async () => {
  const context = {
    taskStartedAt: '2026-11-13T08:00:00.000Z',
    unitState: async () => ({ activeState: 'active', activeEnteredAtMs: Date.parse('2026-11-13T07:00:00.000Z') }),
  }
  const stale = await evaluateAssertion({ kind: 'unit_restarted', spec: { unit: 'nginx.service' } }, context)
  const fresh = await evaluateAssertion({ kind: 'unit_restarted', spec: { unit: 'nginx.service' } }, {
    ...context,
    unitState: async () => ({ activeState: 'active', activeEnteredAtMs: Date.parse('2026-11-13T08:00:05.000Z') }),
  })
  return stale.status === 'fail' && fresh.status === 'pass'
})

await check('unit_restarted stays skipped without adapter, baseline or observation', async () => {
  const noAdapter = await evaluateAssertion({
    kind: 'unit_restarted', spec: { unit: 'nginx.service' },
  }, { taskStartedAt: '2026-11-13T08:00:00.000Z' })
  const noBaseline = await evaluateAssertion({ kind: 'unit_restarted', spec: { unit: 'nginx.service' } }, {
    unitState: async () => ({ activeState: 'active', activeEnteredAtMs: Date.now() }),
  })
  const unknown = await evaluateAssertion({ kind: 'unit_restarted', spec: { unit: 'nginx.service' } }, {
    taskStartedAt: '2026-11-13T08:00:00.000Z',
    unitState: async () => ({ activeState: 'unknown', activeEnteredAtMs: null }),
  })
  return noAdapter.status === 'skipped' && noBaseline.status === 'skipped' && unknown.status === 'skipped'
})

await check('a transient failure is retested exactly once', async () => {
  const task = (await submit({
    intent: 'flaky page probe',
    riskLevel: 'R2',
    assertions: [{
      kind: 'page_contains',
      url: `http://127.0.0.1:${livePort}/health`,
      selector: '.ok',
      expect: 'ok',
    }],
  })).task
  startTask(task.id)
  let calls = 0
  const result = await verifyTask(store, task.id, {
    browserContains: async () => {
      calls += 1
      return calls === 1 ? null : true
    },
  })
  const stored = store.listAssertions(task.id)[0]
  return result.overall === 'pass'
    && stored.status === 'pass'
    && stored.evidence.retried === true
    && calls === 2
})

// ---- verifier: git ----------------------------------------------------------

const gitDir = join(dir, 'repo')
execFileSync('git', ['init', '-q', gitDir])
writeFileSync(join(gitDir, 'a.txt'), 'one\n')
execFileSync('git', ['add', 'a.txt'], { cwd: gitDir })
execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '-qm', 'init'], { cwd: gitDir })
appendFileSync(join(gitDir, 'a.txt'), 'two\n')

await check('git_diff_matches sees the real working-tree change', async () => {
  const changed = await evaluateAssertion(
    { kind: 'git_diff_matches', spec: { ref: 'HEAD', paths: ['a.txt'], expect: 'changed' } },
    { cwd: gitDir },
  )
  const unchanged = await evaluateAssertion(
    { kind: 'git_diff_matches', spec: { ref: 'HEAD', paths: ['b.txt'], expect: 'unchanged' } },
    { cwd: gitDir },
  )
  return changed.status === 'pass'
    && changed.evidence.changed.includes('a.txt')
    && unchanged.status === 'pass'
})

await check('git_diff_matches fails when the expected change is absent', async () => {
  const outcome = await evaluateAssertion(
    { kind: 'git_diff_matches', spec: { ref: 'HEAD', paths: ['b.txt'], expect: 'changed' } },
    { cwd: gitDir },
  )
  return outcome.status === 'fail'
})

// ---- verify + complete ------------------------------------------------------

const verified = (await submit(R2({ intent: 'verify persisted results' }))).task
startTask(verified.id)

await check('verifyTask persists assertion results and appends task.verified', async () => {
  const result = await verifyTask(store, verified.id)
  const assertions = store.listAssertions(verified.id)
  const events = store.listEvents(verified.id).map((event) => event.type)
  return result.overall === 'pass'
    && result.counts.pass === 1
    && assertions[0].status === 'pass'
    && assertions[0].checkedAt !== null
    && events.includes('task.verified')
})

await check('complete gates on the Verifier and succeeds only when it passes', async () => {
  const value = await control({ taskId: verified.id, action: 'complete', summary: 'nginx config confirmed' })
  const receipts = store.listReceipts(verified.id)
  const events = store.listEvents(verified.id).map((event) => event.type)
  return value.task.status === 'succeeded'
    && value.verification.overall === 'pass'
    && receipts.length === 1
    && receipts[0].summary === 'nginx config confirmed'
    && events.includes('task.completed')
})

const failing = (await submit(R2({
  intent: 'failing assertion path',
  assertions: [{ kind: 'file_exists', path: join(dir, 'never-existed.conf') }],
}))).task
startTask(failing.id)

await check('complete refuses success when an assertion fails, task stays running', async () => {
  await assert.rejects(
    () => control({ taskId: failing.id, action: 'complete' }),
    (error) => error instanceof TaskError && error.code === 'verification-failed',
  )
  const task = store.getTask(failing.id)
  return task.status === 'running'
    && store.listAssertions(failing.id)[0].status === 'fail'
    && store.listReceipts(failing.id).length === 0
})

const undecidable = (await submit({
  intent: 'needs the SvcOps adapter',
  riskLevel: 'R2',
  assertions: [{ kind: 'service_active', unit: 'nginx.service' }],
})).task
startTask(undecidable.id)

await check('skipped assertions block completion (incomplete, not success)', async () => {
  const result = await verifyTask(store, undecidable.id)
  let code = null
  try {
    await completeTask(store, undecidable.id)
  } catch (error) {
    code = error.code
  }
  return result.overall === 'incomplete'
    && result.counts.skipped === 1
    && code === 'verification-incomplete'
    && store.getTask(undecidable.id).status === 'running'
})

await check('mounting the adapter lets the same task complete', async () => {
  const { task, verification } = await completeTask(store, undecidable.id, {
    serviceStatus: async () => 'active',
  })
  return task.status === 'succeeded' && verification.overall === 'pass'
})

await check('task_control complete evaluates exit_code from recorded evidence', async () => {
  const task = (await submit({
    intent: 'run the migration script',
    riskLevel: 'R2',
    assertions: [{ kind: 'exit_code', expected: 0 }],
  })).task
  startTask(task.id)
  const value = await control({ taskId: task.id, action: 'complete', execExitCode: 0 })
  return value.task.status === 'succeeded' && value.verification.overall === 'pass'
})

await check('task_status returns the task with assertions and events', async () => {
  const value = await status({ taskId: verified.id })
  return value.total === 1
    && value.task.id === verified.id
    && value.assertions.length === 1
    && value.events.some((event) => event.type === 'task.completed')
})

await check('task_status lists tasks by status', async () => {
  const value = await status({ status: 'succeeded', limit: 50 })
  const tasks = store.listTasks({ status: 'succeeded', limit: 50 })
  return value.total === tasks.length
    && value.tasks.every((task) => task.status === 'succeeded')
    && value.task === null
})

// ---- Slice AO: owner supplements are applied, not parked --------------------

await check('steerTask re-queues a running attempt with the supplement and consumes the input', () => {
  const steerStore = createTaskStore(join(dir, 'steer.sqlite'))
  try {
    const task = steerStore.createTask({ intent: '统计大文件', riskLevel: 'R1' })
    const claimed = steerStore.claimTask({ owner: 'w1', leaseMs: 60_000, now: new Date() })
    if (claimed === null || claimed.id !== task.id) return false
    const input = steerStore.enqueueInput({ taskId: task.id, inboxId: 'inbox-steer-1' })
    const steered = steerStore.steerTask({
      taskId: task.id,
      inputId: input.id,
      text: '只统计 /var',
    })
    const raw = new DatabaseConstructor(join(dir, 'steer.sqlite'))
    const delivered = raw.prepare('SELECT status FROM task_inputs WHERE id = ?').get(input.id)
    raw.close()
    const events = steerStore.listEvents(task.id)
    if (steered.applied !== 'rerun') return false
    if (steered.task.status !== 'queued' || steered.task.attempt !== 0) return false
    if (steered.task.leaseOwner !== null || steered.task.startedAt !== null) return false
    if (!steered.task.intent.includes('只统计 /var')) return false
    if (delivered.status !== 'delivered') return false
    if (!events.some((event) => event.type === 'task.steered')) return false

    // The next claim is when the intent is actually consumed.
    const again = steerStore.claimTask({ owner: 'w2', leaseMs: 60_000, now: new Date() })
    const after = new DatabaseConstructor(join(dir, 'steer.sqlite'))
    const read = after.prepare('SELECT status FROM task_inputs WHERE id = ?').get(input.id)
    after.close()
    return again !== null && again.id === task.id && read.status === 'read'
  } finally {
    steerStore.close()
  }
})

await check('steerTask merges into a queued task without burning an attempt', () => {
  const mergeStore = createTaskStore(join(dir, 'steer-merge.sqlite'))
  try {
    const task = mergeStore.createTask({ intent: '检查磁盘', riskLevel: 'R1' })
    const input = mergeStore.enqueueInput({ taskId: task.id, inboxId: 'inbox-steer-2' })
    const steered = mergeStore.steerTask({ taskId: task.id, inputId: input.id, text: '顺便看 inode' })
    return steered.applied === 'merged'
      && steered.task.status === 'queued'
      && steered.task.intent.includes('顺便看 inode')
  } finally {
    mergeStore.close()
  }
})

// ---- Slice AR: a run that needs input parks, and the answer resumes it ------

await check('parkForInput moves running → waiting_input and records the question', () => {
  const parkStore = createTaskStore(join(dir, 'park.sqlite'))
  try {
    const task = parkStore.createTask({ intent: '把报告写到指定目录', riskLevel: 'R1' })
    parkStore.claimTask({ owner: 'w1', leaseMs: 60_000, now: new Date() })
    const parked = parkStore.parkForInput({ taskId: task.id, question: '目标目录是哪个？' })
    const events = parkStore.listEvents(task.id)
    const requested = events.filter((event) => event.type === 'task.input_requested')
    return parked.status === 'waiting_input'
      && parked.leaseOwner === null
      && parked.attempt === 1
      && requested.length === 1
      && requested[0].payload.question === '目标目录是哪个？'
      && events.some((event) => event.type === 'task.waiting_input')
      && parkStore.listReceipts(task.id).length === 0
  } finally {
    parkStore.close()
  }
})

await check('parkForInput refuses a task that is not running', () => {
  const parkStore = createTaskStore(join(dir, 'park-refuse.sqlite'))
  try {
    const task = parkStore.createTask({ intent: '还没开始', riskLevel: 'R1' })
    try {
      parkStore.parkForInput({ taskId: task.id, question: '?' })
      return false
    } catch (error) {
      return error.code === 'conflict'
    }
  } finally {
    parkStore.close()
  }
})

await check('the owner reply wakes a waiting_input task back to queued', () => {
  const parkStore = createTaskStore(join(dir, 'park-steer.sqlite'))
  try {
    const task = parkStore.createTask({ intent: '导出日志', riskLevel: 'R1' })
    parkStore.claimTask({ owner: 'w1', leaseMs: 60_000, now: new Date() })
    parkStore.parkForInput({ taskId: task.id, question: '导到哪个目录？' })
    const input = parkStore.enqueueInput({ taskId: task.id, inboxId: 'inbox-park-1' })
    const steered = parkStore.steerTask({
      taskId: task.id,
      inputId: input.id,
      text: '导到 /tmp/logs',
    })
    const claimed = parkStore.claimTask({ owner: 'w2', leaseMs: 60_000, now: new Date() })
    return steered.applied === 'rerun'
      && steered.task.status === 'queued'
      && steered.task.attempt === 0
      && steered.task.intent.includes('导到 /tmp/logs')
      && claimed !== null
      && claimed.id === task.id
  } finally {
    parkStore.close()
  }
})

// ---- L0: task kernel (single entry + recovery + lifecycle audit) ------------

await check('resume on a task waiting for approval is refused', async () => {
  const task = (await submit({
    intent: 'approval probe',
    riskLevel: 'R2',
    assertions: [{ kind: 'file_exists', path: fixturePath }],
  })).task
  store.holdForApproval({ taskId: task.id, reason: 'risk:R2' })
  let message = ''
  try {
    await control({ taskId: task.id, action: 'resume' })
  } catch (error) {
    message = error.message
  }
  const after = store.getTask(task.id)
  store.transition(task.id, { to: 'cancelled', summary: 'probe cleanup' })
  return after.status === 'waiting_approval'
    && after.leaseOwner === null
    && /approval/.test(message)
})

await check('claimTask({taskId}) claims exactly that row and refuses a second claim', () => {
  const claimStore = createTaskStore(join(dir, 'kernel-claim.sqlite'))
  try {
    const first = claimStore.createTask({ intent: 'first', riskLevel: 'R1' })
    const second = claimStore.createTask({ intent: 'second', riskLevel: 'R1' })
    const claimed = claimStore.claimTask({ owner: 'w1', leaseMs: 60_000, taskId: second.id })
    const again = claimStore.claimTask({ owner: 'w2', leaseMs: 60_000, taskId: second.id })
    const untouched = claimStore.getTask(first.id)
    return claimed !== null
      && claimed.id === second.id
      && claimed.attempt === 1
      && claimed.leaseOwner === 'w1'
      && claimed.leaseExpiresAt !== null
      && again === null
      && untouched.status === 'queued'
      && untouched.attempt === 0
  } finally {
    claimStore.close()
  }
})

await check('recovery requeues a running row that carries no lease', () => {
  const path = join(dir, 'kernel-recover.sqlite')
  const recoverStore = createTaskStore(path)
  try {
    const task = recoverStore.createTask({ intent: 'legacy orphan', riskLevel: 'R1' })
    const raw = new DatabaseConstructor(path)
    raw.prepare(
      "UPDATE tasks SET status = 'running', lease_owner = NULL, lease_expires_at = NULL, attempt = 1 WHERE id = ?",
    ).run(task.id)
    raw.close()
    const report = recoverStore.recoverExpiredLeases()
    const after = recoverStore.getTask(task.id)
    const retried = recoverStore.listEvents(task.id)
      .find((event) => event.type === 'task.retried' && event.payload?.reason === 'lease-missing')
    return report.requeued.includes(task.id)
      && after.status === 'queued'
      && after.leaseOwner === null
      && retried !== undefined
  } finally {
    recoverStore.close()
  }
})

await check('auditLifecycle reports zero findings on healthy rows', () => {
  const healthyStore = createTaskStore(join(dir, 'kernel-audit-healthy.sqlite'))
  try {
    const task = healthyStore.createTask({ intent: 'healthy', riskLevel: 'R1' })
    healthyStore.claimTask({ owner: 'w1', leaseMs: 60_000, taskId: task.id })
    const audit = healthyStore.auditLifecycle()
    return audit.findings.length === 0
      && Object.values(audit.counts).every((count) => count === 0)
  } finally {
    healthyStore.close()
  }
})

await check('auditLifecycle detects every structural anomaly', () => {
  const path = join(dir, 'kernel-audit.sqlite')
  const auditStore = createTaskStore(path)
  const raw = new DatabaseConstructor(path)
  try {
    const noLease = auditStore.createTask({ intent: 'no lease', riskLevel: 'R1' })
    raw.prepare(
      "UPDATE tasks SET status = 'running', lease_owner = NULL, lease_expires_at = NULL, attempt = 1 WHERE id = ?",
    ).run(noLease.id)

    const expired = auditStore.createTask({ intent: 'expired', riskLevel: 'R1' })
    raw.prepare(
      "UPDATE tasks SET status = 'running', lease_owner = 'w', lease_expires_at = ?, attempt = 1 WHERE id = ?",
    ).run('2020-01-01T00:00:00.000Z', expired.id)

    const stuck = auditStore.createTask({ intent: 'stuck', riskLevel: 'R1' })
    raw.prepare("UPDATE tasks SET status = 'queued', attempt = max_attempts WHERE id = ?").run(stuck.id)

    const gap = auditStore.createTask({ intent: 'gap', riskLevel: 'R1' })
    raw.prepare(
      'INSERT INTO task_events (id, task_id, seq, type, payload_json, created_at) VALUES (?,?,?,?,?,?)',
    ).run('evt-gap', gap.id, 9, 'task.created', null, new Date().toISOString())

    const noReceipt = auditStore.createTask({ intent: 'no receipt', riskLevel: 'R1' })
    raw.prepare(
      'INSERT INTO task_events (id, task_id, seq, type, payload_json, created_at) VALUES (?,?,?,?,?,?)',
    ).run('evt-nr', noReceipt.id, 2, 'task.completed', null, new Date().toISOString())
    raw.prepare("UPDATE tasks SET status = 'succeeded', finished_at = ? WHERE id = ?")
      .run(new Date().toISOString(), noReceipt.id)

    const audit = auditStore.auditLifecycle({ now: new Date('2026-01-01T00:00:00.000Z') })
    const expected = [
      'running-without-lease',
      'expired-lease',
      'stuck-queued',
      'event-seq-gap',
      'terminal-without-receipt',
    ]
    return expected.every((kind) => audit.counts[kind] === 1)
      && audit.findings.length === expected.length
      && new Set(audit.findings.map((finding) => finding.kind)).size === expected.length
  } finally {
    raw.close()
    auditStore.close()
  }
})

// ---- teardown ---------------------------------------------------------------

httpServer.close()
store.close()
rmSync(dir, { recursive: true, force: true })

console.log(`\ntasks: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
