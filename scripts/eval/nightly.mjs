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
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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
const candidatesDir = resolve(option('candidates') ?? join(config.dataDir, 'eval', 'candidates'))
const stagingDir = resolve(option('staging') ?? join(config.dataDir, 'eval', 'replay'))

/**
 * P7-4：把可回放的候选改写成自带 `events` 的草稿。
 *
 * - 只收 expect 非空、turns 非空的候选，避免把 `/eval promote` 的占位草稿
 *   当成"回放通过"的证据；
 * - 轨迹内联进 `runtimeHints.dsh.events`，gate 不再依赖候选目录或 DSH_ROOT 路径；
 * - 暂存目录每次重建，保证只回放当前候选。
 */
function stageCandidates() {
  rmSync(stagingDir, { recursive: true, force: true })
  mkdirSync(stagingDir, { recursive: true })
  let staged = 0
  let skipped = 0
  if (!existsSync(candidatesDir)) return { staged, skipped }
  for (const name of readdirSync(candidatesDir).filter((item) => item.endsWith('.json'))) {
    try {
      const draft = JSON.parse(readFileSync(join(candidatesDir, name), 'utf8'))
      if (typeof draft?.id !== 'string' || draft.kind !== 'chat') {
        skipped += 1
        continue
      }
      if (!Array.isArray(draft.turns) || draft.turns.length === 0) {
        skipped += 1
        continue
      }
      const expect = draft.expect
      if (expect === null || typeof expect !== 'object' || Object.keys(expect).length === 0) {
        skipped += 1
        continue
      }
      const ndjson = readFileSync(join(candidatesDir, `${draft.id}.ndjson`), 'utf8')
      const events = ndjson.split('\n').filter(Boolean).map((line) => JSON.parse(line))
      const hints = { ...(draft.runtimeHints ?? {}) }
      hints.dsh = { ...(hints.dsh ?? {}), events }
      delete hints.dsh.traceFile
      const safeId = draft.id.replace(/[^A-Za-z0-9._-]/g, '')
      if (safeId === '') {
        skipped += 1
        continue
      }
      writeFileSync(join(stagingDir, `${safeId}.json`), `${JSON.stringify({ ...draft, runtimeHints: hints }, null, 2)}\n`)
      staged += 1
    } catch {
      skipped += 1
    }
  }
  return { staged, skipped }
}

function fail(message) {
  console.error(`nightly eval: ${message}`)
  process.exitCode = 1
}

if (!existsSync(join(engineRoot, 'src', 'cli.mjs'))) {
  fail(`agent-eval 不在 ${engineRoot}（缺 src/cli.mjs）；未生成任何 run`)
  process.exit(0)
}

const snapshotScript = join(repoRoot, 'scripts', 'eval', 'snapshot.mjs')
const staging = stageCandidates()
const env = { ...process.env }
// Trae 的 LD_LIBRARY_PATH 会让 better-sqlite3 找不到 GLIBCXX。
delete env.LD_LIBRARY_PATH
const result = spawnSync(process.execPath, [
  snapshotScript,
  '--engine', engineRoot,
  '--out', out,
  ...(staging.staged > 0 ? ['--trajectory', stagingDir] : []),
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
  const replay = store.recordReplays(Array.isArray(snapshot.trajectory) ? snapshot.trajectory : [])
  const open = store.listOpenFindings(1000).length
  console.log(
    `nightly eval: run ${run.id.slice(0, 8)} ${run.status} · `
      + `${run.passed ?? 0}/${run.total ?? 0} · 新 findings ${findings}`
      + `${created ? '' : '（本次快照已同步过）'} · open ${open}`
      + ` · replay verified ${replay.verified} regressed ${replay.regressed} failed ${replay.failed}`,
  )
  console.log(
    `nightly eval: candidates staged ${staging.staged}（skipped ${staging.skipped}）`
      + `${staging.staged === 0 ? '；无候选可回放' : ''}`,
  )
} finally {
  store.close()
}
