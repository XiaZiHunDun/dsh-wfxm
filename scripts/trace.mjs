#!/usr/bin/env node
/**
 * P6-3 trace query/export CLI (docs/15 §十五).
 *
 *   node scripts/trace.mjs query [--task <id|ref>] [--trace <id>] [--error <code>]
 *                                [--level <debug|info|warn|error>] [--since <iso|24h>]
 *                                [--until <iso|1h>] [--limit N] [--json]
 *   node scripts/trace.mjs show <task|trace> [--limit N]
 *   node scripts/trace.mjs stats [--since <iso|24h>] [--until <iso|1h>] [--json]
 *   node scripts/trace.mjs export <task> [--out eval/trajectory] [--repo-root <dir>]
 *                                       [--label <name>] [--dry-run]
 *
 * `export` writes the agent-eval trajectory shape (session / tool_call /
 * tool_result / status / final) plus a draft task JSON. Everything is read
 * from the same store the service writes; the CLI is read-only.
 */

import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { redactText } from '../plugins/redact/lib/index.js'
import { createTaskStore } from '@dsh-wfxm/tasks'
import {
  computeTraceMetrics,
  createTelemetryStore,
  formatDurationMs,
  formatTraceWeekly,
} from '@dsh-wfxm/telemetry'
import { parseServeConfig } from './lib/startup.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const UNIT_MS = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1_000 }
const LEVELS = new Set(['debug', 'info', 'warn', 'error'])

function usage() {
  return [
    'usage:',
    '  trace.mjs query [--task <id|ref>] [--trace <id>] [--error <code>]',
    '                  [--level <debug|info|warn|error>] [--since <iso|24h>]',
    '                  [--until <iso|1h>] [--limit N] [--json]',
    '  trace.mjs show <task|trace> [--limit N]',
    '  trace.mjs stats [--since <iso|24h>] [--until <iso|1h>] [--json]',
    '  trace.mjs export <task> [--out eval/trajectory] [--repo-root <dir>]',
    '                        [--label <name>] [--dry-run]',
  ].join('\n')
}

function iso(value) {
  return new Date(value).toISOString()
}

/** ISO timestamps pass through; `24h` / `7d` / `30m` are relative to now. */
function parseTime(raw, field) {
  if (raw === undefined) return undefined
  const relative = /^(\d+)([dhms])$/.exec(raw)
  if (relative !== null) {
    return iso(Date.now() - Number(relative[1]) * UNIT_MS[relative[2]])
  }
  const parsed = Date.parse(raw)
  if (Number.isNaN(parsed)) throw new Error(`${field} is not ISO time or a duration like 24h: ${raw}`)
  return iso(parsed)
}

function parseOptions(argv, known) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) throw new Error(`unexpected argument ${token}`)
    const name = token.slice(2)
    if (!known.has(name)) throw new Error(`unknown option --${name}`)
    if (name === 'json' || name === 'dry-run') {
      options[name] = true
      continue
    }
    const value = argv[index + 1]
    if (value === undefined) throw new Error(`--${name} needs a value`)
    options[name] = value
    index += 1
  }
  return options
}

function hash8(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 8)
}

/** Absolute paths never leave the host, even in a `full`-mode export. */
function scrub(text) {
  return redactText(text).value
    .replace(/(?:\/home|\/Users|\/root|\/opt|\/var|\/srv|\/tmp|\/etc)\/[^\s"'`<>，。；：)）\]]+/g, '<path>')
    .replace(/[A-Za-z]:\\[^\s"'`<>]+/g, '<path>')
    .replace(/\s+/g, ' ')
    .trim()
}

function findTask(tasks, ref) {
  const direct = tasks.getTask(ref)
  if (direct !== null) return direct
  const listed = tasks.listTasks()
  return listed.find((task) => task.taskRef === ref)
    ?? listed.find((task) => task.id.startsWith(ref))
    ?? null
}

function formatRow(row) {
  const status = row.status ?? '-'
  const code = row.error?.code ?? ''
  return [
    row.ts,
    row.level.padEnd(5),
    row.event.padEnd(22),
    row.phase.padEnd(9),
    status.padEnd(9),
    formatDurationMs(row.durationMs).padEnd(7),
    code,
  ].join(' ').trimEnd()
}

function printTimeline(rows, limit) {
  const ordered = [...rows].sort((a, b) => a.ts.localeCompare(b.ts))
  if (ordered.length === 0) {
    console.log('时间线：没有事件。')
    return
  }
  console.log(`时间线（${ordered.length} 条${ordered.length >= limit ? '，已达上限' : ''}）：`)
  for (const row of ordered) console.log(`  ${formatRow(row)}`)
}

function printAttempts(attempts) {
  if (attempts.length === 0) return
  console.log('尝试：')
  for (const attempt of attempts) {
    const finished = attempt.finishedAt === null
      ? '-'
      : formatDurationMs(Date.parse(attempt.finishedAt) - Date.parse(attempt.startedAt))
    console.log(
      `  #${attempt.attempt} ${attempt.outcome.padEnd(9)} ${finished.padEnd(7)} `
        + `${attempt.errorCode ?? attempt.failureKind ?? '-'} · ${attempt.executor ?? '-'}`
        + `${attempt.model === null ? '' : ` / ${attempt.model}`}`,
    )
  }
}

function reportQuery(rows, count, limit) {
  console.log(`共 ${count} 条${count > rows.length ? `，显示最近 ${rows.length} 条（--limit ${limit}）` : ''}`)
  for (const row of rows) console.log(formatRow(row))
}

function queryRows(telemetry, input) {
  const result = telemetry.query(input)
  return { rows: result.rows, count: result.count }
}

function commandQuery(telemetry, tasks, argv) {
  const options = parseOptions(argv, new Set(['task', 'trace', 'error', 'level', 'since', 'until', 'limit', 'json']))
  const limit = Math.min(5_000, Math.max(1, Number(options.limit ?? '100') || 100))
  let taskId = options.task
  if (taskId !== undefined) {
    const task = findTask(tasks, taskId)
    if (task === null) throw new Error(`task ${options.task} not found`)
    taskId = task.id
  }
  if (options.level !== undefined && !LEVELS.has(options.level)) {
    throw new Error(`--level must be one of ${[...LEVELS].join(', ')}`)
  }
  const from = parseTime(options.since, '--since')
  const to = parseTime(options.until, '--until')
  const input = {
    ...taskId === undefined ? {} : { taskId },
    ...options.trace === undefined ? {} : { traceId: options.trace },
    ...options.error === undefined ? {} : { errorCode: options.error },
    ...options.level === undefined ? {} : { level: options.level },
    ...from === undefined ? {} : { from },
    ...to === undefined ? {} : { to },
    limit,
  }
  const { rows, count } = queryRows(telemetry, input)
  if (options.json === true) {
    console.log(JSON.stringify({ count, rows }, null, 2))
    return 0
  }
  reportQuery(rows, count, limit)
  return 0
}

function commandShow(telemetry, tasks, argv) {
  const [ref, ...rest] = argv
  if (ref === undefined) throw new Error('show needs a task or trace id')
  const options = parseOptions(rest, new Set(['limit']))
  const limit = Math.min(5_000, Math.max(1, Number(options.limit ?? '500') || 500))
  const task = findTask(tasks, ref)

  if (task !== null) {
    const traceId = task.correlationId
    const attempts = telemetry.attempts(task.id)
    console.log(`任务 ${task.taskRef ?? task.id}（${task.id}）· ${task.status} · 第 ${task.attempt} 次尝试`)
    console.log(`追踪：${traceId ?? '-'}`)
    printAttempts(attempts)
    const { rows } = queryRows(telemetry, { taskId: task.id, limit })
    printTimeline(rows, limit)
    return 0
  }

  const { rows, count } = queryRows(telemetry, { traceId: ref, limit })
  if (count === 0) throw new Error(`no task or trace matches ${ref}`)
  console.log(`追踪：${ref}（没有关联任务记录）`)
  printTimeline(rows, limit)
  return 0
}

function commandStats(telemetry, argv) {
  const options = parseOptions(argv, new Set(['since', 'until', 'json']))
  const from = parseTime(options.since, '--since') ?? iso(Date.now() - 7 * 86_400_000)
  const to = parseTime(options.until, '--until')
  const events = telemetry.query({ from, ...to === undefined ? {} : { to }, limit: 5_000 }).rows
  const attempts = telemetry.attemptsSince({ from, ...to === undefined ? {} : { to }, limit: 5_000 })
  const metrics = computeTraceMetrics({ events, attempts })
  const stats = telemetry.stats()

  if (options.json === true) {
    console.log(JSON.stringify({ window: { from, to: to ?? null }, metrics, telemetry: stats }, null, 2))
    return 0
  }
  console.log(`窗口：${from} ~ ${to ?? 'now'}`)
  console.log(formatTraceWeekly(metrics) ?? '轨迹：窗口内没有事件。')
  console.log(
    `遥测：${stats.mode}${stats.degraded ? '（降级）' : ''} · 丢弃 ${Object.values(stats.dropped).reduce((sum, n) => sum + n, 0)}`,
  )
  return 0
}

/** `attempt.finished` failures map onto the export's `turn_end` status. */
function statusFor(row) {
  if (row.event !== 'attempt.finished' || row.status !== 'failed') return null
  return { type: 'status', phase: 'turn_end', reason: { kind: row.error?.kind ?? 'error' } }
}

function buildExportLines(events, traceId, finalText) {
  const lines = [JSON.stringify({ type: 'session', sessionId: `prod-${hash8(traceId)}` })]
  for (const row of events) {
    if (row.event === 'tool.call' && row.tool?.name != null) {
      lines.push(JSON.stringify({ type: 'tool_call', name: row.tool.name }))
    } else if (row.event === 'tool.result' && row.tool?.name != null) {
      lines.push(JSON.stringify({
        type: 'tool_result',
        name: row.tool.name,
        ok: row.status !== 'failed' && (row.tool.exitCode ?? 0) === 0,
      }))
    } else if (row.event === 'executor.step') {
      lines.push(JSON.stringify({ type: 'status', phase: 'step_end' }))
    } else {
      const status = statusFor(row)
      if (status !== null) lines.push(JSON.stringify(status))
    }
  }
  if (finalText !== '') lines.push(JSON.stringify({ type: 'final', text: finalText }))
  return lines
}

function buildDraftTask({ id, task, tools, finalText, traceFile }) {
  const uniqueTools = [...new Set(tools)]
  const expect = uniqueTools.length > 0
    ? { requiredTools: uniqueTools }
    : { containsAny: [finalText.slice(0, Math.min(12, finalText.length))] }
  return {
    id,
    title: `生产任务轨迹 ${task.taskRef ?? task.id.slice(0, 8)}`,
    suite: 'dsh-trajectory',
    notes: '由 scripts/trace.mjs 导出的生产轨迹草稿：只保留工具名/成败与脱敏摘要，判据需人工确认。',
    taxonomy: 'online-replay',
    difficulty: 'medium',
    source: 'online-replay',
    split: 'dev',
    kind: 'chat',
    turns: ['（生产任务轨迹回放）'],
    timeoutMs: 30000,
    expect,
    runtimeHints: { dsh: { traceFile } },
  }
}

function commandExport(telemetry, tasks, argv) {
  const [ref, ...rest] = argv
  if (ref === undefined) throw new Error('export needs a task id or ref')
  const options = parseOptions(rest, new Set(['out', 'repo-root', 'label', 'dry-run']))
  const task = findTask(tasks, ref)
  if (task === null) throw new Error(`task ${ref} not found`)
  const knownRoot = resolve(options['repo-root'] ?? repoRoot)
  const outDir = resolve(options.out ?? join(knownRoot, 'eval', 'trajectory'))
  const label = (options.label ?? 'prod').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '') || 'prod'
  const id = `dsh-${label}-${hash8(task.correlationId ?? task.id)}`

  const { rows } = queryRows(telemetry, { taskId: task.id, limit: 5_000 })
  const events = [...rows].sort((a, b) => a.ts.localeCompare(b.ts))
  if (events.length === 0) throw new Error(`task ${task.taskRef ?? task.id} has no trace events`)
  const attempts = telemetry.attempts(task.id)
  const rawFinal = [...attempts].reverse().find((attempt) => attempt.summary !== null)?.summary ?? ''
  const finalText = rawFinal === '' ? '' : scrub(rawFinal)
  const tools = events.flatMap((row) => (row.tool?.name == null ? [] : [row.tool.name]))

  const tracePath = join(outDir, `${id}.ndjson`)
  const traceFile = relative(knownRoot, tracePath).split('\\').join('/')
  if (traceFile.startsWith('..')) {
    throw new Error(`output dir must stay inside --repo-root (${traceFile})`)
  }
  const lines = buildExportLines(events, task.correlationId ?? task.id, finalText)
  const draft = buildDraftTask({ id, task, tools, finalText, traceFile })

  if (options['dry-run'] !== true) {
    mkdirSync(outDir, { recursive: true })
    writeFileSync(tracePath, `${lines.join('\n')}\n`)
    writeFileSync(join(outDir, `${id}.json`), `${JSON.stringify(draft, null, 2)}\n`)
  }
  console.log(
    `export ${options['dry-run'] === true ? '[dry-run] ' : ''}${task.taskRef ?? task.id} → `
      + `${lines.length} 行，${tools.length} 次工具调用，判据 ${JSON.stringify(draft.expect)}`,
  )
  if (options['dry-run'] !== true) {
    console.log(`  轨迹：${tracePath}`)
    console.log(`  草稿：${join(outDir, `${id}.json`)}`)
  }
  return 0
}

async function main(argv) {
  const [command, ...rest] = argv
  if (command === undefined || command === '--help' || command === '-h') {
    console.log(usage())
    return 0
  }
  const config = parseServeConfig(process.env)
  const tasks = createTaskStore(config.dbPath)
  const telemetry = createTelemetryStore({
    dbPath: config.dbPath,
    traceDir: join(config.dataDir, 'traces'),
  })
  try {
    if (command === 'query') return commandQuery(telemetry, tasks, rest)
    if (command === 'show') return commandShow(telemetry, tasks, rest)
    if (command === 'stats') return commandStats(telemetry, rest)
    if (command === 'export') return commandExport(telemetry, tasks, rest)
    console.error(`unknown command ${command}`)
    console.error(usage())
    return 1
  } finally {
    telemetry.close()
    tasks.close()
  }
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
