/**
 * 开发机 L2 离线门禁执行器（P2-2）。
 *
 * 生产不部署 agent-eval，所以这里只接受 `AGENT_EVAL_ROOT`：
 * - 根目录下必须有 `src/cli.mjs`，否则 `available=false`，`/eval run l2` 明说未部署；
 * - 执行固定命令 `gate --runtime dsh-wfxm --advisory`，不接收任意 suite/参数；
 * - 结果从 `gate.json` 与各套件 `summary.json` 读取，报告留在 `.eval-runs/`。
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export interface EvalSuiteResult {
  name: string
  passed: number
  total: number
  rate: number
}

export interface EvalFailure {
  suite: string
  taskId: string | null
  rate?: number
  detail?: string
}

export interface EvalL2Outcome {
  ok: boolean
  advisory: boolean
  passed: number
  total: number
  suites: EvalSuiteResult[]
  failures: EvalFailure[]
  /** `.eval-runs/` 下的本次报告目录。 */
  reportRef: string
  durationMs: number
}

export interface EvalL2Runner {
  readonly available: boolean
  run(): Promise<EvalL2Outcome>
}

export class EvalEngineMissingError extends Error {}
export class EvalTimeoutError extends Error {}

export interface L2RunnerOptions {
  root: string | null
  /** 默认 10 分钟（与方案一致）。 */
  timeoutMs?: number
  /** P2-5：生产脱敏轨迹目录；存在时 gate 用它替换内置种子。 */
  trajectoryDir?: string | null
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

/** 从 `gate.json` + 各套件 `summary.json` 汇总失败任务。 */
function collectReport(outDir: string): EvalL2Outcome {
  const gate = readJson(join(outDir, 'gate.json'))
  if (gate === null) throw new Error('agent-eval gate 未生成 gate.json')

  const rawSuites = Array.isArray(gate.suites) ? gate.suites : []
  const suites: EvalSuiteResult[] = rawSuites.map((item) => {
    const suite = item !== null && typeof item === 'object' ? item as Record<string, unknown> : {}
    return {
      name: asString(suite.name) ?? '?',
      passed: asNumber(suite.passed),
      total: asNumber(suite.total),
      rate: asNumber(suite.rate),
    }
  })

  const failures: EvalFailure[] = []
  for (const suite of suites) {
    const summary = readJson(join(outDir, suite.name, 'summary.json'))
    const results = summary !== null && Array.isArray(summary.results) ? summary.results : []
    let taskFailures = 0
    for (const item of results) {
      const result = item !== null && typeof item === 'object' ? item as Record<string, unknown> : {}
      if (result.passed !== false) continue
      taskFailures += 1
      failures.push({
        suite: suite.name,
        taskId: asString(result.taskId),
        ...(typeof result.rate === 'number' ? { rate: result.rate } : {}),
        ...(asString(result.reason) === null ? {} : { detail: asString(result.reason) as string }),
      })
    }
    // 套件级失败但没有任务明细：仍然留一条 finding，避免"看起来全过"。
    if (suite.total > 0 && suite.passed < suite.total && taskFailures === 0) {
      failures.push({ suite: suite.name, taskId: null, rate: suite.rate })
    }
  }

  return {
    ok: gate.ok === true,
    advisory: gate.advisory === true,
    passed: suites.reduce((sum, suite) => sum + suite.passed, 0),
    total: suites.reduce((sum, suite) => sum + suite.total, 0),
    suites,
    failures,
    reportRef: outDir,
    durationMs: Date.now() - Date.parse(String(gate.startedAt ?? '')) || 0,
  }
}

export function createL2Runner(options: L2RunnerOptions): EvalL2Runner {
  const root = options.root === null || options.root === '' ? null : resolve(options.root)
  const timeoutMs = options.timeoutMs ?? 600_000
  const available = root !== null && existsSync(join(root, 'src', 'cli.mjs'))

  return {
    available,
    async run(): Promise<EvalL2Outcome> {
      if (root === null || !available) {
        throw new EvalEngineMissingError('AGENT_EVAL_ROOT 未设置或缺少 src/cli.mjs')
      }
      const gateId = `dsh-l2-${new Date().toISOString().replace(/[:.]/g, '-')}`
      const outDir = join(root, '.eval-runs', gateId)
      mkdirSync(outDir, { recursive: true })
      const startedAt = Date.now()
      const env = { ...process.env }
      // Trae 的旧 libstdc++ 会让 better-sqlite3 报 GLIBCXX；评测子进程沿用干净环境。
      delete env.LD_LIBRARY_PATH
      if (typeof options.trajectoryDir === 'string' && existsSync(options.trajectoryDir)) {
        env.DSH_EVAL_TRAJECTORY_DIR = options.trajectoryDir
      }

      await new Promise<void>((settle, reject) => {
        const child = spawn(process.execPath, [
          'src/cli.mjs',
          'gate',
          '--runtime',
          'dsh-wfxm',
          '--out',
          outDir,
          '--advisory',
        ], {
          cwd: root,
          env,
          stdio: 'ignore',
        })
        let done = false
        const timer = setTimeout(() => {
          if (done) return
          done = true
          child.kill('SIGKILL')
          reject(new EvalTimeoutError(`agent-eval gate 超过 ${Math.round(timeoutMs / 1000)}s`))
        }, timeoutMs)
        child.on('error', (error) => {
          if (done) return
          done = true
          clearTimeout(timer)
          reject(error)
        })
        child.on('close', (code) => {
          if (done) return
          done = true
          clearTimeout(timer)
          // 非 0 退出是"未通过"的正常表达；只有拿不到 gate.json 才算执行失败。
          if (code !== 0 && !existsSync(join(outDir, 'gate.json'))) {
            reject(new Error(`agent-eval gate 退出码 ${code ?? 'null'}，且未生成 gate.json`))
            return
          }
          settle()
        })
      })

      const outcome = collectReport(outDir)
      return { ...outcome, durationMs: Date.now() - startedAt }
    },
  }
}
