#!/usr/bin/env node
/**
 * M9a baseline — one real dsh run over the fixed bench task set.
 *
 * Advisory by design (D19-3=B): a low pass rate is reported and archived, it
 * does not fail CI or block a release. The point is to have a repeatable
 * reference point before thresholds are discussed.
 *
 * Usage:
 *   node bench/baseline.mjs --label 2026-11-19 [--profile headless]
 *     [--tasks bench/tasks.json] [--exclude id1,id2] [--timeout 120000]
 *     [--records existing.ndjson] [--archive bench/results]
 *
 * Default exclusion is the two `change` tasks: baseline runs must not restart
 * or stop real services. They remain in tasks.json for manual/approval runs.
 */

import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  archivePath,
  archiveReport,
  loadTasks,
  parseResults,
  renderBaselineMarkdown,
  summarize,
  validateTasks,
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
  return {
    excluded: [...excluded],
    tasks: tasks.filter((task) => !excluded.has(task.id)),
  }
}

function main() {
  const label = arg('label', 'baseline')
  const profile = arg('profile', 'headless')
  const dsh = arg('dsh', 'dsh')
  const tasksPath = arg('tasks', join(HERE, 'tasks.json'))
  const exclude = arg('exclude', DEFAULT_EXCLUDE)
  const timeout = Number(arg('timeout', '120000'))
  const archiveDir = arg('archive', join(HERE, 'results'))
  const at = new Date()

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

  const recordsPath = arg('records', archivePath(archiveDir, label, at).replace(/\.json$/, '.ndjson'))
  let records
  if (arg('records') !== undefined) {
    const parsed = parseResults(readFileSync(recordsPath, 'utf8'), picked.tasks.map((task) => task.id))
    if (parsed.errors.length > 0) {
      for (const error of parsed.errors) console.error(`记录错误：${error}`)
      return 2
    }
    records = parsed.records
  } else {
    const command = `${process.execPath} ${RUNNER}`
    const run = spawnSync(process.execPath, [
      RUN,
      '--group', 'baseline',
      '--cmd', command,
      '--out', recordsPath,
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
      console.error(`运行失败：${run.error.message}`)
      return 2
    }
    const parsed = parseResults(readFileSync(recordsPath, 'utf8'), picked.tasks.map((task) => task.id))
    if (parsed.errors.length > 0) {
      for (const error of parsed.errors) console.error(`记录错误：${error}`)
      return 2
    }
    records = parsed.records
  }

  const summary = summarize(records, picked.tasks, 'baseline')
  const generatedAt = new Date().toISOString()
  const meta = {
    tasksVersion: `v${doc.version}`,
    tasksCount: picked.tasks.length,
    generatedAt,
    runner: `${dsh} --profile ${profile}`,
    profile,
    excluded: picked.excluded,
  }
  const markdown = renderBaselineMarkdown(summary, meta)
  process.stdout.write(markdown)

  const jsonFile = archiveReport(archiveDir, label, {
    schemaVersion: 1,
    generatedAt,
    tasksVersion: meta.tasksVersion,
    tasksCount: meta.tasksCount,
    excluded: picked.excluded,
    runner: meta.runner,
    summary,
    records,
  }, at)
  const markdownFile = jsonFile.replace(/\.json$/, '.md')
  writeFileSync(markdownFile, markdown)
  console.error(`已归档：${jsonFile}`)
  console.error(`已归档：${markdownFile}`)
  return 0
}

process.exitCode = main()
