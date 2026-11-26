#!/usr/bin/env node
/**
 * Telemetry contract suite (P6-0, docs/15 §十二).
 *
 * Covers the schema, correlation fields, redaction defaults, non-blocking
 * queue + drop accounting, quota degradation, disk watermark, attempt
 * lifecycle, read API and retention pruning.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import DatabaseConstructor from 'better-sqlite3'
import {
  DEFAULT_DAILY_LIMIT_BYTES,
  DEFAULT_PER_TASK_LIMIT_BYTES,
  TelemetryError,
  createTelemetryStore,
  dayKey,
  digestText,
  normalizeTelemetryEvent,
  resolveTelemetryMode,
  validateTelemetryEvent,
} from '../lib/index.js'

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

async function withStore(options, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'telemetry-'))
  const store = createTelemetryStore({
    dbPath: join(dir, 'ops.sqlite'),
    flushIntervalMs: 60_000,
    ...options,
  })
  try {
    await fn(store, dir)
  } finally {
    try {
      store.close()
    } catch {
      // A test may already have closed it.
    }
    rmSync(dir, { recursive: true, force: true })
  }
}

function event(overrides = {}) {
  return {
    event: 'task.step',
    traceId: 'tr_test',
    phase: 'execute',
    ...overrides,
  }
}

const now = new Date('2026-11-26T00:00:00.000Z')

// ---- schema ----------------------------------------------------------------

await check('migration creates trace_events/task_attempts/usage/drops at v1', async () => {
  await withStore({ mode: 'meta' }, async (store, dir) => {
    store.close()
    const db = new DatabaseConstructor(join(dir, 'ops.sqlite'), { readonly: true })
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => row.name)
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
      .all()
      .map((row) => row.name)
    const version = db
      .prepare("SELECT version FROM schema_migrations WHERE module = 'telemetry'")
      .get()
    db.close()
    assert.ok(tables.includes('trace_events'))
    assert.ok(tables.includes('task_attempts'))
    assert.ok(tables.includes('telemetry_usage'))
    assert.ok(tables.includes('telemetry_drops'))
    assert.ok(indexes.includes('ix_trace_events_task'))
    assert.ok(indexes.includes('ix_trace_events_error'))
    assert.ok(indexes.includes('ux_task_attempts_key'))
    assert.equal(version.version, 1)
  })
})

// ---- schema contract -------------------------------------------------------

await check('invalid events are rejected and counted, emit never throws', async () => {
  await withStore({ mode: 'meta' }, async (store) => {
    assert.equal(store.emit({ level: 'error', event: 'x', phase: 'p' }), false)
    assert.equal(store.emit({ event: 'x', traceId: 't' }), false)
    assert.equal(store.emit({ level: 'error', event: 'x', traceId: 't', phase: 'p' }), false)
    assert.equal(store.emit(event()), true)
    await store.flush()
    const stats = store.stats()
    assert.equal(stats.dropped.invalid, 3)
    assert.equal(store.query().count, 1)
  })
})

await check('normalisation: time forms, span id, attr whitelist', async () => {
  const numeric = normalizeTelemetryEvent(
    event({ ts: 0, attrs: { channel: 'feishu', bogus: 'drop-me' } }),
    now,
  )
  assert.equal(numeric.ts, new Date(0).toISOString())
  assert.ok(numeric.spanId.length > 0)
  assert.deepEqual(numeric.attrs, { channel: 'feishu' })

  const invalidTime = normalizeTelemetryEvent(event({ ts: 'not-a-date' }), now)
  assert.equal(invalidTime.ts, now.toISOString())

  const dateTime = normalizeTelemetryEvent(event({ ts: new Date('2026-01-02T03:04:05.000Z') }), now)
  assert.equal(dateTime.ts, '2026-01-02T03:04:05.000Z')

  assert.throws(
    () => validateTelemetryEvent({ event: 'x', phase: 'p' }),
    (error) => error instanceof TelemetryError && error.code === 'invalid-event',
  )
})

await check('meta stores digests only; full stores re-redacted text', async () => {
  const message = 'password: "hunter2hunter2"'
  const stack = 'Error: boom\n  at sk-abcdefghijklmnopqrst'
  const digest = createHash('sha256').update(message).digest('hex')

  await withStore({ mode: 'meta' }, async (store) => {
    assert.equal(
      store.emit(
        event({ level: 'error', error: { code: 'E_AUTH', message, stack }, attrs: { channel: 'sk-abcdefghijklmnopqrst' } }),
      ),
      true,
    )
    await store.flush()
    const row = store.query().rows[0]
    assert.equal(row.error.code, 'E_AUTH')
    assert.equal(row.error.message, null)
    assert.equal(row.error.stack, null)
    assert.equal(row.error.messageDigest, digest)
    assert.equal(row.attrs, null)
    assert.ok(row.error.stackDigest !== null)
  })

  await withStore({ mode: 'full' }, async (store) => {
    assert.equal(
      store.emit(
        event({ level: 'error', error: { code: 'E_AUTH', message, stack }, attrs: { channel: 'sk-abcdefghijklmnopqrst' } }),
      ),
      true,
    )
    await store.flush()
    const row = store.query().rows[0]
    assert.ok(row.error.message.includes('[redacted:'))
    assert.ok(!row.error.message.includes('hunter2hunter2'))
    assert.ok(row.error.stack.includes('[redacted:'))
    assert.equal(row.error.messageDigest, digest)
    assert.ok(row.attrs.channel.includes('[redacted:'))
    assert.equal(row.attrs.bogus, undefined)
  })
})

// ---- queue / quota / watermark --------------------------------------------

await check('bounded queue drops instead of blocking the caller', async () => {
  await withStore({ mode: 'meta', queueLimit: 5, batchSize: 200 }, async (store) => {
    const results = []
    for (let index = 0; index < 10; index += 1) results.push(store.emit(event({ spanId: `s${index}` })))
    assert.deepEqual(results.slice(0, 5), [true, true, true, true, true])
    assert.deepEqual(results.slice(5), [false, false, false, false, false])
    await store.flush()
    assert.equal(store.query().count, 5)
    assert.equal(store.stats().dropped['queue-full'], 5)
  })
})

await check('per-task and daily quotas drop with reasons', async () => {
  await withStore({ mode: 'meta', perTaskLimitBytes: 1 }, async (store) => {
    assert.equal(store.emit(event({ taskId: 't1' })), true)
    await store.flush()
    assert.equal(store.query().count, 0)
    assert.equal(store.stats().dropped['task-quota'], 1)
  })

  await withStore({ mode: 'meta', dailyLimitBytes: 1, perTaskLimitBytes: DEFAULT_PER_TASK_LIMIT_BYTES }, async (store) => {
    assert.equal(store.emit(event()), true)
    await store.flush()
    assert.equal(store.query().count, 0)
    assert.equal(store.stats().dropped['daily-quota'], 1)
  })

  assert.ok(DEFAULT_DAILY_LIMIT_BYTES >= DEFAULT_PER_TASK_LIMIT_BYTES)
})

await check('disk watermark degrades full to meta without losing the event', async () => {
  await withStore(
    { mode: 'full', diskUsage: () => ({ usedBytes: 90, totalBytes: 100 }) },
    async (store) => {
      assert.equal(
        store.emit(event({ level: 'error', error: { code: 'E1', message: 'password: "hunter2hunter2"' } })),
        true,
      )
      await store.flush()
      const row = store.query().rows[0]
      assert.equal(row.error.message, null)
      assert.ok(row.error.messageDigest !== null)
      assert.equal(store.stats().degraded, true)
    },
  )
})

// ---- attempts --------------------------------------------------------------

await check('attempt lifecycle is idempotent and redacts the summary', async () => {
  await withStore({ mode: 'meta' }, async (store) => {
    const first = store.beginAttempt({
      taskId: 'task-1',
      attempt: 0,
      traceId: 'tr_1',
      executor: 'dsh',
      startedAt: '2026-11-01T00:00:00.000Z',
    })
    assert.equal(first.outcome, 'running')
    assert.equal(first.executor, 'dsh')

    const again = store.beginAttempt({
      taskId: 'task-1',
      attempt: 0,
      traceId: 'tr_1',
      executor: 'other',
      startedAt: '2026-11-09T00:00:00.000Z',
    })
    assert.equal(again.startedAt, first.startedAt)
    assert.equal(again.executor, 'other')

    assert.equal(
      store.finishAttempt('task-1', 0, {
        outcome: 'failed',
        errorCode: 'E_TIMEOUT',
        failureKind: 'transient',
        summary: 'password: "hunter2hunter2"',
        finishedAt: '2026-11-01T00:01:00.000Z',
      }),
      true,
    )
    const done = store.getAttempt('task-1', 0)
    assert.equal(done.outcome, 'failed')
    assert.equal(done.errorCode, 'E_TIMEOUT')
    assert.ok(done.summary.includes('[redacted:'))
    assert.ok(!done.summary.includes('hunter2hunter2'))

    assert.equal(store.finishAttempt('task-1', 0, { outcome: 'succeeded' }), false)
    assert.equal(store.attempts('task-1').length, 1)
  })
})

// ---- reads -----------------------------------------------------------------

await check('queries correlate by task, trace, error code and level', async () => {
  await withStore({ mode: 'meta' }, async (store) => {
    store.emit(event({ taskId: 'a', traceId: 'tr_a', spanId: 's1', ts: '2026-11-24T00:00:00.000Z' }))
    store.emit(
      event({
        taskId: 'a',
        traceId: 'tr_a',
        spanId: 's2',
        level: 'error',
        error: { code: 'E_BOOM' },
        ts: '2026-11-25T00:00:00.000Z',
      }),
    )
    store.emit(event({ taskId: 'b', traceId: 'tr_b', spanId: 's3', ts: '2026-11-26T00:00:00.000Z' }))
    await store.flush()

    assert.equal(store.query({ taskId: 'a' }).count, 2)
    assert.equal(store.query({ traceId: 'tr_a' }).count, 2)
    assert.equal(store.query({ errorCode: 'E_BOOM' }).count, 1)
    assert.equal(store.query({ level: 'error' }).count, 1)
    assert.equal(store.query({ from: '2026-11-25T00:00:00.000Z' }).count, 2)
    assert.equal(store.query({ limit: 2 }).rows.length, 2)
  })
})

// ---- retention -------------------------------------------------------------

await check('prune drops 14-day rows and 7-day files, keeping fresh data', async () => {
  const oldDate = new Date(now.getTime() - 20 * 86_400_000)
  const fileOld = new Date(now.getTime() - 10 * 86_400_000)
  const fileFresh = new Date(now.getTime() - 1 * 86_400_000)
  const dir = mkdtempSync(join(tmpdir(), 'telemetry-'))
  const traceDir = join(dir, 'traces')
  const oldDir = join(traceDir, dayKey(fileOld).replaceAll('-', ''))
  const freshDir = join(traceDir, dayKey(fileFresh).replaceAll('-', ''))
  mkdirSync(oldDir, { recursive: true })
  mkdirSync(freshDir, { recursive: true })
  const store = createTelemetryStore({
    dbPath: join(dir, 'ops.sqlite'),
    traceDir,
    mode: 'meta',
    now: () => now,
    retentionDays: 14,
    fileRetentionDays: 7,
    flushIntervalMs: 60_000,
  })
  try {
    store.emit(event({ ts: oldDate.toISOString(), spanId: 'old' }))
    store.emit(event({ ts: now.toISOString(), spanId: 'fresh' }))
    await store.flush()
    store.beginAttempt({ taskId: 'old-task', attempt: 0, traceId: 'tr_old', startedAt: oldDate })
    store.finishAttempt('old-task', 0, { outcome: 'failed', finishedAt: oldDate })

    const pruned = store.prune({ now })
    assert.equal(pruned.events, 1)
    assert.equal(pruned.attempts, 1)
    assert.equal(pruned.files, 1)
    assert.equal(store.query().count, 1)
    assert.equal(store.attempts('old-task').length, 0)
    assert.equal(existsSync(oldDir), false)
    assert.equal(existsSync(freshDir), true)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---- mode ------------------------------------------------------------------

await check('off drops everything; mode parsing is strict', async () => {
  await withStore({ mode: 'off' }, async (store) => {
    assert.equal(store.emit(event()), false)
    await store.flush()
    assert.equal(store.query().count, 0)
    assert.equal(store.stats().dropped.disabled, 1)
  })

  const previous = process.env.DSH_WFXM_TRACE
  delete process.env.DSH_WFXM_TRACE
  try {
    assert.equal(resolveTelemetryMode(), 'meta')
    assert.equal(resolveTelemetryMode('FULL'), 'full')
    assert.equal(resolveTelemetryMode('off'), 'off')
    assert.throws(
      () => resolveTelemetryMode('debug'),
      (error) => error instanceof TelemetryError && error.code === 'invalid-mode',
    )
  } finally {
    if (previous === undefined) delete process.env.DSH_WFXM_TRACE
    else process.env.DSH_WFXM_TRACE = previous
  }
})

await check('emit after close is dropped, not thrown', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'telemetry-'))
  const store = createTelemetryStore({ dbPath: join(dir, 'ops.sqlite'), mode: 'meta', flushIntervalMs: 60_000 })
  store.close()
  assert.equal(store.emit(event()), false)
  rmSync(dir, { recursive: true, force: true })
})

assert.equal(digestText('abc'), createHash('sha256').update('abc').digest('hex'))

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
