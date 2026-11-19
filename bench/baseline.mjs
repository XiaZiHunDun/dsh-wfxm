#!/usr/bin/env node
/**
 * M9b baseline — multi-round, aggregated, optionally enforced.
 *
 * Runs the fixed bench task set N times with the real dsh, aggregates per-task
 * pass rates, archives JSON/MD, and compares against a reference baseline.
 *
 * Advisory by default (D19-3=B): regressions are printed but exit 0. Add
 * `--enforce` to return 3 when the reference comparison finds a regression.
 * `--write-reference` promotes the current multi-round aggregate to reference.
 *
 * Usage:
 *   node bench/baseline.mjs --label 2026-11-19 --rounds 3
 *     [--profile headless] [--tasks bench/tasks.json] [--exclude id1,id2]
 *     [--timeout 90000] [--archive bench/results]
 *     [--reference bench/baselines/reference.json] [--write-reference]
 *     [--thresholds bench/thresholds.json] [--enforce]
 *     [--records existing.ndjson]
 *
 * Default exclusion is the two `change` tasks: baseline runs must not restart
 * or stop real services.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_THRESHOLDS,
  aggregateRounds,
  archivePath,
  compareBaseline,
  loadTasks,
  parseResults,
  renderAggregateMarkdown,
  renderRegressMarkdown,
  validateTasks,
  validateThresholds,
} from './lib.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const RUN = join(HERE, 'run.mjs')
const RUNNER = join(HERE, 'runner.mjs')
const DEFAULT_EXCLUDE = 'svc-restart-managed,svc-stop-managed'

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : process.argv[index + 1]
}

function selectedTasks(tasks, exclude) {
  const excluded = new Set(exclude.split(',').map((id) => id.trim()).filter((id) => id !== ''))
  return { excluded: [...excluded], tasks: tasks.filter((task) => !excluded.has(task.id)) }
}

function readThresholds(path) {
  if (!existsSync(path)) return { thresholds: DEFAULT_THRESHOLDS, errors: [] }
  let doc
  try {
    doc = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    return { thresholds: DEFAULT_THRESHOLDS, errors: [`无法读取阈值 ${path}: ${error.message}`] }
  }
  return validateThresholds(doc)
}

function parseRound(path, taskIds) {
  const parsed = parseResults(readFileSync(path, 'utf8'), taskIds)
  if (parsed.errors.length > 0) {
    return { error: parsed.errors.map((item) => `记录错误：${item}`).join('\n') }
  }
  return { records: parsed.records }
}

function main() {
  const label = arg('label', 'baseline')
  const profile = arg('profile', 'headless')
  const dsh = arg('dsh', 'dsh')
  const tasksPath = arg('tasks', join(HERE, 'tasks.json'))
  const exclude = arg('exclude', DEFAULT_EXCLUDE)
  const timeout = Number(arg('timeout', '90000'))
  const rounds = Number(arg('rounds', '1'))
  const archiveDir = arg('archive', join(HERE, 'results'))
  const referencePath = arg('reference', join(HERE, 'baselines', 'reference.json'))
  const thresholdsPath = arg('thresholds', join(HERE, 'thresholds.json'))
  const writeReference = process.argv.includes('--write-reference')
  const enforce = process.argv.includes('--enforce')
  const at = new Date()

  if (!Number.isInteger(rounds) || rounds < 1) {
    console.error('--rounds 必须是大于等于 1 的整数')
    return 2
  }

  const doc = loadTasks(tasksPath)
  const { tasks, errors } = validateTasks(doc)
  if (errors.length > 0) {
    for (const error of errors) console.error(`任务集错误：${error}`)
    return 2
  }
  const picked = selectedTasks(tasks, exclude)
  if (picked.tasks.length === 0) {
    console.error('排除后没有剩余任务')
    return 2
  }

  const parsedThresholds = readThresholds(thresholdsPath)
  if (parsedThresholds.errors.length > 0) {
    for (const error of parsedThresholds.errors) console.error(`阈值错误：${error}`)
    return 2
  }
  const thresholds = parsedThresholds.thresholds
  if (writeReference && rounds < thresholds.minRounds) {
    console.error(`--write-reference 至少需要 ${thresholds.minRounds} 轮`)
    return 2
  }

  const base = archivePath(archiveDir, label, at).replace(/\.json$/, '')
  const allRecords = []
  const existing = arg('records')
  if (existing !== undefined) {
    const round = parseRound(existing, picked.tasks.map((task) => task.id))
    if (round.error !== undefined) {
      console.error(round.error)
      return 2
    }
    allRecords.push(...round.records)
  } else {
    const command = `${process.execPath} ${RUNNER}`
    for (let index = 1; index <= rounds; index += 1) {
      const group = `baseline-r${index}`
      const out = `${base}-r${index}.ndjson`
      const run = spawnSync(process.execPath, [
        RUN,
        '--group', group,
        '--cmd', command,
        '--out', out,
        '--tasks', tasksPath,
        '--exclude', exclude,
        '--timeout', String(timeout + 30_000),
      ], {
        encoding: 'utf8',
        env: {
          ...process.env,
          DSH_BENCH_PROFILE: profile,
          DSH_BENCH_DSH: dsh,
          DSH_BENCH_TIMEOUT_MS: String(timeout),
          DSH_BENCH_TASKS: tasksPath,
          DSH_BENCH_CWD: process.cwd(),
        },
      })
      if (run.stderr) process.stderr.write(run.stderr)
      if (run.error !== undefined) {
        console.error(`第 ${index} 轮运行失败：${run.error.message}`)
        return 2
      }
      const round = parseRound(out, picked.tasks.map((task) => task.id))
      if (round.error !== undefined) {
        console.error(round.error)
        return 2
      }
      allRecords.push(...round.records)
    }
  }

  const aggregate = aggregateRounds(allRecords, picked.tasks)
  const generatedAt = new Date().toISOString()
  const meta = {
    tasksVersion: `v${doc.version}`,
    tasksCount: picked.tasks.length,
    generatedAt,
    runner: `${dsh} --profile ${profile}`,
    profile,
    excluded: picked.excluded,
  }
  const markdown = renderAggregateMarkdown(aggregate, meta)
  process.stdout.write(markdown)

  const jsonFile = `${base}.json`
  writeFileSync(jsonFile, `${JSON.stringify({
    schemaVersion: 2,
    label,
    generatedAt,
    tasksVersion: meta.tasksVersion,
    tasksCount: meta.tasksCount,
    excluded: picked.excluded,
    runner: meta.runner,
    thresholds,
    aggregate,
    records: allRecords,
  }, null, 2)}\n`)
  const markdownFile = `${base}.md`
  writeFileSync(markdownFile, markdown)
  console.error(`已归档：${jsonFile}`)
  console.error(`已归档：${markdownFile}`)

  if (writeReference) {
    writeFileSync(referencePath, `${JSON.stringify({
      schemaVersion: 2,
      label,
      generatedAt,
      tasksVersion: meta.tasksVersion,
      tasksCount: meta.tasksCount,
      excluded: picked.excluded,
      runner: meta.runner,
      thresholds,
      aggregate,
    }, null, 2)}\n`)
    console.error(`已写参考基线：${referencePath}`)
  }

  if (existsSync(referencePath)) {
    const reference = JSON.parse(readFileSync(referencePath, 'utf8'))
    const result = compareBaseline(reference, aggregate, thresholds)
    const regressMarkdown = renderRegressMarkdown(result, {
      reference: referencePath,
      current: jsonFile,
      generatedAt,
    })
    process.stdout.write(`\n${regressMarkdown}`)
    const regressFile = `${base}-regress.md`
    writeFileSync(regressFile, regressMarkdown)
    console.error(`已归档：${regressFile}`)
    if (!result.pass && enforce) return 3
  } else if (enforce) {
    console.error(`参考基线不存在：${referencePath}`)
    return 2
  }

  return 0
}

process.exitCode = main()
