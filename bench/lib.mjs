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

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && item !== '')
}

/** Optional deterministic rubric: `expect` describes observable traces only. */
function validateExpect(expect, where, errors) {
  if (expect === null || typeof expect !== 'object' || Array.isArray(expect)) {
    errors.push(`${where}.expect 必须是对象`)
    return
  }
  for (const key of ['toolsAny', 'toolsNone', 'textIncludesAll', 'textIncludesAny', 'textExcludes']) {
    if (expect[key] !== undefined && !isStringArray(expect[key])) {
      errors.push(`${where}.expect.${key} 必须是非空字符串数组`)
    }
  }
  if (expect.maxSteps !== undefined
    && (!Number.isInteger(expect.maxSteps) || expect.maxSteps < 0)) {
    errors.push(`${where}.expect.maxSteps 必须是非负整数`)
  }
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
    if (task.expect !== undefined) validateExpect(task.expect, where, errors)
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

/**
 * Deterministic rubric for M9 baselines. Judges only *observable* evidence
 * (tool names + final text), never the model's self-report. No model call.
 *
 * trace: { tools: string[], steps: number, text: string }
 */
export function judgeTrace(expect, trace) {
  if (expect === undefined || expect === null || typeof expect !== 'object') {
    return { passed: false, reasons: ['任务未配置 expect 判据'] }
  }
  const reasons = []
  const tools = Array.isArray(trace.tools) ? trace.tools : []
  const text = typeof trace.text === 'string' ? trace.text : ''

  const any = expect.toolsAny ?? []
  if (any.length > 0 && !any.some((tool) => tools.includes(tool))) {
    reasons.push(`未调用必需工具：${any.join(' / ')}`)
  }
  for (const tool of expect.toolsNone ?? []) {
    if (tools.includes(tool)) reasons.push(`调用了禁止工具：${tool}`)
  }
  for (const phrase of expect.textIncludesAll ?? []) {
    if (!text.includes(phrase)) reasons.push(`答复缺少：${phrase}`)
  }
  const includesAny = expect.textIncludesAny ?? []
  if (includesAny.length > 0 && !includesAny.some((phrase) => text.includes(phrase))) {
    reasons.push(`答复未包含任一：${includesAny.join(' / ')}`)
  }
  for (const phrase of expect.textExcludes ?? []) {
    if (text.includes(phrase)) reasons.push(`答复包含禁用表述：${phrase}`)
  }
  if (typeof expect.maxSteps === 'number' && trace.steps > expect.maxSteps) {
    reasons.push(`步数 ${trace.steps} 超过上限 ${expect.maxSteps}`)
  }
  return { passed: reasons.length === 0, reasons }
}

export const DEFAULT_THRESHOLDS = {
  maxPassRateDropPp: 10,
  maxCoverageDropPp: 5,
  taskHighWater: 1,
  taskCollapse: 0,
  minRounds: 2,
}

export function validateThresholds(doc) {
  const errors = []
  if (doc === null || typeof doc !== 'object') return { thresholds: DEFAULT_THRESHOLDS, errors: ['阈值不是对象'] }
  const thresholds = { ...DEFAULT_THRESHOLDS }
  for (const key of ['maxPassRateDropPp', 'maxCoverageDropPp', 'taskHighWater', 'taskCollapse']) {
    if (doc[key] === undefined) continue
    if (typeof doc[key] !== 'number' || !Number.isFinite(doc[key])) {
      errors.push(`${key} 必须是数字`)
    } else {
      thresholds[key] = doc[key]
    }
  }
  if (doc.minRounds !== undefined) {
    if (!Number.isInteger(doc.minRounds) || doc.minRounds < 1) errors.push('minRounds 必须是大等于 1 的整数')
    else thresholds.minRounds = doc.minRounds
  }
  return { thresholds, errors }
}

/** M9b: aggregate per-task results across rounds (group names are ignored). */
export function aggregateRounds(records, tasks) {
  const rounds = new Set(records.map((record) => record.group)).size
  const byTask = new Map(tasks.map((task) => [task.id, []]))
  for (const record of records) {
    const list = byTask.get(record.taskId)
    if (list !== undefined) list.push(record)
  }
  const perTask = tasks.map((task) => {
    const list = byTask.get(task.id) ?? []
    const passed = list.filter((record) => record.passed).length
    return {
      taskId: task.id,
      category: task.category,
      runs: list.length,
      passed,
      passRate: list.length === 0 ? 0 : passed / list.length,
      avgSteps: mean(list.map((record) => record.steps)),
      tools: [...new Set(list.flatMap((record) => record.tools ?? []))],
      reasons: [...new Set(list.flatMap((record) => record.reasons ?? []))],
    }
  })
  const passed = records.filter((record) => record.passed).length
  return {
    group: 'baseline',
    rounds,
    runs: records.length,
    passed,
    passRate: records.length === 0 ? 0 : passed / records.length,
    avgSteps: mean(records.map((record) => record.steps)),
    totalCostUsd: records.reduce((sum, record) => sum + record.costUsd, 0),
    avgCostUsd: records.length === 0 ? 0 : records.reduce((sum, record) => sum + record.costUsd, 0) / records.length,
    coverage: tasks.length === 0 ? 0 : perTask.filter((task) => task.runs > 0).length / tasks.length,
    missing: perTask.filter((task) => task.runs === 0).map((task) => task.taskId),
    errorTaskIds: [...new Set(records.filter((record) => record.error !== undefined).map((record) => record.taskId))],
    tasks: perTask,
  }
}

/**
 * M9b: compare a current aggregate against the reference. Regression kinds:
 *   - overall: pass rate drops more than `maxPassRateDropPp`
 *   - coverage: coverage drops more than `maxCoverageDropPp`
 *   - task: a task that passed every reference round collapses to
 *     `taskCollapse` or lower in the current run
 * Fewer than `minRounds` is a warning, not a regression.
 */
export function compareBaseline(reference, current, thresholds = DEFAULT_THRESHOLDS) {
  const ref = reference.aggregate ?? reference
  const cur = current.aggregate ?? current
  const regressions = []
  const warnings = []
  if (cur.rounds !== undefined && cur.rounds < thresholds.minRounds) {
    warnings.push(`当前只有 ${cur.rounds} 轮，少于建议的 ${thresholds.minRounds} 轮`)
  }
  const passDropPp = (ref.passRate - cur.passRate) * 100
  if (passDropPp > thresholds.maxPassRateDropPp) {
    regressions.push({
      kind: 'overall',
      detail: `整体通过率下降 ${passDropPp.toFixed(1)} pp（上限 ${thresholds.maxPassRateDropPp}）`,
    })
  }
  const coverageDropPp = (ref.coverage - cur.coverage) * 100
  if (coverageDropPp > thresholds.maxCoverageDropPp) {
    regressions.push({
      kind: 'coverage',
      detail: `覆盖率下降 ${coverageDropPp.toFixed(1)} pp（上限 ${thresholds.maxCoverageDropPp}）`,
    })
  }
  const currentTasks = new Map((cur.tasks ?? []).map((task) => [task.taskId, task]))
  for (const task of ref.tasks ?? []) {
    const now = currentTasks.get(task.taskId)
    if (now === undefined) continue
    if (task.passRate >= thresholds.taskHighWater && now.passRate <= thresholds.taskCollapse) {
      regressions.push({
        kind: 'task',
        detail: `${task.taskId} 从 ${task.passed}/${task.runs} 退化为 ${now.passed}/${now.runs}`,
      })
    }
  }
  return {
    pass: regressions.length === 0,
    regressions,
    warnings,
    delta: {
      passRatePp: -passDropPp,
      coveragePp: -coverageDropPp,
    },
  }
}

export function renderRegressMarkdown(result, meta = {}) {
  const lines = [
    '# M9b 回归检查',
    '',
    `- 参考基线：${meta.reference ?? '?'}`,
    `- 当前基线：${meta.current ?? '?'}`,
    `- 生成时间：${meta.generatedAt ?? '?'}`,
    `- 判定：${result.pass ? '通过' : '退化'}`,
    '',
  ]
  if (result.regressions.length === 0) {
    lines.push('- 无回归项')
  } else {
    for (const item of result.regressions) lines.push(`- [${item.kind}] ${item.detail}`)
  }
  for (const warning of result.warnings) lines.push(`- 警告：${warning}`)
  return `${lines.join('\n')}\n`
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

/**
 * Single-group baseline (M9a). Advisory only: D19-3=B still applies — the
 * report is archived to observe drift, not to block a release.
 */
export function renderBaselineMarkdown(summary, meta = {}) {
  const lines = [
    `# 基线报表 — ${summary.group}`,
    '',
    `- 任务集：${meta.tasksVersion ?? '?'}（${meta.tasksCount ?? '?'} 项，排除 ${meta.excluded?.length ?? 0} 项）`,
    `- 生成时间：${meta.generatedAt ?? '?'}`,
    `- 执行器：${meta.runner ?? '未注明'}`,
    `- dsh profile：${meta.profile ?? '未注明'}`,
    '- 归档用途，**不作发布门槛**（D19-3=B）',
    '',
    '| 指标 | 值 |',
    '|---|---|',
    `| 通过率 | ${summary.passed}/${summary.runs} (${(summary.passRate * 100).toFixed(1)}%) |`,
    `| 平均步数 | ${summary.avgSteps.toFixed(2)} |`,
    `| 单任务成本 | $${summary.avgCostUsd.toFixed(4)} |`,
    `| 覆盖率 | ${(summary.coverage * 100).toFixed(1)}% |`,
    '',
  ]
  if (summary.missing.length > 0) lines.push(`- 缺跑：${summary.missing.join(', ')}`)
  if (summary.errorTaskIds.length > 0) lines.push(`- 执行异常：${summary.errorTaskIds.join(', ')}`)
  return `${lines.join('\n')}\n`
}

export function renderAggregateMarkdown(aggregate, meta = {}) {
  const lines = [
    `# 多轮基线 — ${aggregate.rounds} 轮`,
    '',
    `- 任务集：${meta.tasksVersion ?? '?'}（${meta.tasksCount ?? '?'} 项，排除 ${meta.excluded?.length ?? 0} 项）`,
    `- 生成时间：${meta.generatedAt ?? '?'}`,
    `- 执行器：${meta.runner ?? '未注明'}`,
    '- 归档用途；阈值与 `--enforce` 由 M9b `bench/regress.mjs` 单独判定',
    '',
    '| 指标 | 值 |',
    '|---|---|',
    `| 通过率 | ${aggregate.passed}/${aggregate.runs} (${(aggregate.passRate * 100).toFixed(1)}%) |`,
    `| 平均步数 | ${aggregate.avgSteps.toFixed(2)} |`,
    `| 单任务成本 | $${aggregate.avgCostUsd.toFixed(4)} |`,
    `| 覆盖率 | ${(aggregate.coverage * 100).toFixed(1)}% |`,
    '',
    '| 任务 | 通过 | 平均步数 |',
    '|---|---|---|',
  ]
  for (const task of aggregate.tasks) {
    lines.push(`| ${task.taskId} | ${task.passed}/${task.runs} | ${task.avgSteps.toFixed(2)} |`)
  }
  const unstable = aggregate.tasks.filter((task) => task.runs > 0 && task.passRate > 0 && task.passRate < 1)
  if (unstable.length > 0) {
    lines.push('', `- 不稳定任务：${unstable.map((task) => task.taskId).join(', ')}`)
  }
  if (aggregate.missing.length > 0) lines.push(`- 缺跑：${aggregate.missing.join(', ')}`)
  if (aggregate.errorTaskIds.length > 0) lines.push(`- 执行异常：${aggregate.errorTaskIds.join(', ')}`)
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
