/**
 * A6 双盲差分报表 —— 纯计算层（无 I/O、无模型调用）。
 *
 * 输入是「任务集」与「运行记录」；输出是可复算的汇总与 A/B 差分。
 * D19-3=B：报表只归档、不作发布门槛，因此这里不做 pass/fail 判定，
 * 通过与否由执行方在记录里给出（评判方不知道分组）。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const SCHEMA_VERSION = 1

export function loadTasks(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

export function validateTasks(doc) {
  const errors = []
  if (doc === null || typeof doc !== 'object') return { tasks: [], errors: ['任务集不是对象'] }
  if (typeof doc.version !== 'string' || doc.version === '') errors.push('缺少 version')
  if (!Array.isArray(doc.tasks)) return { tasks: [], errors: [...errors, 'tasks 不是数组'] }
  const seen = new Set()
  const tasks = []
  for (const [index, task] of doc.tasks.entries()) {
    const where = `tasks[${index}]`
    if (task === null || typeof task !== 'object') {
      errors.push(`${where} 不是对象`)
      continue
    }
    if (typeof task.id !== 'string' || task.id === '') errors.push(`${where} 缺少 id`)
    else if (seen.has(task.id)) errors.push(`${where} id 重复: ${task.id}`)
    if (typeof task.prompt !== 'string' || task.prompt === '') errors.push(`${where} 缺少 prompt`)
    if (typeof task.criteria !== 'string' || task.criteria === '') errors.push(`${where} 缺少 criteria`)
    if (typeof task.id === 'string') seen.add(task.id)
    tasks.push(task)
  }
  return { tasks, errors }
}

/** 单条运行记录的必填字段；`passed` 由执行方给出，不由报表推断。 */
export function validateRecord(record) {
  if (record === null || typeof record !== 'object') return '不是对象'
  if (typeof record.taskId !== 'string' || record.taskId === '') return '缺少 taskId'
  if (typeof record.group !== 'string' || record.group === '') return '缺少 group'
  if (typeof record.passed !== 'boolean') return 'passed 必须是布尔值'
  if (!Number.isInteger(record.steps) || record.steps < 0) return 'steps 必须是非负整数'
  if (typeof record.costUsd !== 'number' || !Number.isFinite(record.costUsd) || record.costUsd < 0) {
    return 'costUsd 必须是非负数字'
  }
  return undefined
}

export function parseResults(text, taskIds) {
  const records = []
  const errors = []
  const known = taskIds === undefined ? undefined : new Set(taskIds)
  const seen = new Set()

  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim()
    if (line === '') continue
    let record
    try {
      record = JSON.parse(line)
    } catch {
      errors.push(`第 ${index + 1} 行不是合法 JSON`)
      continue
    }
    const invalid = validateRecord(record)
    if (invalid !== undefined) {
      errors.push(`第 ${index + 1} 行：${invalid}`)
      continue
    }
    if (known !== undefined && !known.has(record.taskId)) {
      errors.push(`第 ${index + 1} 行：未知任务 ${record.taskId}`)
      continue
    }
    const key = `${record.group}\u0000${record.taskId}`
    if (seen.has(key)) {
      errors.push(`第 ${index + 1} 行：${record.group}/${record.taskId} 重复`)
      continue
    }
    seen.add(key)
    records.push(record)
  }
  return { records, errors }
}

function mean(values) {
  if (values.length === 0) return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

export function summarize(records, tasks, group) {
  const list = records.filter((record) => record.group === group)
  const ids = new Set(list.map((record) => record.taskId))
  const passed = list.filter((record) => record.passed).length
  const totalCostUsd = list.reduce((sum, record) => sum + record.costUsd, 0)
  return {
    group,
    runs: list.length,
    passed,
    passRate: list.length === 0 ? 0 : passed / list.length,
    avgSteps: mean(list.map((record) => record.steps)),
    totalCostUsd,
    avgCostUsd: list.length === 0 ? 0 : totalCostUsd / list.length,
    coverage: tasks.length === 0 ? 0 : ids.size / tasks.length,
    missing: tasks.filter((task) => !ids.has(task.id)).map((task) => task.id),
    errorTaskIds: list.filter((record) => record.error !== undefined).map((record) => record.taskId),
  }
}

export function compare(tasks, records, groupA, groupB) {
  const a = summarize(records, tasks, groupA)
  const b = summarize(records, tasks, groupB)
  return {
    a,
    b,
    delta: {
      passRatePp: (b.passRate - a.passRate) * 100,
      avgSteps: b.avgSteps - a.avgSteps,
      avgCostUsd: b.avgCostUsd - a.avgCostUsd,
      coveragePp: (b.coverage - a.coverage) * 100,
    },
  }
}

function signed(value, digits, unit = '') {
  const fixed = value.toFixed(digits)
  if (Number(fixed) === 0) return `0${unit === ' pp' ? ' pp' : ''}`
  return `${value > 0 ? '+' : ''}${fixed}${unit}`
}

export function renderMarkdown(report, meta = {}) {
  const { a, b, delta } = report
  const title = meta.title ?? `双盲差分报表 — ${a.group} vs ${b.group}`
  const lines = [
    `# ${title}`,
    '',
    `- 任务集：${meta.tasksVersion ?? '?'}（${meta.tasksCount ?? '?'} 项）`,
    `- 生成时间：${meta.generatedAt ?? '?'}`,
    `- ${a.group}：${meta.runnerA ?? '未注明'}`,
    `- ${b.group}：${meta.runnerB ?? '未注明'}`,
    '- 归档用途，**不作发布门槛**（D19-3=B）',
    '',
    `| 指标 | ${a.group} | ${b.group} | Δ (${b.group}-${a.group}) |`,
    '|---|---|---|---|',
    `| 通过率 | ${a.passed}/${a.runs} (${(a.passRate * 100).toFixed(1)}%) | ${b.passed}/${b.runs} (${(b.passRate * 100).toFixed(1)}%) | ${signed(delta.passRatePp, 1, ' pp')} |`,
    `| 平均步数 | ${a.avgSteps.toFixed(2)} | ${b.avgSteps.toFixed(2)} | ${signed(delta.avgSteps, 2)} |`,
    `| 单任务成本 | $${a.avgCostUsd.toFixed(4)} | $${b.avgCostUsd.toFixed(4)} | ${signed(delta.avgCostUsd, 4)} |`,
    `| 覆盖率 | ${(a.coverage * 100).toFixed(1)}% | ${(b.coverage * 100).toFixed(1)}% | ${signed(delta.coveragePp, 1, ' pp')} |`,
    '',
  ]
  for (const side of [a, b]) {
    if (side.missing.length > 0) lines.push(`- ${side.group} 缺跑：${side.missing.join(', ')}`)
    if (side.errorTaskIds.length > 0) lines.push(`- ${side.group} 执行异常：${side.errorTaskIds.join(', ')}`)
  }
  return `${lines.join('\n')}\n`
}

export function archivePath(dir, label, at = new Date()) {
  const stamp = at.toISOString().replace(/[:.]/g, '-')
  const safe = label.replace(/[^A-Za-z0-9._-]+/g, '-')
  return join(dir, `${stamp}-${safe}.json`)
}

export function archiveReport(dir, label, payload, at = new Date()) {
  mkdirSync(dir, { recursive: true })
  const file = archivePath(dir, label, at)
  writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`)
  return file
}
