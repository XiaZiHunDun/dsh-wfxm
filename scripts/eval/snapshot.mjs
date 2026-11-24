#!/usr/bin/env node
/**
 * 生成 `/eval` 的只读快照 `eval/latest.json`（P2-1）。
 *
 *   node scripts/eval/snapshot.mjs [--out eval/latest.json] [--engine <agent-eval>] [--no-gate] [--force]
 *
 * - 找得到 agent-eval：跑一次离线门禁（五套件，无模型），并摘录 `baselines/dsh-*.json`。
 * - 找不到：保留已有快照；确实没有才写 `source: "unavailable"`，绝不伪造通过。
 * - `release.mjs prepare` 会调用本脚本；失败只告警，不阻断发布。
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
  try {
    execFileSync(process.execPath, [
      'src/cli.mjs',
      'gate',
      '--runtime',
      'dsh-wfxm',
      '--out',
      runDir,
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
    advisory: true,
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
  console.log(`eval snapshot: ${out}（source=${snapshot.source}，gate=${snapshot.gate === null ? 'none' : snapshot.gate.ok ? 'pass' : 'fail'}，失败 ${snapshot.failures.length}）`)
}
