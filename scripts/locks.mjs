#!/usr/bin/env node
/**
 * Resource-lock ops view (Slice AA, 11 §14.6 / 15 §10.4).
 *
 *   node scripts/locks.mjs list [--all] [--json]
 *   node scripts/locks.mjs release <lockId>
 *   node scripts/locks.mjs release --task <taskId|taskRef>
 *
 * Read/release only: acquisition belongs to the worker (task.plan.resources).
 * Exit codes: 0 ok, 1 usage/error.
 */

import { createTaskStore } from '@dsh-wfxm/tasks'
import { parseServeConfig } from './lib/startup.mjs'

function usage() {
  return [
    'usage:',
    '  locks.mjs list [--all] [--json]',
    '  locks.mjs release <lockId>',
    '  locks.mjs release --task <taskId|taskRef>',
  ].join('\n')
}

function parseOptions(args, { values = [], flags = [] } = {}) {
  const options = {}
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (!arg.startsWith('--')) throw new Error(`unexpected argument ${JSON.stringify(arg)}`)
    const key = arg.slice(2)
    if (flags.includes(key)) {
      options[key] = true
    } else if (values.includes(key)) {
      const value = args[index + 1]
      if (value === undefined) throw new Error(`${arg} needs a value`)
      options[key] = value
      index += 1
    } else {
      throw new Error(`unknown option ${arg}`)
    }
  }
  return options
}

function printLock(lock) {
  const released = lock.releasedAt === null ? '' : `  released=${lock.releasedAt}`
  console.log(
    `${lock.id}  ${lock.resourceKey}  task=${lock.taskId}  `
      + `owner=${lock.leaseOwner ?? '-'}  expires=${lock.leaseExpiresAt}${released}`,
  )
}

function findTask(tasks, ref) {
  return tasks.getTask(ref) ?? tasks.listTasks().find((task) => task.taskRef === ref) ?? null
}

function main(argv) {
  const [command, ...rest] = argv
  if (command === undefined || command === '--help' || command === '-h') {
    console.log(usage())
    return 0
  }

  const config = parseServeConfig(process.env)
  const tasks = createTaskStore(config.dbPath)
  try {
    if (command === 'list') {
      const options = parseOptions(rest, { flags: ['all', 'json'] })
      const locks = tasks.listResourceLocks({ includeReleased: options.all === true })
      if (options.json === true) {
        console.log(JSON.stringify(locks, null, 2))
        return 0
      }
      if (locks.length === 0) {
        console.log('no resource locks')
        return 0
      }
      for (const lock of locks) printLock(lock)
      return 0
    }

    if (command === 'release') {
      if (rest[0] === '--task') {
        const ref = rest[1]
        if (ref === undefined) throw new Error('release --task needs a task id or taskRef')
        parseOptions(rest.slice(2), {})
        const task = findTask(tasks, ref)
        if (task === null) throw new Error(`task not found: ${ref}`)
        const released = tasks.releaseTaskResourceLocks(task.id)
        console.log(released === 0 ? `no live locks for ${task.taskRef ?? task.id}` : `released ${released} lock(s) for ${task.taskRef ?? task.id}`)
        return 0
      }
      const lockId = rest[0]
      if (lockId === undefined) throw new Error('release needs a lock id or --task')
      parseOptions(rest.slice(1), {})
      const released = tasks.releaseResourceLocks([lockId])
      console.log(released === 0 ? `already released or unknown: ${lockId}` : `released ${lockId}`)
      return 0
    }

    console.error(`unknown command ${command}`)
    console.error(usage())
    return 1
  } finally {
    tasks.close()
  }
}

try {
  process.exitCode = main(process.argv.slice(2))
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
