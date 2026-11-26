#!/usr/bin/env node
/**
 * P6-2 diagnostics suite (docs/15 §十四).
 *
 * Fault injection → receipt / `/diag` can name the phase, error code and trace.
 * Covers three real failure classes through the real worker + telemetry store,
 * plus receipt formatting, `/status` rendering and alert grouping.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createReceiptRelay } from '../../gateway/lib/index.js'
import { parseDiagCommand } from '../../gateway/lib/index.js'
import { createDshExecutor } from '../../executor/lib/index.js'
import { createTaskStore, createTaskWorker } from '../../tasks/lib/index.js'
import { createTelemetryStore } from '../../telemetry/lib/index.js'
import {
  enrichFailureReceipt,
  formatDiagReport,
  formatRepeatAlert,
  formatStatusReport,
  formatStuckAlert,
  groupErrorCodes,
  summarizeFailures,
} from '../lib/diagnostics.js'

let pass = 0
let fail = 0

function check(label, fn) {
  try {
    fn()
    pass += 1
    console.log(`PASS  ${label}`)
  } catch (error) {
    fail += 1
    console.log(`FAIL  ${label} — ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function checkAsync(label, fn) {
  try {
    await fn()
    pass += 1
    console.log(`PASS  ${label}`)
  } catch (error) {
    fail += 1
    console.log(`FAIL  ${label} — ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function withEnv(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'diagnostics-'))
  const dbPath = join(dir, 'ops.sqlite')
  const telemetry = createTelemetryStore({
    dbPath,
    traceDir: join(dir, 'traces'),
    flushIntervalMs: 60_000,
    mode: 'meta',
  })
  const tasks = createTaskStore(dbPath)
  try {
    await fn({ dir, telemetry, tasks })
  } finally {
    try {
      tasks.close()
    } catch {
      // already closed
    }
    telemetry.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

function writeStubDsh(dir, lines) {
  const stub = join(dir, 'stub-dsh.mjs')
  writeFileSync(stub, [
    'const lines = ' + JSON.stringify(lines),
    'for (const line of lines) console.log(JSON.stringify(line))',
    'process.stdin.resume()',
    'process.stdin.on("end", () => {})',
    '',
  ].join('\n'))
  const bin = join(dir, 'dsh')
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${stub}"\n`)
  chmodSync(bin, 0o755)
  return bin
}

/** Diagnosis shown for one real failed task. */
function diagnose(telemetry, tasks, taskId) {
  const task = tasks.getTask(taskId)
  return formatDiagReport({
    task,
    attempts: telemetry.attempts(taskId),
    events: telemetry.query({ taskId, limit: 500 }).rows,
    now: new Date(),
    hasTelemetry: true,
  })
}

// ---- command parsing -------------------------------------------------------

check('parseDiagCommand accepts /diag <ref>, /status and rejects chat', () => {
  assert.deepEqual(parseDiagCommand('/diag abc123'), { kind: 'diag', ref: 'abc123' })
  assert.deepEqual(parseDiagCommand('/diag @abc123'), { kind: 'diag', ref: 'abc123' })
  assert.deepEqual(parseDiagCommand('/diag'), { kind: 'diag', ref: null })
  assert.deepEqual(parseDiagCommand('/status'), { kind: 'status' })
  assert.equal(parseDiagCommand('/diagxyz'), null)
  assert.equal(parseDiagCommand('状态'), null)
})

// ---- receipt formatting ----------------------------------------------------

check('a failed receipt is at most four lines with phase, code and trace', () => {
  const sent = []
  const relay = createReceiptRelay({
    store: {
      getThread: (id) => (id === 'th1' ? { id: 'th1' } : null),
      findOutboxByDedupe: () => null,
      enqueueOutbox: (row) => sent.push(row),
    },
    receipts: {
      pendingReceipts: () => [{
        id: 'rc1',
        taskId: 'task-1',
        round: 1,
        summary: '验证未通过',
        evidenceLocator: null,
        threadId: 'th1',
        createdAt: '2026-11-26T00:00:00.000Z',
        taskRef: 'abc123',
        status: 'failed',
        failurePhase: 'verify',
        errorCode: 'verification-failed',
        failureKind: 'unknown',
        traceId: 'a1b2c3d4-0000-0000-0000-000000000000',
      }],
      markReceiptDelivered() {},
    },
  })
  relay.pump()
  const text = sent[0].payload.text
  const lines = text.split('\n')
  assert.equal(lines.length, 4)
  assert.match(text, /任务 abc123 失败。/)
  assert.match(text, /阶段：验证/)
  assert.match(text, /原因：verification-failed（unknown）/)
  assert.match(text, /追踪：tr_a1b2c3d4/)
})

check('legacy failed receipts still show summary and retry hint', () => {
  const sent = []
  const relay = createReceiptRelay({
    store: {
      getThread: (id) => (id === 'th1' ? { id: 'th1' } : null),
      findOutboxByDedupe: () => null,
      enqueueOutbox: (row) => sent.push(row),
    },
    receipts: {
      pendingReceipts: () => [{
        id: 'rc2', taskId: 'task-2', round: null, summary: '处理失败，请稍后重试',
        evidenceLocator: null, threadId: 'th1', createdAt: '2026-11-26T00:00:00.000Z',
        taskRef: 'def456', status: 'failed',
      }],
      markReceiptDelivered() {},
    },
  })
  relay.pump()
  const text = sent[0].payload.text
  assert.match(text, /处理失败，请稍后重试/)
  assert.match(text, /如需重试/)
})

// ---- diagnosis rendering ---------------------------------------------------

const failedTask = {
  id: 'task-1',
  taskRef: 'abc123',
  status: 'failed',
  attempt: 2,
  maxAttempts: 3,
  round: 1,
  correlationId: 'trace-1',
  riskLevel: 'R1',
  createdAt: '2026-11-26T00:00:00.000Z',
  startedAt: '2026-11-26T00:00:00.000Z',
  finishedAt: '2026-11-26T00:01:12.000Z',
}

check('formatDiagReport names phase, code, last success and trace', () => {
  const text = formatDiagReport({
    task: failedTask,
    attempts: [{
      attempt: 2,
      outcome: 'failed',
      failureKind: 'unknown',
      errorCode: 'verification-failed',
      summary: 'assertion failed',
      traceId: 'trace-1',
      startedAt: '2026-11-26T00:00:00.000Z',
      finishedAt: '2026-11-26T00:01:12.000Z',
    }],
    events: [
      {
        ts: '2026-11-26T00:01:00.000Z', event: 'executor.step', level: 'debug',
        phase: 'execute', status: 'succeeded', durationMs: 10, error: null,
      },
      {
        ts: '2026-11-26T00:01:10.000Z', event: 'verify.failed', level: 'error',
        phase: 'verify', status: 'failed', durationMs: 20,
        error: { code: 'verification-failed' },
      },
    ],
    now: new Date('2026-11-26T00:02:00.000Z'),
    hasTelemetry: true,
  })
  assert.match(text, /任务 abc123 失败。/)
  assert.match(text, /第 2\/3 次尝试/)
  assert.match(text, /阶段：验证（verify）/)
  assert.match(text, /原因：verification-failed/)
  assert.match(text, /最后成功：executor.step/)
  assert.match(text, /耗时：1m12s/)
  assert.match(text, /追踪：trace-1/)
})

check('a healthy task says 无异常; off says 诊断数据未启用', () => {
  const healthy = formatDiagReport({
    task: { ...failedTask, status: 'running', finishedAt: null, attempt: 1 },
    attempts: [{
      attempt: 1, outcome: 'running', failureKind: null, errorCode: null, summary: null,
      traceId: 'trace-1', startedAt: '2026-11-26T00:00:00.000Z', finishedAt: null,
    }],
    events: [{
      ts: '2026-11-26T00:00:30.000Z', event: 'executor.step', level: 'debug',
      phase: 'execute', status: 'succeeded', durationMs: 10, error: null,
    }],
    now: new Date('2026-11-26T00:01:00.000Z'),
    hasTelemetry: true,
  })
  assert.match(healthy, /无异常。/)
  const off = formatDiagReport({
    task: failedTask, attempts: [], events: [], now: new Date(), hasTelemetry: false,
  })
  assert.match(off, /诊断数据未启用/)
})

check('receipt enrichment joins the latest attempt and error phase', () => {
  const enriched = enrichFailureReceipt(
    { taskId: 'task-1', status: 'failed', summary: 'x' },
    {
      attempts: () => [{
        attempt: 1, outcome: 'failed', failureKind: 'transient', errorCode: 'timeout',
        summary: null, traceId: 'trace-9', startedAt: '', finishedAt: null,
      }],
      query: () => ({
        rows: [{
          ts: '', event: 'executor.finished', level: 'error', phase: 'execute',
          status: 'failed', durationMs: 1, error: { code: 'timeout' },
        }],
      }),
    },
  )
  assert.equal(enriched.failurePhase, 'execute')
  assert.equal(enriched.errorCode, 'timeout')
  assert.equal(enriched.traceId, 'trace-9')

  const untouched = enrichFailureReceipt({ taskId: 't', status: 'succeeded' }, { attempts: () => [] })
  assert.equal(untouched.errorCode, undefined)
})

check('formatStatusReport shows queue, failure rate, stuck and telemetry', () => {
  const text = formatStatusReport({
    halted: false,
    tasks: [
      { ...failedTask, id: 'a', taskRef: 'aaa111', status: 'running', attempt: 1 },
      { ...failedTask, id: 'b', taskRef: 'bbb222', status: 'queued' },
      { ...failedTask, id: 'c', taskRef: 'ccc333', status: 'waiting_input' },
    ],
    failures: { failed: 2, total: 5 },
    stuck: [{
      task: { ...failedTask, id: 'a', taskRef: 'aaa111', status: 'running' },
      quietMs: 23 * 60_000,
    }],
    telemetry: {
      mode: 'meta', degraded: false, diskRatio: 0.4, queueDepth: 0,
      events: 10, todayBytes: 2048, dropped: { 'queue-full': 2 },
    },
    now: new Date('2026-11-26T00:00:00.000Z'),
  })
  assert.match(text, /服务：运行中/)
  assert.match(text, /running 1 · queued 1 · waiting_input 1/)
  assert.match(text, /失败 2 \/ 5（40%）/)
  assert.match(text, /卡住：aaa111（23 分钟无事件）/)
  assert.match(text, /遥测：meta · 丢弃 2 · 今日 2\.0KB/)
})

check('failure summary and alert grouping use task.settled and error codes', () => {
  const failures = summarizeFailures([
    { ts: '1', event: 'task.settled', level: 'warn', phase: 'task', status: 'failed', durationMs: 1, error: null },
    { ts: '2', event: 'task.settled', level: 'info', phase: 'task', status: 'succeeded', durationMs: 1, error: null },
    { ts: '3', event: 'executor.step', level: 'debug', phase: 'execute', status: 'succeeded', durationMs: 1, error: null },
  ])
  assert.deepEqual(failures, { failed: 1, total: 2 })
  const groups = groupErrorCodes([
    { ts: '1', event: 'a', level: 'error', phase: 'execute', status: 'failed', durationMs: 1, error: { code: 'timeout' }, taskId: 't1' },
    { ts: '2', event: 'b', level: 'error', phase: 'merge', status: 'failed', durationMs: 1, error: { code: 'merge-conflict' }, taskId: 't2' },
    { ts: '3', event: 'c', level: 'error', phase: 'execute', status: 'failed', durationMs: 1, error: { code: 'timeout' }, taskId: 't3' },
  ])
  assert.equal(groups[0].code, 'timeout')
  assert.equal(groups[0].count, 2)
  assert.equal(groups[0].latestTaskId, 't3')
  assert.match(formatStuckAlert({ ...failedTask, status: 'running' }, 23 * 60_000), /23 分钟无新事件/)
  assert.match(formatRepeatAlert('timeout', 3, 'abc123'), /timeout 近 1 小时出现 3 次/)
})

// ---- three real failure classes land in the diagnosis ----------------------

await checkAsync('executor failure → /diag names execute + invalid_input + trace', async () => {
  await withEnv(async ({ dir, telemetry, tasks }) => {
    const dshBin = writeStubDsh(dir, [
      { type: 'status', phase: 'turn_end', reason: { kind: 'error', error: { code: 'invalid_input', message: 'bad goal' } } },
    ])
    const task = tasks.createTask({ intent: 'fail', riskLevel: 'R1', maxAttempts: 1, correlationId: 'trace-exec' })
    const executor = createDshExecutor({ dshBin, telemetry, defaultWorkdir: dir })
    const worker = createTaskWorker({ store: tasks, execute: executor, telemetry })
    await worker.runOnce()
    await telemetry.flush()
    const text = diagnose(telemetry, tasks, task.id)
    assert.match(text, /阶段：执行（execute）/)
    assert.match(text, /原因：invalid_input/)
    assert.match(text, /追踪：trace-exec/)
  })
})

await checkAsync('O1: a task with an explicit expert shows the 专家 line', async () => {
  await withEnv(async ({ dir, telemetry, tasks }) => {
    const task = tasks.createTask({
      intent: 'expert task',
      riskLevel: 'R1',
      expert: 'dsh',
      correlationId: 'trace-expert',
    })
    const worker = createTaskWorker({
      store: tasks,
      execute: () => ({ status: 'succeeded', summary: 'ok' }),
      telemetry,
    })
    await worker.runOnce()
    await telemetry.flush()
    const text = diagnose(telemetry, tasks, task.id)
    assert.match(text, /专家：dsh/)
  })
})

await checkAsync('verifier failure → /diag names verify + verification-failed', async () => {
  await withEnv(async ({ dir, telemetry, tasks }) => {
    const task = tasks.createTask({ intent: 'verify', riskLevel: 'R1', correlationId: 'trace-verify' })
    tasks.addAssertion(task.id, {
      kind: 'file_exists',
      spec: { path: join(dir, 'missing-file') },
    })
    const worker = createTaskWorker({
      store: tasks,
      execute: () => ({ status: 'succeeded', summary: 'done' }),
      telemetry,
    })
    await worker.runOnce()
    await telemetry.flush()
    const text = diagnose(telemetry, tasks, task.id)
    assert.match(text, /阶段：验证（verify）/)
    assert.match(text, /原因：verification-failed/)
    assert.match(text, /追踪：trace-verify/)
  })
})

await checkAsync('commit failure → /diag names isolation + commit-failed', async () => {
  await withEnv(async ({ dir, telemetry, tasks }) => {
    const task = tasks.createTask({ intent: 'commit', riskLevel: 'R1', correlationId: 'trace-commit' })
    tasks.setIsolation(task.id, {
      isolation: 'worktree',
      worktreePath: join(dir, 'missing-worktree'),
      baseCommit: 'deadbeef',
      branch: 'wfxm/test',
    })
    const worker = createTaskWorker({
      store: tasks,
      execute: () => ({ status: 'succeeded', summary: 'done' }),
      telemetry,
    })
    await worker.runOnce()
    await telemetry.flush()
    const text = diagnose(telemetry, tasks, task.id)
    assert.match(text, /阶段：隔离/)
    assert.match(text, /原因：commit-failed/)
    assert.match(text, /追踪：trace-commit/)
  })
})

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
