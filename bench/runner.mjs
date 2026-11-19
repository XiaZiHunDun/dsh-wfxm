#!/usr/bin/env node
/**
 * M9a baseline runner — bridge between `bench/run.mjs` and a real dsh run.
 *
 * `run.mjs` sends one task prompt on stdin and expects the runner's last JSON
 * line to be `{passed, steps, costUsd}`. This runner:
 *   1. spawns `dsh --profile <p> --json -` with the same prompt,
 *   2. parses the NDJSON trace (tool calls / step usage / final text),
 *   3. judges it with the task's deterministic `expect` rubric (lib.judgeTrace).
 *
 * The verdict is advisory: no model judge, no gate. Unknown tools or missing
 * `expect` fail closed so a silent rubric gap cannot look like a pass.
 *
 * Env knobs (set by bench/baseline.mjs or manually):
 *   DSH_BENCH_TASK_ID       required, injected by run.mjs
 *   DSH_BENCH_PROFILE       default `headless`
 *   DSH_BENCH_DSH           default `dsh`
 *   DSH_BENCH_TIMEOUT_MS    default 180000
 *   DSH_BENCH_CWD           default process.cwd()
 *   DSH_BENCH_TASKS         default bench/tasks.json next to this file
 *   DSH_BENCH_USD_PER_MTOK_IN / _OUT   optional price for costUsd (default 0)
 */

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { judgeTrace, validateTasks } from './lib.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

function env(name, fallback) {
  const value = process.env[name]
  return value === undefined || value === '' ? fallback : value
}

function numberEnv(name, fallback) {
  const value = Number(env(name, String(fallback)))
  return Number.isFinite(value) && value >= 0 ? value : fallback
}

function parseTrace(stdout) {
  const trace = {
    tools: [],
    steps: 0,
    text: '',
    error: undefined,
    tokens: { input: 0, output: 0 },
    sessionId: undefined,
  }
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '') continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue // dsh may print non-JSON diagnostics on stdout
    }
    if (event.type === 'session' && typeof event.sessionId === 'string') {
      trace.sessionId = event.sessionId
    } else if (event.type === 'status' && event.phase === 'step_end') {
      trace.steps += 1
      const usage = event.usage ?? {}
      trace.tokens.input += Number(usage.inputTokens) || 0
      trace.tokens.output += Number(usage.outputTokens) || 0
    } else if (event.type === 'status' && event.phase === 'turn_end') {
      const kind = event.reason?.kind
      if (typeof kind === 'string' && kind !== 'completed') {
        trace.error = event.reason?.error?.message ?? kind
      }
    } else if (event.type === 'tool_call' && typeof event.tool === 'string') {
      trace.tools.push(event.tool)
    } else if (event.type === 'final' && typeof event.text === 'string') {
      trace.text = event.text
    } else if (event.type === 'text' && typeof event.text === 'string' && trace.text === '') {
      trace.text = event.text
    } else if (event.type === 'error') {
      trace.error = event.message ?? 'dsh error event'
    }
  }
  return trace
}

function loadTask(taskId, tasksPath) {
  let doc
  try {
    doc = JSON.parse(readFileSync(tasksPath, 'utf8'))
  } catch (error) {
    return { error: `无法读取任务集 ${tasksPath}: ${error.message}` }
  }
  const { tasks, errors } = validateTasks(doc)
  if (errors.length > 0) return { error: `任务集无效: ${errors.join('; ')}` }
  const task = tasks.find((item) => item.id === taskId)
  return task === undefined ? { error: `未知任务 ${taskId}` } : { task }
}

function main() {
  const taskId = env('DSH_BENCH_TASK_ID', '')
  const prompt = readFileSync(0, 'utf8')
  const began = Date.now()

  if (taskId === '') {
    console.log(JSON.stringify({ passed: false, steps: 0, costUsd: 0, reasons: ['缺少 DSH_BENCH_TASK_ID'] }))
    return
  }

  const tasksPath = env('DSH_BENCH_TASKS', join(HERE, 'tasks.json'))
  const loaded = loadTask(taskId, tasksPath)
  if (loaded.error !== undefined) {
    console.log(JSON.stringify({ passed: false, steps: 0, costUsd: 0, reasons: [loaded.error] }))
    return
  }

  const profile = env('DSH_BENCH_PROFILE', 'headless')
  const dshBin = env('DSH_BENCH_DSH', 'dsh')
  const timeout = numberEnv('DSH_BENCH_TIMEOUT_MS', 180_000)
  const cwd = env('DSH_BENCH_CWD', process.cwd())

  const run = spawnSync(dshBin, ['--profile', profile, '--json', '-'], {
    cwd,
    input: prompt,
    encoding: 'utf8',
    timeout,
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      DSH_WFXM_BENCH_TASK_ID: taskId,
    },
  })

  const timedOut = run.error?.code === 'ETIMEDOUT'
  const trace = parseTrace(run.stdout ?? '')
  const judged = timedOut
    ? { passed: false, reasons: [`超时 ${timeout}ms`] }
    : judgeTrace(loaded.task.expect, trace)
  const reasons = trace.error === undefined
    ? judged.reasons
    : [...judged.reasons, `执行异常：${trace.error}`]

  const inPrice = numberEnv('DSH_BENCH_USD_PER_MTOK_IN', 0)
  const outPrice = numberEnv('DSH_BENCH_USD_PER_MTOK_OUT', 0)
  const costUsd = Number((
    (trace.tokens.input / 1_000_000) * inPrice
    + (trace.tokens.output / 1_000_000) * outPrice
  ).toFixed(6))

  console.log(JSON.stringify({
    passed: judged.passed && reasons.length === 0,
    steps: trace.steps,
    costUsd,
    durationMs: Date.now() - began,
    reasons,
    tools: trace.tools,
    tokens: trace.tokens,
    profile,
  }))
}

main()
