#!/usr/bin/env node
/**
 * Instrumentation suite (P6-1, docs/15 §十三).
 *
 * Proves one task can be reconstructed from telemetry alone: task → attempt →
 * step → tool_call, plus Verifier, isolation commit, failure codes, retries,
 * real dsh NDJSON parsing and the non-blocking contract.
 *
 * The suite uses the real task store, worker, executor and telemetry store in a
 * throwaway SQLite database; only the dsh binary is stubbed.
 */
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTelemetryStore } from '../lib/index.js'
import { createGatewayStore } from '../../gateway/lib/index.js'
import { createDshExecutor } from '../../executor/lib/index.js'
import { createTaskStore, createTaskWorker } from '../../tasks/lib/index.js'

let pass = 0
let fail = 0

async function check(label, fn) {
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
  const dir = mkdtempSync(join(tmpdir(), 'telemetry-instrumentation-'))
  const dbPath = join(dir, 'ops.sqlite')
  const telemetry = createTelemetryStore({
    dbPath,
    traceDir: join(dir, 'traces'),
    flushIntervalMs: 60_000,
    mode: 'meta',
  })
  const tasks = createTaskStore(dbPath)
  try {
    await fn({ dir, dbPath, telemetry, tasks })
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

function rowsOf(telemetry, traceId) {
  return telemetry.query({ traceId, limit: 500 }).rows
}

function eventOf(rows, name) {
  const found = rows.filter((row) => row.event === name)
  assert.equal(found.length, 1, `expected exactly one ${name}, got ${found.length}`)
  return found[0]
}

function assertParent(row, parentSpanId) {
  assert.equal(row.parentSpanId, parentSpanId, `${row.event} parentSpanId`)
}

function okExecutor(usage = { inputTokens: 10, outputTokens: 5, costUsd: 0 }) {
  return () => ({ status: 'succeeded', summary: 'done', usage })
}

// ---- 1. full span tree -----------------------------------------------------

await check('one task reconstructs task → attempt → verify with a shared trace', async () => {
  await withEnv(async ({ telemetry, tasks }) => {
    const task = tasks.createTask({
      intent: 'say hi',
      riskLevel: 'R1',
      correlationId: 'tr-e2e',
    })
    const worker = createTaskWorker({ store: tasks, execute: okExecutor(), telemetry })
    const report = await worker.runOnce()
    await telemetry.flush()
    assert.equal(report.outcome, 'succeeded')

    const rows = rowsOf(telemetry, 'tr-e2e')
    const taskSpan = `task:${task.id}`
    const attemptSpan = `attempt:${task.id}:1`
    const claimed = eventOf(rows, 'task.claimed')
    const started = eventOf(rows, 'attempt.started')
    const verify = eventOf(rows, 'verify.started')
    const verifyOk = eventOf(rows, 'verify.succeeded')
    const finished = eventOf(rows, 'attempt.finished')
    const settled = eventOf(rows, 'task.settled')

    assert.equal(claimed.spanId, taskSpan)
    assertParent(claimed, 'tr-e2e')
    assert.equal(started.spanId, attemptSpan)
    assertParent(started, taskSpan)
    assertParent(verify, attemptSpan)
    assertParent(verifyOk, attemptSpan)
    assert.equal(finished.status, 'succeeded')
    assertParent(finished, taskSpan)
    assert.equal(settled.status, 'succeeded')
    assertParent(settled, 'tr-e2e')

    const attempts = telemetry.attempts(task.id)
    assert.equal(attempts.length, 1)
    assert.equal(attempts[0].outcome, 'succeeded')
    assert.equal(attempts[0].traceId, 'tr-e2e')
  })
})

// ---- 2. failures still land an attempt + error code ------------------------

await check('a failure records attempt.finished(level=error) and error_code', async () => {
  await withEnv(async ({ telemetry, tasks }) => {
    const task = tasks.createTask({
      intent: 'bad input',
      riskLevel: 'R1',
      maxAttempts: 1,
      correlationId: 'tr-fail',
    })
    const worker = createTaskWorker({
      store: tasks,
      telemetry,
      execute: () => ({ status: 'failed', failure: 'invalid_input', summary: 'missing target' }),
    })
    const report = await worker.runOnce()
    await telemetry.flush()
    assert.equal(report.outcome, 'failed')

    const rows = rowsOf(telemetry, 'tr-fail')
    const finished = eventOf(rows, 'attempt.finished')
    assert.equal(finished.level, 'error')
    assert.equal(finished.status, 'failed')
    assert.equal(finished.error.code, 'invalid_input')
    assert.equal(eventOf(rows, 'task.settled').status, 'failed')

    const attempts = telemetry.attempts(task.id)
    assert.equal(attempts.length, 1)
    assert.equal(attempts[0].outcome, 'failed')
    assert.equal(attempts[0].errorCode, 'invalid_input')
  })
})

// ---- 3. retry starts a second attempt --------------------------------------

await check('a transient failure retries as attempt 2 on the same trace', async () => {
  await withEnv(async ({ telemetry, tasks }) => {
    const task = tasks.createTask({
      intent: 'retry me',
      riskLevel: 'R1',
      maxAttempts: 2,
      correlationId: 'tr-retry',
    })
    let calls = 0
    const worker = createTaskWorker({
      store: tasks,
      telemetry,
      backoffMs: [0],
      execute: () => {
        calls += 1
        return calls === 1
          ? { status: 'failed', failure: 'transient', summary: 'network' }
          : { status: 'succeeded', summary: 'done' }
      },
    })
    await worker.runOnce()
    await worker.runOnce()
    await telemetry.flush()

    const attempts = telemetry.attempts(task.id)
    assert.equal(attempts.length, 2)
    assert.equal(attempts[0].outcome, 'failed')
    assert.equal(attempts[1].outcome, 'succeeded')
    assert.ok(attempts.every((row) => row.traceId === 'tr-retry'))
    assert.ok(rowsOf(telemetry, 'tr-retry').some((row) => row.event === 'task.settled'))
  })
})

// ---- 4. Verifier failure ---------------------------------------------------

await check('a failing Verifier emits verify.failed with the failing code', async () => {
  await withEnv(async ({ telemetry, tasks, dir }) => {
    const task = tasks.createTask({
      intent: 'verify me',
      riskLevel: 'R1',
      correlationId: 'tr-verify',
    })
    tasks.addAssertion(task.id, {
      kind: 'file_exists',
      spec: { path: join(dir, 'definitely-missing-file') },
    })
    const worker = createTaskWorker({ store: tasks, execute: okExecutor(), telemetry })
    const report = await worker.runOnce()
    await telemetry.flush()
    assert.equal(report.outcome, 'failed')

    const rows = rowsOf(telemetry, 'tr-verify')
    const failed = eventOf(rows, 'verify.failed')
    assert.equal(failed.error.code, 'verification-failed')
    assert.equal(eventOf(rows, 'attempt.finished').error.code, 'verification-failed')
    assert.equal(telemetry.attempts(task.id)[0].outcome, 'failed')
  })
})

// ---- 5. isolation commit failure ------------------------------------------

await check('a missing worktree emits isolation.commit.failed', async () => {
  await withEnv(async ({ telemetry, tasks, dir }) => {
    const task = tasks.createTask({
      intent: 'commit me',
      riskLevel: 'R1',
      correlationId: 'tr-commit',
    })
    tasks.setIsolation(task.id, {
      isolation: 'worktree',
      worktreePath: join(dir, 'missing-worktree'),
      baseCommit: 'deadbeef',
      branch: 'wfxm/test',
    })
    const worker = createTaskWorker({ store: tasks, execute: okExecutor(), telemetry })
    const report = await worker.runOnce()
    await telemetry.flush()
    assert.equal(report.outcome, 'failed')

    const rows = rowsOf(telemetry, 'tr-commit')
    const failed = eventOf(rows, 'isolation.commit.failed')
    assert.equal(failed.error.code, 'commit-failed')
    assert.equal(eventOf(rows, 'attempt.finished').error.code, 'commit-failed')
    assert.equal(telemetry.attempts(task.id)[0].outcome, 'failed')
  })
})

// ---- 6. real executor parses dsh NDJSON -----------------------------------

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

await check('the real executor emits step and tool spans from dsh NDJSON', async () => {
  await withEnv(async ({ dir, telemetry, tasks }) => {
    const dshBin = writeStubDsh(dir, [
      { type: 'session', sessionId: 'sess-1' },
      { type: 'tool_call', tool: 'fs.read', input: { path: 'a.txt' }, id: 'call-1' },
      { type: 'tool_result', tool: 'fs.read', ok: true, durationMs: 4, id: 'call-1' },
      { type: 'status', phase: 'step_end', usage: { inputTokens: 7, outputTokens: 3 } },
      { type: 'final', text: 'done' },
    ])
    const task = tasks.createTask({
      intent: 'run the stub',
      riskLevel: 'R1',
      correlationId: 'tr-exec',
    })
    const executor = createDshExecutor({ dshBin, telemetry, defaultWorkdir: dir })
    const worker = createTaskWorker({ store: tasks, execute: executor, telemetry })
    const report = await worker.runOnce()
    await telemetry.flush()
    assert.equal(report.outcome, 'succeeded')

    const rows = rowsOf(telemetry, 'tr-exec')
    const started = eventOf(rows, 'executor.started')
    const step = eventOf(rows, 'executor.step')
    const call = eventOf(rows, 'tool.call')
    const result = eventOf(rows, 'tool.result')
    const finished = eventOf(rows, 'executor.finished')
    const attemptSpan = `attempt:${task.id}:1`
    assertParent(started, `task:${task.id}`)
    assertParent(step, attemptSpan)
    assert.equal(step.model.inputTokens, 7)
    assert.equal(step.model.outputTokens, 3)
    assert.equal(call.tool.name, 'fs.read')
    assertParent(call, step.spanId)
    assertParent(result, step.spanId)
    assert.equal(finished.status, 'succeeded')
    assertParent(finished, `task:${task.id}`)
  })
})

// ---- 7. telemetry never blocks the task -----------------------------------

await check('throwing telemetry ports do not change the task outcome', async () => {
  await withEnv(async ({ tasks, telemetry }) => {
    const task = tasks.createTask({
      intent: 'telemetry is down',
      riskLevel: 'R1',
      correlationId: 'tr-broken',
    })
    const broken = {
      emit() { throw new Error('emit exploded') },
      beginAttempt() { throw new Error('begin exploded') },
      finishAttempt() { throw new Error('finish exploded') },
    }
    const errors = []
    const worker = createTaskWorker({
      store: tasks,
      execute: okExecutor(),
      telemetry: broken,
      onError: (error) => errors.push(error),
    })
    const report = await worker.runOnce()
    assert.equal(report.outcome, 'succeeded')
    assert.equal(tasks.getTask(task.id).status, 'succeeded')
    assert.ok(errors.length > 0, 'telemetry errors should surface through onError')
    assert.equal(telemetry.attempts(task.id).length, 0)
  })
})

// ---- 8. delivery failure hook ---------------------------------------------

await check('dispatcher calls onFailed with retry/final semantics', async () => {
  await withEnv(async ({ dbPath }) => {
    const gateway = createGatewayStore(dbPath)
    try {
      gateway.enqueueOutbox({
        topic: 'say',
        payload: { text: 'hello' },
        threadId: null,
      })
    } catch {
      // threadId null may be rejected; re-enqueue with a thread below.
    }
    const seen = []
    const dispatcher = (await import('../../gateway/lib/index.js')).createOutboxDispatcher({
      store: gateway,
      transport: {
        transport: 'test',
        async send() { throw new Error('channel offline') },
      },
      onFailed: (item, detail) => seen.push({ item, detail }),
    })
    const report = await dispatcher.runOnce()
    assert.equal(report.claimed, 1)
    assert.equal(seen.length, 1)
    assert.equal(seen[0].detail.retryable, true)
    assert.equal(seen[0].detail.final, false)
    gateway.close()
  })
})

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
