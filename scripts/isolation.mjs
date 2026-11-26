#!/usr/bin/env node
/**
 * Manual isolation ops (B4-b Phase 2, 11 §14.4 / 15 §10.7).
 *
 *   node scripts/isolation.mjs status <taskId>
 *   node scripts/isolation.mjs merge <taskId> [--target <branch>] [--no-cleanup]
 *   node scripts/isolation.mjs release <taskId> --reason merged|abandoned|failed
 *   node scripts/isolation.mjs prune [--older-than 7d] [--dry-run]
 *
 * Merge stays manual (`projects.merge_mode='manual'`). This command ignores the
 * worktree switch on purpose: closing it must not strand existing worktrees
 * (15 §10.10 #7). Exit codes: 0 ok, 1 usage/error, 2 merge conflict.
 */

import { createMemoryStore } from '@dsh-wfxm/knowledge'
import { createIsolationService, createTaskStore } from '@dsh-wfxm/tasks'
import { createTelemetryStore } from '@dsh-wfxm/telemetry'
import { parseServeConfig } from './lib/startup.mjs'

const EXIT_CONFLICT = 2

function usage() {
  return [
    'usage:',
    '  isolation.mjs status <taskId>',
    '  isolation.mjs merge <taskId> [--target <branch>] [--no-cleanup]',
    '  isolation.mjs release <taskId> --reason merged|abandoned|failed',
    '  isolation.mjs prune [--older-than 7d] [--dry-run]',
  ].join('\n')
}

function parseDuration(raw) {
  const match = /^(\d+)([dhms])$/.exec(raw)
  if (match === null) throw new Error(`invalid duration ${JSON.stringify(raw)} (use 7d / 12h / 30m / 90s)`)
  const value = Number(match[1])
  const unit = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1_000 }[match[2]]
  return value * unit
}

function projectOf(memory, task) {
  if (task.projectId === null) throw new Error(`task ${task.id} has no projectId; nothing to merge or clean`)
  const project = memory.getProject(task.projectId)
  if (project === null) throw new Error(`project ${task.projectId} not found`)
  return project
}

async function main(argv) {
  const [command, ...rest] = argv
  if (command === undefined || command === '--help' || command === '-h') {
    console.log(usage())
    return 0
  }

  const config = parseServeConfig(process.env)
  const tasks = createTaskStore(config.dbPath)
  const memory = createMemoryStore(config.dbPath)
  const telemetry = createTelemetryStore({
    dbPath: config.dbPath,
    traceDir: `${config.dataDir}/traces`,
  })
  const service = createIsolationService({
    tasks,
    telemetry,
    logger: {
      info: (message) => console.log(message),
      warn: (message) => console.error(message),
    },
  })

  try {
    if (command === 'status') {
      const taskId = rest[0]
      if (taskId === undefined) throw new Error('status needs a taskId')
      const status = service.status(taskId)
      console.log(
        [
          `task ${status.taskId}`,
          `isolation=${status.mode}`,
          `prepare=${status.prepareState}`,
          `merge=${status.mergeState}`,
          `worktree=${status.worktreePath ?? '-'}`,
          `exists=${status.worktreeExists ? 'yes' : 'no'}`,
          `branch=${status.branch ?? '-'}`,
        ].join(' '),
      )
      return 0
    }

    if (command === 'merge') {
      const taskId = rest[0]
      if (taskId === undefined) throw new Error('merge needs a taskId')
      let targetBranch
      let cleanup = true
      for (let index = 1; index < rest.length; index += 1) {
        if (rest[index] === '--target') {
          targetBranch = rest[index + 1]
          if (targetBranch === undefined) throw new Error('--target needs a branch name')
          index += 1
        } else if (rest[index] === '--no-cleanup') {
          cleanup = false
        } else {
          throw new Error(`unknown merge option ${rest[index]}`)
        }
      }
      const task = tasks.getTask(taskId)
      if (task === null) throw new Error(`task ${taskId} not found`)
      const result = await service.merge(taskId, projectOf(memory, task), {
        ...targetBranch === undefined ? {} : { targetBranch },
        cleanup,
      })
      if (result.state === 'conflict') {
        console.error(`conflict: ${result.conflictPaths.length} file(s) need manual resolution`)
        for (const path of result.conflictPaths) console.error(`  ${path}`)
        console.error(`resolve, then rerun: node scripts/isolation.mjs merge ${taskId}`)
        return EXIT_CONFLICT
      }
      console.log(
        `merged ${result.task.branch} into ${result.targetBranch}`
          + (result.commit === null ? '' : ` (commit ${result.commit.slice(0, 12)})`),
      )
      if (cleanup) {
        console.log(
          `cleanup: worktree ${result.worktreeRemoved ? 'removed' : 'kept'}, `
            + `branch ${result.branchDeleted ? 'deleted' : 'kept'}`,
        )
      }
      return 0
    }

    if (command === 'release') {
      const taskId = rest[0]
      if (taskId === undefined) throw new Error('release needs a taskId')
      const at = rest.indexOf('--reason')
      const reason = at === -1 ? undefined : rest[at + 1]
      if (reason !== 'merged' && reason !== 'abandoned' && reason !== 'failed') {
        throw new Error('release needs --reason merged|abandoned|failed')
      }
      const task = tasks.getTask(taskId)
      if (task === null) throw new Error(`task ${taskId} not found`)
      const result = await service.release(taskId, reason, projectOf(memory, task))
      console.log(
        result.alreadyReleased
          ? `already released: ${taskId} (merge=${result.task.mergeState})`
          : `released ${taskId} (merge=${result.task.mergeState}, `
            + `worktree ${result.removedWorktree ? 'removed' : 'kept'}, `
            + `branch ${result.deletedBranch ? 'deleted' : 'kept'})`,
      )
      return 0
    }

    if (command === 'prune') {
      let olderThanMs
      let dryRun = false
      for (let index = 0; index < rest.length; index += 1) {
        if (rest[index] === '--older-than') {
          const value = rest[index + 1]
          if (value === undefined) throw new Error('--older-than needs a duration (e.g. 7d)')
          olderThanMs = parseDuration(value)
          index += 1
        } else if (rest[index] === '--dry-run') {
          dryRun = true
        } else {
          throw new Error(`unknown prune option ${rest[index]}`)
        }
      }
      let failed = 0
      for (const project of memory.listProjects()) {
        const result = await service.prune(project, {
          ...olderThanMs === undefined ? {} : { olderThanMs },
          dryRun,
        })
        failed += result.failed.length
        if (dryRun) {
          console.log(`prune ${project.name}: ${result.candidates.length} candidate(s), dry-run`)
          for (const task of result.candidates) console.log(`  ${task.taskRef ?? task.id} ${task.worktreePath}`)
        } else {
          console.log(
            `prune ${project.name}: removed ${result.removed.length}, failed ${result.failed.length}, `
              + `scanned ${result.scanned}`,
          )
        }
      }
      return failed > 0 ? 1 : 0
    }

    console.error(`unknown command ${command}`)
    console.error(usage())
    return 1
  } finally {
    memory.close()
    tasks.close()
    telemetry.close()
  }
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
