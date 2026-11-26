#!/usr/bin/env node
/**
 * P6-3 trace CLI + weekly metrics suite (docs/15 §十五).
 *
 * Builds one small trace in a temp DB, then drives the real CLI as a child
 * process: query / show / stats / export. The weekly formatter is asserted
 * in-process so a wording change cannot silently blank the patrol section.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createTaskStore } from '../../tasks/lib/index.js'
import {
  computeTraceMetrics,
  createTelemetryStore,
  formatTraceWeekly,
  percentile,
} from '../lib/index.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const base = Date.now() - 5 * 60_000
const at = (offsetMs) => new Date(base + offsetMs).toISOString()

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

function runCli(env, args) {
  const childEnv = { ...process.env, ...env }
  delete childEnv.LD_LIBRARY_PATH
  return spawnSync(process.execPath, ['scripts/trace.mjs', ...args], {
    cwd: root,
    env: childEnv,
    encoding: 'utf8',
    timeout: 60_000,
  })
}

check('percentile uses nearest rank and ignores empty input', () => {
  assert.equal(percentile([], 50), null)
  assert.equal(percentile([100, 600, 1200], 50), 600)
  assert.equal(percentile([100, 600, 1200], 95), 1200)
  assert.equal(percentile([5, -1, Number.NaN], 50), 5)
})

const dir = mkdtempSync(join(tmpdir(), 'trace-cli-'))
const dbPath = join(dir, 'ops.sqlite')
const telemetry = createTelemetryStore({
  dbPath,
  traceDir: join(dir, 'traces'),
  flushIntervalMs: 60_000,
  mode: 'meta',
})
const tasks = createTaskStore(dbPath)

try {
  const task = tasks.createTask({
    intent: 'trace cli',
    riskLevel: 'R1',
    maxAttempts: 2,
    correlationId: 'trace-cli',
  })
  const other = tasks.createTask({
    intent: 'trace cli other',
    riskLevel: 'R1',
    maxAttempts: 1,
    correlationId: 'trace-other',
  })

  telemetry.emit({
    ts: at(0), level: 'info', event: 'task.created', phase: 'task', traceId: 'trace-cli',
    taskId: task.id, taskRef: task.taskRef ?? undefined, status: 'running',
  })
  telemetry.emit({
    ts: at(10), level: 'info', event: 'attempt.started', phase: 'attempt', traceId: 'trace-cli',
    taskId: task.id, attempt: 1, status: 'running',
  })
  telemetry.emit({
    ts: at(20), level: 'debug', event: 'tool.call', phase: 'tool', traceId: 'trace-cli',
    taskId: task.id, attempt: 1, status: 'running', tool: { name: 'read' },
  })
  telemetry.emit({
    ts: at(120), level: 'debug', event: 'tool.result', phase: 'tool', traceId: 'trace-cli',
    taskId: task.id, attempt: 1, status: 'succeeded',
    tool: { name: 'read', exitCode: 0, durationMs: 100 },
  })
  telemetry.emit({
    ts: at(200), level: 'debug', event: 'executor.step', phase: 'execute', traceId: 'trace-cli',
    taskId: task.id, attempt: 1, status: 'succeeded',
    model: { inputTokens: 10, outputTokens: 5, costUsd: 0 },
  })
  telemetry.emit({
    ts: at(1200), level: 'error', event: 'executor.finished', phase: 'execute', traceId: 'trace-cli',
    taskId: task.id, attempt: 1, status: 'failed', durationMs: 1200,
    error: { code: 'timeout', kind: 'transient' },
  })
  telemetry.emit({
    ts: at(1200), level: 'error', event: 'attempt.finished', phase: 'attempt', traceId: 'trace-cli',
    taskId: task.id, attempt: 1, status: 'failed', durationMs: 1200,
    error: { code: 'timeout', kind: 'transient' },
  })
  telemetry.beginAttempt({
    taskId: task.id, attempt: 1, traceId: 'trace-cli', executor: 'dsh',
    startedAt: at(0),
  })
  telemetry.finishAttempt(task.id, 1, {
    outcome: 'failed', failureKind: 'transient', errorCode: 'timeout',
    finishedAt: at(1200),
  })
  telemetry.beginAttempt({
    taskId: task.id, attempt: 2, traceId: 'trace-cli', executor: 'dsh', startedAt: at(2000),
  })
  telemetry.finishAttempt(task.id, 2, {
    outcome: 'succeeded', summary: '已完成读取', finishedAt: at(2600),
  })

  telemetry.emit({
    ts: at(3000), level: 'info', event: 'attempt.started', phase: 'attempt', traceId: 'trace-other',
    taskId: other.id, attempt: 1, status: 'running',
  })
  telemetry.emit({
    ts: at(3100), level: 'error', event: 'executor.finished', phase: 'execute', traceId: 'trace-other',
    taskId: other.id, attempt: 1, status: 'failed', durationMs: 100,
    error: { code: 'policy-denied', kind: 'permission' },
  })
  telemetry.beginAttempt({
    taskId: other.id, attempt: 1, traceId: 'trace-other', executor: 'dsh', startedAt: at(3000),
  })
  // No errorCode: this is exactly the "unknown failure" the metric must expose.
  telemetry.finishAttempt(other.id, 1, { outcome: 'failed', finishedAt: at(3100) })

  await telemetry.flush()

  const env = { DSH_WFXM_DATA_DIR: dir, DSH_WFXM_DB: dbPath }

  check('metric aggregation stays 3 lines and exposes the unknown failure', () => {
    const events = telemetry.query({ from: at(-1), to: at(86_400_000), limit: 5_000 }).rows
    const attempts = telemetry.attemptsSince({ from: at(-1), to: at(86_400_000) })
    const metrics = computeTraceMetrics({ events, attempts })
    assert.equal(metrics.events, 9)
    assert.equal(metrics.attempts, 3)
    assert.equal(metrics.failedAttempts, 2)
    assert.equal(metrics.diagnosable, 1)
    assert.equal(metrics.diagnosableRate, 0.5)
    assert.deepEqual(metrics.errorCodes.find((item) => item.code === 'timeout'), { code: 'timeout', count: 2 })
    assert.equal(metrics.failurePhases.find((item) => item.phase === 'execute').count, 2)
    assert.equal(metrics.durationP50Ms, 600)
    assert.equal(metrics.durationP95Ms, 1200)
    assert.equal(metrics.toolCalls, 1)
    assert.equal(metrics.toolFailures, 0)
    assert.equal(metrics.executorFailures, 2)
    const text = formatTraceWeekly(metrics)
    assert.equal(text.split('\n').length, 3)
    assert.match(text, /可诊断 1\/2（50%）/)
    assert.match(text, /timeout 2/)
    assert.match(text, /时延 p50 600ms · p95 1\.2s/)
  })

  check('attemptsSince filters the window', () => {
    // Task 2 started 2s after task 1; a window that ends before it sees only one.
    const early = telemetry.attemptsSince({ from: at(-1), to: at(2000) })
    assert.equal(early.length, 1)
    assert.equal(early[0].attempt, 1)
  })

  check('query resolves taskRef and filters by error code', () => {
    const byTask = runCli(env, ['query', '--task', task.taskRef, '--json'])
    assert.equal(byTask.status, 0, byTask.stderr)
    const parsed = JSON.parse(byTask.stdout)
    assert.equal(parsed.count, 7)
    assert.ok(parsed.rows.every((row) => row.taskId === task.id))

    const byError = runCli(env, ['query', '--error', 'timeout', '--json'])
    assert.equal(byError.status, 0, byError.stderr)
    assert.equal(JSON.parse(byError.stdout).count, 2)

    const byLevel = runCli(env, ['query', '--level', 'error', '--since', '24h', '--json'])
    assert.equal(byLevel.status, 0, byLevel.stderr)
    assert.equal(JSON.parse(byLevel.stdout).count, 3)
  })

  check('show prints attempts and the chronological timeline', () => {
    const shown = runCli(env, ['show', task.taskRef])
    assert.equal(shown.status, 0, shown.stderr)
    assert.match(shown.stdout, /追踪：trace-cli/)
    assert.match(shown.stdout, /尝试：/)
    assert.match(shown.stdout, /#1 failed/)
    assert.match(shown.stdout, /#2 succeeded/)
    assert.match(shown.stdout, /时间线（7 条）/)
    const start = shown.stdout.indexOf('attempt.started')
    const end = shown.stdout.indexOf('attempt.finished')
    assert.ok(start !== -1 && end > start, 'timeline must be ascending')
  })

  check('show falls back to a trace id and reports unknown refs', () => {
    const traceOnly = runCli(env, ['show', 'trace-other'])
    assert.equal(traceOnly.status, 0, traceOnly.stderr)
    assert.match(traceOnly.stdout, /没有关联任务记录/)
    const missing = runCli(env, ['show', 'nope-nope'])
    assert.equal(missing.status, 1)
    assert.match(missing.stderr, /no task or trace matches/)
  })

  check('stats prints window, metrics and telemetry state', () => {
    const stats = runCli(env, ['stats', '--json'])
    assert.equal(stats.status, 0, stats.stderr)
    const parsed = JSON.parse(stats.stdout)
    assert.equal(parsed.metrics.events, 9)
    assert.equal(parsed.metrics.diagnosable, 1)
    assert.equal(parsed.telemetry.mode, 'meta')

    const text = runCli(env, ['stats'])
    assert.equal(text.status, 0, text.stderr)
    assert.match(text.stdout, /窗口：/)
    assert.match(text.stdout, /可诊断 1\/2/)
    assert.match(text.stdout, /遥测：meta/)
  })

  check('export writes agent-eval compatible ndjson + draft', () => {
    const out = join(dir, 'eval', 'trajectory')
    const exported = runCli(env, [
      'export', task.taskRef, '--repo-root', dir, '--out', out, '--label', 'prod',
    ])
    assert.equal(exported.status, 0, exported.stderr)
    const names = readdirSync(out)
    const ndjsonName = names.find((name) => name.endsWith('.ndjson'))
    assert.ok(ndjsonName, `no ndjson in ${names.join(',')}`)
    assert.match(ndjsonName, /^dsh-prod-[0-9a-f]{8}\.ndjson$/)
    const lines = readFileSync(join(out, ndjsonName), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line))
    assert.equal(lines[0].type, 'session')
    assert.match(lines[0].sessionId, /^prod-[0-9a-f]{8}$/)
    assert.ok(lines.some((line) => line.type === 'tool_call' && line.name === 'read'))
    assert.ok(lines.some((line) => line.type === 'tool_result' && line.ok === true))
    assert.ok(lines.some((line) => line.type === 'status' && line.phase === 'step_end'))
    assert.ok(lines.some((line) => line.type === 'final' && line.text.includes('已完成读取')))

    const draft = JSON.parse(readFileSync(join(out, ndjsonName.replace(/\.ndjson$/, '.json')), 'utf8'))
    assert.equal(draft.suite, 'dsh-trajectory')
    assert.equal(draft.taxonomy, 'online-replay')
    assert.deepEqual(draft.expect.requiredTools, ['read'])
    assert.equal(draft.runtimeHints.dsh.traceFile, `eval/trajectory/${ndjsonName}`)
    assert.ok(existsSync(join(out, ndjsonName)))
  })

  check('export refuses an output directory outside --repo-root', () => {
    const rejected = runCli(env, [
      'export', task.taskRef, '--repo-root', join(dir, 'repo'), '--out', join(dir, 'outside'),
    ])
    assert.equal(rejected.status, 1)
    assert.match(rejected.stderr, /inside --repo-root/)
  })

  check('a task with no events cannot be exported', () => {
    const empty = tasks.createTask({ intent: 'empty', riskLevel: 'R1', maxAttempts: 1 })
    const rejected = runCli(env, ['export', empty.taskRef, '--repo-root', dir, '--out', join(dir, 'trajectory')])
    assert.equal(rejected.status, 1)
    assert.match(rejected.stderr, /no trace events/)
  })
} finally {
  try {
    tasks.close()
  } catch {
    // already closed
  }
  telemetry.close()
  rmSync(dir, { recursive: true, force: true })
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
