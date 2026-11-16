#!/usr/bin/env node
/**
 * A6 双盲差分报表 —— 报表侧。
 *
 * 读两份运行记录（A / B），输出通过率 / 平均步数 / 单任务成本 / 覆盖率的差分。
 * 缺跑只告警、不失败：D19-3=B 明确"报表归档、不作发布门槛"。
 *
 * 用法：
 *   node bench/report.mjs --a a.ndjson --b b.ndjson [--archive bench/results]
 */

import { readFileSync } from 'node:fs'
import {
  SCHEMA_VERSION,
  archiveReport,
  compare,
  loadTasks,
  parseResults,
  renderMarkdown,
  validateTasks,
} from './lib.mjs'

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : process.argv[index + 1]
}

function main() {
  const tasksPath = arg('tasks', 'bench/tasks.json')
  const pathA = arg('a')
  const pathB = arg('b')
  const groupA = arg('group-a', 'A')
  const groupB = arg('group-b', 'B')

  if (pathA === undefined || pathB === undefined) {
    console.error('用法：node bench/report.mjs --a <a.ndjson> --b <b.ndjson> [--tasks 路径] [--archive 目录]')
    return 2
  }

  const { tasks, errors: taskErrors } = validateTasks(loadTasks(tasksPath))
  if (taskErrors.length > 0) {
    for (const error of taskErrors) console.error(`任务集错误：${error}`)
    return 2
  }

  const ids = tasks.map((task) => task.id)
  const parsedA = parseResults(readFileSync(pathA, 'utf8'), ids)
  const parsedB = parseResults(readFileSync(pathB, 'utf8'), ids)
  const errors = [...parsedA.errors, ...parsedB.errors]
  if (errors.length > 0) {
    for (const error of errors) console.error(`记录错误：${error}`)
    return 2
  }

  const records = [...parsedA.records, ...parsedB.records]
  const report = compare(tasks, records, groupA, groupB)
  const generatedAt = new Date().toISOString()
  const meta = {
    tasksVersion: `v${JSON.parse(readFileSync(tasksPath, 'utf8')).version}`,
    tasksCount: tasks.length,
    generatedAt,
    runnerA: parsedA.records[0]?.runner,
    runnerB: parsedB.records[0]?.runner,
  }

  process.stdout.write(renderMarkdown(report, meta))

  for (const side of [report.a, report.b]) {
    if (side.missing.length > 0) {
      console.error(`警告：${side.group} 缺跑 ${side.missing.length} 项（覆盖率 ${(side.coverage * 100).toFixed(1)}%）`)
    }
  }

  const archiveDir = arg('archive')
  if (archiveDir !== undefined) {
    const file = archiveReport(archiveDir, `${groupA}-vs-${groupB}`, {
      schemaVersion: SCHEMA_VERSION,
      generatedAt,
      tasksVersion: meta.tasksVersion,
      tasksCount: tasks.length,
      groups: [report.a, report.b],
      delta: report.delta,
      records,
    })
    console.error(`已归档：${file}`)
  }

  return 0
}

process.exitCode = main()
