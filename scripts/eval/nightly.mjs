#!/usr/bin/env node
/**
 * P7-2 日常测评（nightly）。
 *
 *   node scripts/eval/nightly.mjs [--engine <agent-eval>] [--db <ops.sqlite>]
 *                                 [--out <snapshot>] [--hard]
 *
 * 1. 复用 `scripts/eval/snapshot.mjs`：跑 L2 门禁（advisory）+ 摘录真实基线，
 *    写到数据目录的 `eval/latest.json`（release 只读，不能写）。
 * 2. 把快照按 `recordedAt` 幂等同步进 `eval_runs` / `eval_findings`；
 *    周报与 `/eval findings` 直接读这两张表。
 *
 * 只有「引擎缺失 / 快照不可用」才非 0 退出；门禁未通过本身是数据（写成
 * failed run + findings），不让 timer 每天报错。真实 dsh 基线由 agent-eval
 * 的 CI/nightly 负责，这里不重复跑模型。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createEvalStore } from '@dsh-wfxm/eval'
import { parseServeConfig } from '../lib/startup.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const args = process.argv.slice(2)
const option = (name) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? undefined : args[index + 1]
}
const hard = args.includes('--hard')

const config = parseServeConfig(process.env)
const engineRoot = resolve(option('engine') ?? process.env.AGENT_EVAL_ROOT ?? join(repoRoot, '..', 'agent-eval'))
const dbPath = resolve(option('db') ?? config.dbPath)
const out = resolve(option('out') ?? join(config.dataDir, 'eval', 'latest.json'))

function fail(message) {
  console.error(`nightly eval: ${message}`)
  process.exitCode = 1
}

if (!existsSync(join(engineRoot, 'src', 'cli.mjs'))) {
  fail(`agent-eval 不在 ${engineRoot}（缺 src/cli.mjs）；未生成任何 run`)
  process.exit(0)
}

const snapshotScript = join(repoRoot, 'scripts', 'eval', 'snapshot.mjs')
const env = { ...process.env }
// Trae 的 LD_LIBRARY_PATH 会让 better-sqlite3 找不到 GLIBCXX。
delete env.LD_LIBRARY_PATH
const result = spawnSync(process.execPath, [
  snapshotScript,
  '--engine', engineRoot,
  '--out', out,
  ...(hard ? [] : ['--advisory']),
], {
  env,
  encoding: 'utf8',
})
if (result.stdout) process.stdout.write(result.stdout)
if (result.status !== 0 && result.stderr) process.stderr.write(result.stderr)

let snapshot
try {
  snapshot = JSON.parse(readFileSync(out, 'utf8'))
} catch (error) {
  fail(`快照不可读（${out}）：${error instanceof Error ? error.message : String(error)}`)
  process.exit(0)
}

if (snapshot === null || typeof snapshot !== 'object' || typeof snapshot.recordedAt !== 'string') {
  fail(`快照结构不合法（${out}）；未写库`)
  process.exit(0)
}
if (snapshot.source === 'unavailable') {
  fail(`快照 source=unavailable（引擎未实际运行）；未写库`)
  process.exit(0)
}

const ageMs = Date.now() - Date.parse(snapshot.recordedAt)
if (!Number.isFinite(ageMs) || ageMs > 26 * 3_600_000) {
  fail(`快照记录时间 ${snapshot.recordedAt} 已过期；未写库`)
  process.exit(0)
}

const store = createEvalStore(dbPath)
try {
  const { run, created, findings } = store.syncSnapshot(snapshot)
  const open = store.listOpenFindings(1000).length
  console.log(
    `nightly eval: run ${run.id.slice(0, 8)} ${run.status} · `
      + `${run.passed ?? 0}/${run.total ?? 0} · 新 findings ${findings}`
      + `${created ? '' : '（本次快照已同步过）'} · open ${open}`,
  )
} finally {
  store.close()
}
