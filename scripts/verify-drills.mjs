#!/usr/bin/env node
/**
 * P6-4 fault drills (docs/15 §十六).
 *
 * Eleven failure classes, injected through the same seams production uses:
 * real worker / executor / isolation / merge / telemetry / outbox. Each drill
 * asserts the diagnosis contract that matters for that class:
 *
 *   - task-level failures: receipt ≤4 lines + `/diag` names phase/code/trace,
 *     the attempt row carries `errorCode` + `traceId`, export replays it;
 *   - infrastructure failures that are absorbed (quota, SQLite busy, adapter
 *     retry) assert fail-open + a measurable drop/retry instead of a receipt.
 *
 *   node scripts/verify-drills.mjs
 */
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDshExecutor } from '../plugins/executor/lib/index.js'
import { TransportError, createReceiptRelay } from '../plugins/gateway/lib/index.js'
import { createWfxmHost } from '../plugins/host/lib/index.js'
import { enrichFailureReceipt, formatDiagReport } from '../plugins/host/lib/diagnostics.js'
import {
  createIsolationResolver,
  createIsolationService,
  createTaskStore,
  createTaskWorker,
} from '../plugins/tasks/lib/index.js'
import { createTelemetryStore } from '../plugins/telemetry/lib/index.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const NOW = Date.now()
// The root workspace has no direct dependency; resolve the driver the store uses.
const Database = createRequire(new URL('../plugins/telemetry/package.json', import.meta.url))('better-sqlite3')

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

function tempDir(label) {
  return mkdtempSync(join(tmpdir(), `wfxm-drill-${label}-`))
}

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'wfxm-test',
      GIT_AUTHOR_EMAIL: 'wfxm@test',
      GIT_COMMITTER_NAME: 'wfxm-test',
      GIT_COMMITTER_EMAIL: 'wfxm@test',
    },
  })
}

function makeRepo(label, content = 'base\n') {
  const dir = tempDir(label)
  git(dir, ['init', '-q', '-b', 'main'])
  writeFileSync(join(dir, 'app.txt'), content)
  git(dir, ['add', '.'])
  git(dir, ['commit', '-q', '-m', 'base'])
  return dir
}

function makeProject(id, repo, extra = {}) {
  return {
    id,
    name: id,
    rootPath: repo,
    vcs: 'git',
    prepareCmd: extra.prepareCmd ?? null,
    worktreeRoot: null,
    mergeMode: 'manual',
  }
}

async function withEnv(fn, telemetryOptions = {}) {
  const dir = tempDir('env')
  const dbPath = join(dir, 'ops.sqlite')
  const errors = []
  const telemetry = createTelemetryStore({
    dbPath,
    traceDir: join(dir, 'traces'),
    flushIntervalMs: 60_000,
    mode: 'meta',
    onError: (error) => errors.push(error),
    ...telemetryOptions,
  })
  const tasks = createTaskStore(dbPath)
  const ctx = { dir, dbPath, telemetry, tasks, errors }
  try {
    return await fn(ctx)
  } finally {
    try {
      tasks.close()
    } catch {
      // already closed by a host
    }
    telemetry.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

async function withHost(fn, send) {
  const dir = tempDir('host')
  const dbPath = join(dir, 'ops.sqlite')
  const telemetry = createTelemetryStore({
    dbPath,
    traceDir: join(dir, 'traces'),
    flushIntervalMs: 60_000,
    mode: 'meta',
  })
  const host = createWfxmHost({
    dbPath,
    executor: async () => ({ status: 'succeeded', summary: 'ok' }),
    transport: { send },
    telemetry,
  })
  try {
    return await fn({ dir, dbPath, host, telemetry })
  } finally {
    try {
      host.close()
    } catch {
      // best effort
    }
    rmSync(dir, { recursive: true, force: true })
  }
}

function writeStubDsh(dir, { lines = [], delayMs = 0 } = {}) {
  const stub = join(dir, `stub-dsh-${Math.random().toString(16).slice(2)}.mjs`)
  writeFileSync(stub, [
    '#!/usr/bin/env node',
    `const lines = ${JSON.stringify(lines)}`,
    `const delay = ${delayMs}`,
    'process.stdin.resume()',
    'if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))',
    'for (const line of lines) console.log(JSON.stringify(line))',
    'process.stdin.on("end", () => {})',
  ].join('\n'))
  chmodSync(stub, 0o755)
  return stub
}

function diagnose(ctx, taskId) {
  const task = ctx.tasks.getTask(taskId)
  assert.ok(task !== null, `task ${taskId} disappeared`)
  return formatDiagReport({
    task,
    attempts: ctx.telemetry.attempts(taskId),
    events: ctx.telemetry.query({ taskId, limit: 500 }).rows,
    now: new Date(),
    hasTelemetry: true,
  })
}

/** The same enrichment the host applies before enqueueing a failed receipt. */
function receiptText(ctx, taskId) {
  const attempts = ctx.telemetry.attempts(taskId)
  const enriched = enrichFailureReceipt(
    { taskId, status: 'failed', summary: '失败' },
    { attempts: () => attempts, query: (input) => ctx.telemetry.query(input) },
  )
  const task = ctx.tasks.getTask(taskId)
  const sent = []
  const relay = createReceiptRelay({
    store: {
      getThread: (id) => (id === 'th1' ? { id: 'th1' } : null),
      findOutboxByDedupe: () => null,
      enqueueOutbox: (row) => sent.push(row),
    },
    receipts: {
      pendingReceipts: () => [{
        id: 'rc-drill',
        taskId,
        round: task.round,
        summary: '失败',
        evidenceLocator: null,
        threadId: 'th1',
        createdAt: new Date().toISOString(),
        taskRef: task.taskRef,
        status: 'failed',
        ...enriched,
      }],
      markReceiptDelivered() {},
    },
  })
  relay.pump()
  assert.equal(sent.length, 1, 'failure receipt was not enqueued')
  return sent[0].payload.text
}

function exportLines(ctx, taskRef) {
  const out = join(ctx.dir, 'eval', 'trajectory')
  const env = { ...process.env, DSH_WFXM_DB: ctx.dbPath, DSH_WFXM_DATA_DIR: ctx.dir }
  delete env.LD_LIBRARY_PATH
  const run = spawnSync(process.execPath, [
    'scripts/trace.mjs', 'export', taskRef, '--repo-root', ctx.dir, '--out', out,
  ], { cwd: root, env, encoding: 'utf8', timeout: 60_000 })
  assert.equal(run.status, 0, run.stderr)
  const name = readdirSync(out).find((entry) => entry.endsWith('.ndjson'))
  assert.ok(name, 'export produced no ndjson')
  return readFileSync(join(out, name), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
}

async function assertTaskFailure(ctx, task, expect) {
  await ctx.telemetry.flush()
  const latest = ctx.telemetry.attempts(task.id).at(-1)
  assert.ok(latest !== undefined, 'attempt row missing')
  assert.equal(latest.outcome, 'failed')
  assert.ok(latest.errorCode !== null && latest.errorCode !== '', 'attempt.errorCode is empty')
  assert.ok(latest.traceId.trim() !== '', 'attempt.traceId is empty')
  if (expect.code !== undefined) assert.equal(latest.errorCode, expect.code)

  const report = diagnose(ctx, task.id)
  assert.match(report, /追踪：/)
  assert.doesNotMatch(report, /无异常/)
  if (expect.phase !== undefined) {
    assert.ok(report.includes(`阶段：${expect.phaseLabel}（${expect.phase}）`), report)
  }
  if (expect.code !== undefined) assert.ok(report.includes(expect.code), report)

  const receipt = receiptText(ctx, task.id)
  assert.ok(receipt.split('\n').length <= 4, `receipt has ${receipt.split('\n').length} lines`)
  assert.match(receipt, /追踪：/)
  if (expect.code !== undefined) assert.ok(receipt.includes(expect.code), receipt)
  // P6-4 real-channel finding: the receipt must name the real phase, not the
  // attempt bookkeeping row that is written last.
  if (expect.phaseLabel !== undefined) assert.ok(receipt.includes(`阶段：${expect.phaseLabel}`), receipt)
  return { latest, report, receipt }
}

// ---- 1. 网关适配器断连：重试吸收，不产生失败回执 ---------------------------

await check('1 网关适配器断连：同一条消息重试一次并记录 delivery-retry', () =>
  withHost(async (ctx) => {
    const task = ctx.host.stores.tasks.createTask({
      intent: 'adapter drop', riskLevel: 'R1', maxAttempts: 1, correlationId: 'trace-adapter',
    })
    const item = ctx.host.stores.gateway.enqueueOutbox({
      topic: 'receipt', payload: { text: '投递演练' }, taskId: task.id, threadId: 'th1',
    })
    const report = await ctx.host.pump()
    await ctx.telemetry.flush()

    assert.equal(report.dispatch.retried, 1)
    const event = ctx.telemetry.query({ taskId: task.id, limit: 50 }).rows
      .find((row) => row.event === 'delivery.failed')
    assert.ok(event !== undefined, 'delivery.failed event missing')
    assert.equal(event.level, 'warn')
    assert.equal(event.phase, 'deliver')
    assert.equal(event.error.code, 'delivery-retry')
    assert.equal(ctx.host.stores.gateway.getOutbox(item.id).status, 'pending')
    return 'retried=1, 行保持 pending'
  }, async () => {
    throw new TransportError('unavailable', 'feishu long-connection closed')
  }))

// ---- 2a. 模型超时 ----------------------------------------------------------

await check('2a 模型超时：timeout 进入回执/诊断，attempt 带 code+trace', () =>
  withEnv(async (ctx) => {
    const dshBin = writeStubDsh(ctx.dir, { delayMs: 2_000 })
    const task = ctx.tasks.createTask({
      intent: 'hang', riskLevel: 'R1', maxAttempts: 1, correlationId: 'trace-timeout',
    })
    const executor = createDshExecutor({
      dshBin, telemetry: ctx.telemetry, defaultWorkdir: ctx.dir, timeoutMs: 200, killGraceMs: 50,
    })
    await createTaskWorker({ store: ctx.tasks, execute: executor, telemetry: ctx.telemetry }).runOnce()

    const { report } = await assertTaskFailure(ctx, task, {
      code: 'timeout', phase: 'execute', phaseLabel: '执行',
    })
    assert.match(report, /原因：timeout/)
    const lines = exportLines(ctx, task.taskRef)
    assert.ok(lines.some((line) => line.type === 'status' && line.phase === 'turn_end'))
    return 'code=timeout'
  }))

// ---- 2b. 模型 429 ----------------------------------------------------------

await check('2b 模型 429：rate_limited 原样进入回执与导出', () =>
  withEnv(async (ctx) => {
    const dshBin = writeStubDsh(ctx.dir, {
      lines: [{
        type: 'status',
        phase: 'turn_end',
        reason: { kind: 'error', error: { code: 'rate_limited', message: '429 Too Many Requests' } },
      }],
    })
    const task = ctx.tasks.createTask({
      intent: 'rate', riskLevel: 'R1', maxAttempts: 1, correlationId: 'trace-429',
    })
    const executor = createDshExecutor({ dshBin, telemetry: ctx.telemetry, defaultWorkdir: ctx.dir })
    await createTaskWorker({ store: ctx.tasks, execute: executor, telemetry: ctx.telemetry }).runOnce()

    await assertTaskFailure(ctx, task, { code: 'rate_limited', phase: 'execute', phaseLabel: '执行' })
    const lines = exportLines(ctx, task.taskRef)
    assert.ok(lines.some((line) => line.type === 'status' && line.phase === 'turn_end'))
    return 'code=rate_limited'
  }))

// ---- 3. 沙箱拒绝 -----------------------------------------------------------

await check('3 沙箱拒绝：sandbox-denied 而不是笼统 unknown', () =>
  withEnv(async (ctx) => {
    const dshBin = writeStubDsh(ctx.dir, {
      lines: [{
        type: 'status',
        phase: 'turn_end',
        reason: {
          kind: 'error',
          error: { code: 'sandbox-denied', message: 'bwrap: operation not permitted' },
        },
      }],
    })
    const task = ctx.tasks.createTask({
      intent: 'sandbox', riskLevel: 'R1', maxAttempts: 1, correlationId: 'trace-sandbox',
    })
    const executor = createDshExecutor({ dshBin, telemetry: ctx.telemetry, defaultWorkdir: ctx.dir })
    await createTaskWorker({ store: ctx.tasks, execute: executor, telemetry: ctx.telemetry }).runOnce()
    await assertTaskFailure(ctx, task, {
      code: 'sandbox-denied', phase: 'execute', phaseLabel: '执行',
    })
    return 'code=sandbox-denied'
  }))

// ---- 4. 磁盘配额满（采集配额，业务不失败）--------------------------------

await check('4 磁盘配额满：事件按 task-quota 丢弃，任务仍 succeeded', () =>
  withEnv(async (ctx) => {
    const task = ctx.tasks.createTask({
      intent: 'quota', riskLevel: 'R1', maxAttempts: 1, correlationId: 'trace-quota',
    })
    await createTaskWorker({
      store: ctx.tasks,
      execute: () => ({ status: 'succeeded', summary: 'ok' }),
      telemetry: ctx.telemetry,
    }).runOnce()
    await ctx.telemetry.flush()

    assert.equal(ctx.tasks.getTask(task.id).status, 'succeeded')
    assert.equal(ctx.telemetry.attempts(task.id).at(-1).outcome, 'succeeded')
    assert.ok((ctx.telemetry.stats().dropped['task-quota'] ?? 0) > 0, 'task-quota drop not counted')
    return `dropped=${ctx.telemetry.stats().dropped['task-quota']}`
  }, { perTaskLimitBytes: 1 }))

// ---- 5. SQLite busy --------------------------------------------------------

await check('5 SQLite busy：flush 记 store-error，恢复后继续写入', async () => {
  const dir = tempDir('busy')
  const dbPath = join(dir, 'ops.sqlite')
  const errors = []
  const telemetry = createTelemetryStore({
    dbPath, traceDir: join(dir, 'traces'), flushIntervalMs: 60_000, mode: 'meta',
    busyTimeoutMs: 50, onError: (error) => errors.push(error),
  })
  const lock = new Database(dbPath)
  try {
    lock.pragma('journal_mode = WAL')
    lock.exec('BEGIN EXCLUSIVE')
    telemetry.emit({
      ts: new Date().toISOString(), level: 'info', event: 'task.created', phase: 'task',
      traceId: 'trace-busy', taskId: 'busy-task', status: 'running',
    })
    const blocked = await telemetry.flush()
    assert.equal(blocked.errors, 1)
    assert.ok(errors.some((error) => /busy|locked/i.test(String(error.message))), String(errors[0]))
    lock.exec('ROLLBACK')

    await telemetry.flush()
    assert.ok((telemetry.stats().dropped['store-error'] ?? 0) >= 1, 'store-error drop not counted')

    telemetry.emit({
      ts: new Date().toISOString(), level: 'info', event: 'task.created', phase: 'task',
      traceId: 'trace-busy-2', taskId: 'busy-task-2', status: 'running',
    })
    const recovered = await telemetry.flush()
    assert.equal(recovered.written, 1)
    return 'SQLITE_BUSY → store-error → 恢复写入'
  } finally {
    try {
      lock.close()
    } catch {
      // already closed
    }
    telemetry.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---- 6. worktree prepare 失败 ---------------------------------------------

await check('6 worktree prepare 失败：prepare-failed 贯穿 attempt/回执/诊断/导出', () =>
  withEnv(async (ctx) => {
    const repo = makeRepo('prepare')
    const project = makeProject('prepare', repo, { prepareCmd: 'exit 7' })
    const task = ctx.tasks.createTask({
      intent: 'prepare fails', riskLevel: 'R1', maxAttempts: 1, projectId: project.id,
      correlationId: 'trace-prepare',
    })
    const resolver = createIsolationResolver({ tasks: ctx.tasks, telemetry: ctx.telemetry })
    const executor = createDshExecutor({
      dshBin: writeStubDsh(ctx.dir, { lines: [{ type: 'status', phase: 'step_end' }] }),
      telemetry: ctx.telemetry,
      defaultWorkdir: repo,
      workdirResolver: (running) => resolver(running, project, repo),
    })
    await createTaskWorker({ store: ctx.tasks, execute: executor, telemetry: ctx.telemetry }).runOnce()

    await assertTaskFailure(ctx, task, {
      code: 'prepare-failed', phase: 'isolation', phaseLabel: '隔离',
    })
    const lines = exportLines(ctx, task.taskRef)
    assert.ok(lines.some((line) => line.type === 'status' && line.reason?.kind === 'prepare-failed'))
    return 'code=prepare-failed'
  }))

// ---- 7. commit 失败 --------------------------------------------------------

await check('7 commit 失败：commit-failed 可诊断且导出含错误状态', () =>
  withEnv(async (ctx) => {
    const task = ctx.tasks.createTask({
      intent: 'commit', riskLevel: 'R1', maxAttempts: 1, correlationId: 'trace-commit',
    })
    ctx.tasks.setIsolation(task.id, {
      isolation: 'worktree',
      worktreePath: join(ctx.dir, 'missing-worktree'),
      baseCommit: 'deadbeef',
      branch: 'wfxm/drill',
    })
    await createTaskWorker({
      store: ctx.tasks,
      execute: () => ({ status: 'succeeded', summary: 'done' }),
      telemetry: ctx.telemetry,
    }).runOnce()

    await assertTaskFailure(ctx, task, {
      code: 'commit-failed', phase: 'isolation', phaseLabel: '隔离',
    })
    const lines = exportLines(ctx, task.taskRef)
    assert.ok(lines.some((line) => line.type === 'status' && line.reason?.kind === 'commit-failed'))
    return 'code=commit-failed'
  }))

// ---- 8. Verifier 失败 ------------------------------------------------------

await check('8 Verifier 失败：verification-failed 可诊断且导出含工具/错误状态', () =>
  withEnv(async (ctx) => {
    const task = ctx.tasks.createTask({
      intent: 'verify', riskLevel: 'R1', maxAttempts: 1, correlationId: 'trace-verify',
    })
    ctx.tasks.addAssertion(task.id, {
      kind: 'file_exists',
      spec: { path: join(ctx.dir, 'missing-file') },
    })
    await createTaskWorker({
      store: ctx.tasks,
      execute: () => ({ status: 'succeeded', summary: 'done' }),
      telemetry: ctx.telemetry,
    }).runOnce()

    await assertTaskFailure(ctx, task, {
      code: 'verification-failed', phase: 'verify', phaseLabel: '验证',
    })
    const lines = exportLines(ctx, task.taskRef)
    assert.ok(lines.some((line) => line.type === 'status' && line.phase === 'turn_end'))
    return 'code=verification-failed'
  }))

// ---- 9. 合并冲突 -----------------------------------------------------------

await check('9 合并冲突：状态 conflict，merge-conflict 可被 /diag 与导出看到', () =>
  withEnv(async (ctx) => {
    const repo = makeRepo('merge')
    const project = makeProject('merge', repo)
    const task = ctx.tasks.createTask({
      intent: 'merge', riskLevel: 'R1', maxAttempts: 1, projectId: project.id,
      correlationId: 'trace-merge',
    })
    const resolver = createIsolationResolver({ tasks: ctx.tasks, telemetry: ctx.telemetry })
    const cwd = await resolver(task, project, repo)
    writeFileSync(join(cwd, 'app.txt'), 'from task\n')
    git(cwd, ['add', 'app.txt'])
    git(cwd, ['commit', '-q', '-m', 'task change'])
    const claimed = ctx.tasks.claimTask({ owner: 'drill', leaseMs: 60_000, taskId: task.id })
    assert.ok(claimed !== null)
    ctx.tasks.transition(task.id, { to: 'succeeded', summary: 'done' })
    writeFileSync(join(repo, 'app.txt'), 'from main\n')
    git(repo, ['add', 'app.txt'])
    git(repo, ['commit', '-q', '-m', 'main change'])

    const service = createIsolationService({ tasks: ctx.tasks, telemetry: ctx.telemetry })
    const result = await service.merge(task.id, project)
    await ctx.telemetry.flush()

    assert.equal(result.state, 'conflict')
    assert.ok(result.conflictPaths.includes('app.txt'))
    const event = ctx.telemetry.query({ taskId: task.id, limit: 100 }).rows
      .find((row) => row.event === 'merge.conflict')
    assert.ok(event !== undefined, 'merge.conflict event missing')
    assert.equal(event.level, 'error')
    assert.equal(event.error.code, 'merge-conflict')
    const report = diagnose(ctx, task.id)
    assert.match(report, /阶段：合并（merge）/)
    assert.match(report, /原因：merge-conflict/)
    assert.match(report, /追踪：trace-merge/)
    const lines = exportLines(ctx, task.taskRef)
    assert.ok(lines.some((line) => line.type === 'status' && line.reason?.kind === 'merge-conflict'))
    return 'state=conflict, code=merge-conflict'
  }))

// ---- 10. 投递失败（终态）---------------------------------------------------

await check('10 投递失败：delivery-failed 进入 /diag 与导出', () =>
  withHost(async (ctx) => {
    const task = ctx.host.stores.tasks.createTask({
      intent: 'deliver', riskLevel: 'R1', maxAttempts: 1, correlationId: 'trace-deliver',
    })
    const item = ctx.host.stores.gateway.enqueueOutbox({
      topic: 'receipt', payload: { text: '投递终态演练' }, taskId: task.id, threadId: 'th1',
    })
    const report = await ctx.host.pump()
    await ctx.telemetry.flush()

    assert.equal(report.dispatch.failed, 1)
    assert.equal(ctx.host.stores.gateway.getOutbox(item.id).status, 'failed')
    const event = ctx.telemetry.query({ taskId: task.id, limit: 50 }).rows
      .find((row) => row.event === 'delivery.failed')
    assert.ok(event !== undefined)
    assert.equal(event.level, 'error')
    assert.equal(event.error.code, 'delivery-failed')

    const text = formatDiagReport({
      task: ctx.host.stores.tasks.getTask(task.id),
      attempts: [],
      events: ctx.telemetry.query({ taskId: task.id, limit: 100 }).rows,
      now: new Date(),
      hasTelemetry: true,
    })
    assert.match(text, /阶段：投递（deliver）/)
    assert.match(text, /原因：delivery-failed/)
    assert.match(text, /追踪：trace-deliver/)
    return 'delivery-failed'
  }, async () => {
    throw new TransportError('rejected', 'feishu bot removed')
  }))

// ---- 11. 进程中途崩溃（租约过期）------------------------------------------

await check('11 进程崩溃：租约过期收敛为 lease-expired，/diag 与导出可见', () =>
  withEnv(async (ctx) => {
    const startedAt = new Date(NOW - 60_000)
    const task = ctx.tasks.createTask({
      intent: 'crash', riskLevel: 'R1', maxAttempts: 1, correlationId: 'trace-crash',
    })
    const claimed = ctx.tasks.claimTask({
      owner: 'dead-worker', leaseMs: 1_000, taskId: task.id, now: startedAt,
    })
    assert.ok(claimed !== null)
    ctx.telemetry.beginAttempt({
      taskId: task.id, attempt: claimed.attempt, traceId: 'trace-crash',
      executor: 'dsh', startedAt,
    })

    const worker = createTaskWorker({
      store: ctx.tasks,
      execute: () => ({ status: 'succeeded', summary: 'never runs' }),
      telemetry: ctx.telemetry,
      now: () => new Date(NOW),
    })
    const recovered = worker.recover()
    assert.ok(recovered.failed.includes(task.id), JSON.stringify(recovered))

    await assertTaskFailure(ctx, task, {
      code: 'lease-expired', phase: 'attempt', phaseLabel: '尝试',
    })
    const lines = exportLines(ctx, task.taskRef)
    assert.ok(lines.some((line) => line.type === 'status' && line.phase === 'turn_end'))
    return 'code=lease-expired'
  }))

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
