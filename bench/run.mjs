#!/usr/bin/env node
/**
 * A6 双盲差分报表 —— 执行侧（薄壳）。
 *
 * 本文件不判断对错，也不认识 dsh 的转写格式：它把任务提示通过 stdin 交给
 * 一个外部命令，读取该命令 stdout 最后一行 JSON 作为记录。
 * 这样"怎么跑、怎么判"可以替换（真 dsh / 回放 / 人工），报表只看记录。
 *
 * 记录格式（stdout 最后一行）：
 *   {"passed": true, "steps": 7, "costUsd": 0.031, "durationMs": 18400}
 *
 * 用法：
 *   node bench/run.mjs --group A --cmd "node my-runner.mjs" --out bench/results/a.ndjson
 */

import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { validateTasks } from './lib.mjs'

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : process.argv[index + 1]
}

function lastJsonLine(stdout) {
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim() !== '')
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index])
    } catch {
      // keep scanning upward: runners may log before the verdict line
    }
  }
  return undefined
}

function main() {
  const tasksPath = arg('tasks', 'bench/tasks.json')
  const group = arg('group')
  const cmd = arg('cmd')
  const out = arg('out')
  const only = arg('only')
  const exclude = arg('exclude')
  const timeout = Number(arg('timeout', '600000'))

  if (group === undefined || cmd === undefined || out === undefined) {
    console.error('用法：node bench/run.mjs --group <A|B> --cmd <命令> --out <ndjson> [--tasks 路径] [--only 任务id] [--exclude id1,id2] [--timeout 毫秒]')
    return 2
  }

  const doc = JSON.parse(readFileSync(tasksPath, 'utf8'))
  const { tasks, errors } = validateTasks(doc)
  if (errors.length > 0) {
    for (const error of errors) console.error(`任务集错误：${error}`)
    return 2
  }

  const excluded = new Set(
    (exclude ?? '').split(',').map((id) => id.trim()).filter((id) => id !== ''),
  )
  const selected = (only === undefined ? tasks : tasks.filter((task) => task.id === only))
    .filter((task) => !excluded.has(task.id))
  if (selected.length === 0) {
    console.error(`没有匹配的任务：${only ?? '（全部被排除）'}`)
    return 2
  }

  mkdirSync(dirname(out), { recursive: true })
  let failed = 0

  for (const task of selected) {
    const startedAt = new Date().toISOString()
    const began = Date.now()
    const run = spawnSync(cmd, {
      shell: true,
      input: `${task.prompt}\n`,
      encoding: 'utf8',
      timeout,
      maxBuffer: 32 * 1024 * 1024,
      env: {
        ...process.env,
        DSH_BENCH_TASK_ID: task.id,
        DSH_BENCH_GROUP: group,
        DSH_BENCH_CRITERIA: task.criteria,
      },
    })

    const verdict = lastJsonLine(run.stdout ?? '')
    const valid = verdict !== undefined
      && typeof verdict.passed === 'boolean'
      && Number.isInteger(verdict.steps)
      && typeof verdict.costUsd === 'number'

    const record = valid
      ? {
          taskId: task.id,
          group,
          passed: verdict.passed,
          steps: verdict.steps,
          costUsd: verdict.costUsd,
          durationMs: verdict.durationMs ?? Date.now() - began,
          startedAt,
          runner: cmd,
          // Advisory diagnostics: keep why a task failed and what tools it used.
          ...(Array.isArray(verdict.reasons) ? { reasons: verdict.reasons } : {}),
          ...(Array.isArray(verdict.tools) ? { tools: verdict.tools } : {}),
        }
      : {
          // 执行异常按"失败"计入分母，同时保留 error 说明；报表会单独列出异常任务。
          taskId: task.id,
          group,
          passed: false,
          steps: 0,
          costUsd: 0,
          error: run.error !== undefined
            ? String(run.error.message ?? run.error)
            : `执行失败或末行不是合法判据 JSON（exit ${run.status}）`,
          startedAt,
          runner: cmd,
        }

    appendFileSync(out, `${JSON.stringify(record)}\n`)
    const status = valid ? (verdict.passed ? 'pass' : 'fail') : 'error'
    if (!valid) failed += 1
    console.error(`${group}  ${task.id}  ${status}`)
  }

  console.error(`写入 ${out}（${selected.length} 条，异常 ${failed} 条）`)
  return failed === 0 ? 0 : 1
}

process.exitCode = main()
