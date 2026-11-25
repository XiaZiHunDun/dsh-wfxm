#!/usr/bin/env node
/**
 * 生成 `/eval` 的只读快照 `eval/latest.json`（P2-1，P2-4 起可切硬门禁）。
 *
 *   node scripts/eval/snapshot.mjs [--out eval/latest.json] [--engine <agent-eval>]
 *                                  [--no-gate] [--force] [--hard|--advisory]
 *
 * - 找得到 agent-eval：跑一次离线门禁（五套件，无模型），并摘录 `baselines/dsh-*.json`。
 * - 找不到：保留已有快照；确实没有才写 `source: "unavailable"`，绝不伪造通过。
 * - 门禁模式：默认按 `EVAL_HARD_GATE` / 观察期截止（2026-12-08）判定；硬门禁时
 *   不传 `--advisory`，gate 未通过或引擎不可用都以非 0 退出，`release prepare` 会阻断。
 * - `release.mjs prepare` 会调用本脚本；advisory 期失败只告警。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const args = process.argv.slice(2)
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? fallback : args[index + 1]
}

const out = resolve(option('out', join(repoRoot, 'eval/latest.json')))
const engineRoot = resolve(option('engine', process.env.AGENT_EVAL_ROOT ?? join(repoRoot, '..', 'agent-eval')))
const noGate = args.includes('--no-gate')
const force = args.includes('--force')
const REAL_BASELINES = ['capability', 'repo', 'conversation']
/** 观察期截止：默认此前 advisory，此后硬门禁；`EVAL_HARD_GATE=0/1` 可覆盖。 */
const HARD_GATE_AFTER = Date.parse('2026-12-08T00:00:00+08:00')

function hardGateEnabled() {
  const override = process.env.EVAL_HARD_GATE
  if (override === '1') return true
  if (override === '0') return false
  if (args.includes('--hard')) return true
  if (args.includes('--advisory')) return false
  return Date.now() >= HARD_GATE_AFTER
}

const hard = hardGateEnabled()
// 显式 --no-gate 是人工兜底（只摘基线），不参与硬门禁阻断。
const enforce = hard && !noGate

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function readBaseline(name) {
  const baseline = readJson(join(engineRoot, 'baselines', `dsh-${name}.json`))
  if (baseline === null) return null
  const taskRates = baseline.taskRates ?? {}
  const taskIds = Array.isArray(baseline.tasks) ? baseline.tasks : Object.keys(taskRates)
  const passed = taskIds.filter((taskId) => taskRates[taskId] === 1).length
  const total = taskIds.length
  const rate = typeof baseline.overallRate === 'number'
    ? baseline.overallRate
    : total === 0 ? 0 : passed / total
  return {
    summary: {
      passed,
      total,
      rate,
      ...(typeof baseline.recordedAt === 'string' ? { recordedAt: baseline.recordedAt } : {}),
      failures: taskIds
        .filter((taskId) => taskRates[taskId] !== 1)
        .map((taskId) => ({ taskId, rate: typeof taskRates[taskId] === 'number' ? taskRates[taskId] : 0 })),
    },
    failures: taskIds
      .filter((taskId) => taskRates[taskId] !== 1)
      .map((taskId) => ({ suite: name, taskId, rate: typeof taskRates[taskId] === 'number' ? taskRates[taskId] : 0 })),
  }
}

function runGate() {
  const runDir = mkdtempSync(join(tmpdir(), 'eval-snapshot-'))
  const env = { ...process.env }
  // Trae 自带的 libstdc++ 会让 better-sqlite3 报 GLIBCXX 错；评测子进程沿用干净环境。
  delete env.LD_LIBRARY_PATH
  // P2-5：本机导出的生产脱敏轨迹优先于内置种子。
  const privateTraces = join(repoRoot, 'eval/trajectory')
  if (existsSync(privateTraces)) env.DSH_EVAL_TRAJECTORY_DIR = privateTraces
  try {
    execFileSync(process.execPath, [
      'src/cli.mjs',
      'gate',
      '--runtime',
      'dsh-wfxm',
      '--out',
      runDir,
      // advisory 期保留不阻断；硬门禁期必须让 gate 真正失败。
      ...(hard ? [] : ['--advisory']),
    ], {
      cwd: engineRoot,
      stdio: 'pipe',
      timeout: 120_000,
      env,
    })
  } catch (error) {
    // gate 非 0 退出是正常的"未通过"，只有拿不到 gate.json 才算失败。
    if (!existsSync(join(runDir, 'gate.json'))) {
      rmSync(runDir, { recursive: true, force: true })
      return { gate: null, error: error instanceof Error ? error.message : String(error) }
    }
  }
  const gate = readJson(join(runDir, 'gate.json'))
  rmSync(runDir, { recursive: true, force: true })
  if (gate === null) return { gate: null, error: 'gate.json 无法解析' }
  return {
    gate: {
      ok: gate.ok === true,
      advisory: gate.advisory === true,
      suites: Array.isArray(gate.suites)
        ? gate.suites.map((suite) => ({
          name: suite.name,
          passed: suite.passed,
          total: suite.total,
          rate: suite.rate,
        }))
        : [],
    },
    error: null,
  }
}

function build() {
  const engineAvailable = existsSync(join(engineRoot, 'src/cli.mjs'))
  if (!engineAvailable && existsSync(out) && !force) {
    console.log(`eval snapshot: agent-eval 不在 ${engineRoot}，保留现有 ${out}`)
    return null
  }

  const real = {}
  const failures = []
  let gate = null
  let gateError = null
  let source = 'unavailable'

  if (engineAvailable) {
    source = 'agent-eval'
    if (!noGate) {
      const result = runGate()
      gate = result.gate
      gateError = result.error
    }
    for (const name of REAL_BASELINES) {
      const baseline = readBaseline(name)
      if (baseline === null) continue
      real[name] = baseline.summary
      failures.push(...baseline.failures)
    }
  }

  const suiteFailures = (gate?.suites ?? [])
    .filter((suite) => suite.total > 0 && suite.passed !== suite.total)
    .map((suite) => ({ suite: suite.name, rate: suite.rate }))

  return {
    version: 1,
    recordedAt: new Date().toISOString(),
    source,
    advisory: !enforce,
    gate,
    ...(gateError === null ? {} : { gateError }),
    real,
    failures: [...suiteFailures, ...failures],
  }
}

const snapshot = build()
if (snapshot !== null) {
  mkdirSync(dirname(out), { recursive: true })
  const tmp = `${out}.tmp-${process.pid}`
  writeFileSync(tmp, `${JSON.stringify(snapshot, null, 2)}\n`)
  renameSync(tmp, out)
  console.log(`eval snapshot: ${out}（source=${snapshot.source}，gate=${snapshot.gate === null ? 'none' : snapshot.gate.ok ? 'pass' : 'fail'}，失败 ${snapshot.failures.length}，${enforce ? '硬门禁' : 'advisory'}）`)
  if (enforce && (snapshot.gate === null || snapshot.gate.ok !== true)) {
    console.error('eval snapshot: 硬门禁未通过（gate 缺失或 fail），release 必须阻断')
    process.exitCode = 1
  }
} else if (enforce) {
  console.error(`eval snapshot: 硬门禁需要 agent-eval（${engineRoot}），且没有可用的现有快照`)
  process.exitCode = 1
}
