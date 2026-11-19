import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  archivePath,
  compare,
  judgeTrace,
  parseResults,
  renderBaselineMarkdown,
  renderMarkdown,
  summarize,
  validateRecord,
  validateTasks,
} from './lib.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const RUN = join(HERE, 'run.mjs')
const REPORT = join(HERE, 'report.mjs')
const TASKS = join(HERE, 'tasks.json')

let pass = 0
let fail = 0
function check(name, fn) {
  try {
    fn()
    pass++
    console.log(`PASS  ${name}`)
  } catch (error) {
    fail++
    console.log(`FAIL  ${name} — ${error instanceof Error ? error.message : String(error)}`)
  }
}

const dirs = []
function fixtureDir() {
  const dir = mkdtempSync(join(tmpdir(), 'bench-'))
  dirs.push(dir)
  return dir
}

const taskDoc = JSON.parse(readFileSync(TASKS, 'utf8'))
const { tasks, errors: taskErrors } = validateTasks(taskDoc)

check('task set: 20 unique tasks, all with prompt, criteria and expect', () => {
  assert.deepEqual(taskErrors, [])
  assert.equal(tasks.length, 20)
  assert.equal(new Set(tasks.map((task) => task.id)).size, 20)
  assert.ok(tasks.every((task) => task.prompt.trim() !== '' && task.criteria.trim() !== ''))
  assert.ok(tasks.every((task) => task.expect !== undefined && typeof task.expect === 'object'))
  const categories = new Set(tasks.map((task) => task.category))
  for (const needed of ['discover', 'status', 'logs', 'inspect', 'report', 'change', 'boundary', 'docker']) {
    assert.ok(categories.has(needed), `缺少类别 ${needed}`)
  }
})

check('task set validation rejects malformed expect', () => {
  const bad = validateTasks({
    version: '1',
    tasks: [{ id: 'a', prompt: 'x', criteria: 'y', expect: { toolsAny: 'nope', maxSteps: -1 } }],
  })
  assert.ok(bad.errors.some((error) => /toolsAny/.test(error)))
  assert.ok(bad.errors.some((error) => /maxSteps/.test(error)))
})

check('judgeTrace passes on matching tools/text and fails on forbidden tool', () => {
  const expect = {
    toolsAny: ['svc_list'],
    toolsNone: ['svc_restart'],
    textIncludesAny: ['systemd', 'docker'],
    textExcludes: ['已修复'],
  }
  assert.deepEqual(
    judgeTrace(expect, { tools: ['svc_list'], steps: 2, text: 'runtime: systemd' }),
    { passed: true, reasons: [] },
  )
  const bad = judgeTrace(expect, { tools: ['svc_restart'], steps: 9, text: '已修复' })
  assert.equal(bad.passed, false)
  assert.ok(bad.reasons.some((reason) => /禁止工具/.test(reason)))
  assert.ok(bad.reasons.some((reason) => /未包含任一/.test(reason)))
  assert.ok(bad.reasons.some((reason) => /禁用表述/.test(reason)))
})

check('judgeTrace fails closed when expect is missing', () => {
  const verdict = judgeTrace(undefined, { tools: [], steps: 0, text: '' })
  assert.equal(verdict.passed, false)
  assert.match(verdict.reasons[0], /未配置 expect/)
})

check('renderBaselineMarkdown states advisory and includes coverage', () => {
  const summary = summarize(
    [{ taskId: 'svc-list-all', group: 'baseline', passed: true, steps: 3, costUsd: 0.01 }],
    tasks,
    'baseline',
  )
  const text = renderBaselineMarkdown(summary, {
    tasksVersion: 'v1',
    tasksCount: 20,
    generatedAt: 'x',
    excluded: ['a', 'b'],
    profile: 'headless',
  })
  assert.ok(text.includes('不作发布门槛'))
  assert.ok(text.includes('1/1 (100.0%)'))
  assert.ok(text.includes('5.0%'))
})

check('task set validation catches duplicate id and missing prompt', () => {
  const bad = validateTasks({
    version: '1',
    tasks: [{ id: 'a', prompt: 'x', criteria: 'y' }, { id: 'a', criteria: 'z' }],
  })
  assert.ok(bad.errors.some((error) => /id 重复/.test(error)))
  assert.ok(bad.errors.some((error) => /缺少 prompt/.test(error)))
})

check('record validation rejects missing or impossible fields', () => {
  assert.match(validateRecord({ group: 'A', passed: true, steps: 1, costUsd: 0 }), /taskId/)
  assert.match(validateRecord({ taskId: 'a', group: 'A', steps: 1, costUsd: 0 }), /passed/)
  assert.match(validateRecord({ taskId: 'a', group: 'A', passed: true, steps: -1, costUsd: 0 }), /steps/)
  assert.match(validateRecord({ taskId: 'a', group: 'A', passed: true, steps: 1, costUsd: -0.1 }), /costUsd/)
  assert.equal(validateRecord({ taskId: 'a', group: 'A', passed: true, steps: 0, costUsd: 0 }), undefined)
})

check('parseResults reports unknown task, duplicate and broken JSON with line numbers', () => {
  const text = [
    JSON.stringify({ taskId: 'svc-list-all', group: 'A', passed: true, steps: 2, costUsd: 0.01 }),
    '{not json',
    JSON.stringify({ taskId: 'nope', group: 'A', passed: true, steps: 1, costUsd: 0 }),
    JSON.stringify({ taskId: 'svc-list-all', group: 'A', passed: false, steps: 9, costUsd: 0.09 }),
  ].join('\n')
  const { records, errors } = parseResults(text, tasks.map((task) => task.id))
  assert.equal(records.length, 1)
  assert.equal(errors.length, 3)
  assert.match(errors[0], /第 2 行/)
  assert.match(errors[1], /未知任务/)
  assert.match(errors[2], /重复/)
})

const records = [
  { taskId: 'svc-list-all', group: 'A', passed: true, steps: 3, costUsd: 0.01 },
  { taskId: 'svc-status-managed', group: 'A', passed: false, steps: 5, costUsd: 0.03 },
  { taskId: 'svc-list-all', group: 'B', passed: true, steps: 3, costUsd: 0.01 },
  { taskId: 'svc-status-managed', group: 'B', passed: true, steps: 5, costUsd: 0.03 },
]

check('summarize computes pass rate, steps, cost and coverage', () => {
  const summary = summarize(records, tasks, 'A')
  assert.equal(summary.runs, 2)
  assert.equal(summary.passed, 1)
  assert.equal(summary.passRate, 0.5)
  assert.equal(summary.avgSteps, 4)
  assert.equal(summary.totalCostUsd.toFixed(2), '0.04')
  assert.equal(summary.avgCostUsd.toFixed(3), '0.020')
  assert.equal(summary.coverage, 0.1)
  assert.equal(summary.missing.length, 18)
  assert.deepEqual(summary.errorTaskIds, [])
})

check('compare reports B-A deltas', () => {
  const report = compare(tasks, records, 'A', 'B')
  assert.equal(report.delta.passRatePp, 50)
  assert.equal(report.delta.avgSteps, 0)
  assert.equal(report.delta.avgCostUsd, 0)
})

check('renderMarkdown formats the table and states it is not a gate', () => {
  const text = renderMarkdown(compare(tasks, records, 'A', 'B'), {
    tasksVersion: 'v1',
    tasksCount: tasks.length,
    generatedAt: '2026-11-09T00:00:00.000Z',
  })
  assert.ok(text.includes('| 通过率 | 1/2 (50.0%) | 2/2 (100.0%) | +50.0 pp |'))
  assert.ok(text.includes('| 平均步数 | 4.00 | 4.00 | 0 |'))
  assert.ok(text.includes('不作发布门槛'))
  assert.ok(text.includes('A 缺跑：'))
})

check('renderMarkdown is deterministic', () => {
  const meta = { tasksVersion: 'v1', tasksCount: 20, generatedAt: '2026-11-09T00:00:00.000Z' }
  assert.equal(
    renderMarkdown(compare(tasks, records, 'A', 'B'), meta),
    renderMarkdown(compare(tasks, records, 'A', 'B'), meta),
  )
})

check('archivePath is timestamped and label-safe', () => {
  const path = archivePath('/tmp/x', 'A vs B', new Date('2026-11-09T01:02:03.004Z'))
  assert.equal(path, join('/tmp/x', '2026-11-09T01-02-03-004Z-A-vs-B.json'))
})

check('run.mjs rejects an empty selection after exclusion', () => {
  const run = spawnSync(process.execPath, [
    RUN, '--group', 'A', '--cmd', 'true', '--out', join(fixtureDir(), 'x.ndjson'),
    '--only', 'svc-list-all', '--exclude', 'svc-list-all',
  ], { encoding: 'utf8' })
  assert.equal(run.status, 2)
  assert.match(run.stderr, /没有匹配/)
})

check('run.mjs executes the runner, passes prompt on stdin and env, writes a record', () => {
  const dir = fixtureDir()
  const runner = join(dir, 'runner.mjs')
  writeFileSync(runner, `
let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => { input += chunk })
process.stdin.on('end', () => {
  if (process.env.DSH_BENCH_TASK_ID !== 'svc-list-all') process.exit(7)
  if (!input.trim()) process.exit(8)
  if (!process.env.DSH_BENCH_CRITERIA) process.exit(9)
  console.log('runner log line')
  console.log(JSON.stringify({ passed: false, steps: 4, costUsd: 0.02 }))
})
`)
  const out = join(dir, 'a.ndjson')
  const run = spawnSync(process.execPath, [RUN, '--group', 'A', '--cmd', `${process.execPath} ${runner}`, '--out', out, '--only', 'svc-list-all'], {
    encoding: 'utf8',
  })
  assert.equal(run.status, 0, run.stderr)
  const lines = readFileSync(out, 'utf8').trim().split('\n')
  assert.equal(lines.length, 1)
  const record = JSON.parse(lines[0])
  assert.equal(record.taskId, 'svc-list-all')
  assert.equal(record.group, 'A')
  assert.equal(record.passed, false)
  assert.equal(record.steps, 4)
  assert.equal(record.costUsd, 0.02)
})

check('run.mjs records a failed task when the runner prints no verdict', () => {
  const dir = fixtureDir()
  const runner = join(dir, 'bad.mjs')
  writeFileSync(runner, "console.log('not json')\n")
  const out = join(dir, 'bad.ndjson')
  const run = spawnSync(process.execPath, [RUN, '--group', 'A', '--cmd', `${process.execPath} ${runner}`, '--out', out, '--only', 'svc-list-all'], {
    encoding: 'utf8',
  })
  assert.equal(run.status, 1)
  const record = JSON.parse(readFileSync(out, 'utf8').trim())
  assert.equal(record.passed, false)
  assert.equal(record.steps, 0)
  assert.match(record.error, /末行不是合法判据/)
})

check('report.mjs prints the diff, warns on gaps, exits 0 and archives', () => {
  const dir = fixtureDir()
  const a = join(dir, 'a.ndjson')
  const b = join(dir, 'b.ndjson')
  writeFileSync(a, `${JSON.stringify({ taskId: 'svc-list-all', group: 'A', passed: false, steps: 6, costUsd: 0.03, runner: 'r1' })}\n`)
  writeFileSync(b, `${JSON.stringify({ taskId: 'svc-list-all', group: 'B', passed: true, steps: 4, costUsd: 0.02, runner: 'r2' })}\n`)
  const archive = join(dir, 'results')
  const run = spawnSync(process.execPath, [REPORT, '--a', a, '--b', b, '--archive', archive], { encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr)
  assert.ok(run.stdout.includes('| 通过率 | 0/1 (0.0%) | 1/1 (100.0%) | +100.0 pp |'))
  assert.ok(run.stdout.includes('| 平均步数 | 6.00 | 4.00 | -2.00 |'))
  assert.match(run.stderr, /缺跑 19 项/)
  const files = readdirSync(archive)
  assert.equal(files.length, 1)
  const archived = JSON.parse(readFileSync(join(archive, files[0]), 'utf8'))
  assert.equal(archived.records.length, 2)
  assert.equal(archived.delta.passRatePp, 100)
})

check('report.mjs rejects records for unknown tasks', () => {
  const dir = fixtureDir()
  const a = join(dir, 'a.ndjson')
  const b = join(dir, 'b.ndjson')
  writeFileSync(a, `${JSON.stringify({ taskId: 'ghost', group: 'A', passed: true, steps: 1, costUsd: 0 })}\n`)
  writeFileSync(b, '')
  const run = spawnSync(process.execPath, [REPORT, '--a', a, '--b', b], { encoding: 'utf8' })
  assert.equal(run.status, 2)
  assert.match(run.stderr, /未知任务 ghost/)
})

for (const dir of dirs) rmSync(dir, { recursive: true, force: true })

console.log(`\nbench: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
