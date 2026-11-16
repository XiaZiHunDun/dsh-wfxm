#!/usr/bin/env node
/**
 * Manual project registry ops (Slice W, 11 §14.7 / 15 §10.3).
 *
 *   node scripts/projects.mjs add --name <name> --root <path> [--prepare-cmd <cmd>]
 *                                 [--worktree-root <path>] [--merge-mode manual|pr] [--vcs git|none]
 *   node scripts/projects.mjs list [--all] [--json]
 *   node scripts/projects.mjs update <id|name> [--root <path>] [--prepare-cmd <cmd>]
 *                                 [--worktree-root <path>] [--merge-mode manual|pr] [--vcs git|none]
 *   node scripts/projects.mjs remove <id|name>
 *
 * Registration only: this command never reads the worktree switch, never creates a
 * task and never creates a worktree. Enabling `DSH_WFXM_WORKTREE_ISOLATION` stays an
 * explicit owner action (15 §10.8). Exit codes: 0 ok, 1 usage/error.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { createMemoryStore } from '@dsh-wfxm/knowledge'
import { parseServeConfig } from './lib/startup.mjs'

const MERGE_MODES = ['manual', 'pr']
const VCS_KINDS = ['git', 'none']

function usage() {
  return [
    'usage:',
    '  projects.mjs add --name <name> --root <path> [--prepare-cmd <cmd>]',
    '                   [--worktree-root <path>] [--merge-mode manual|pr] [--vcs git|none]',
    '  projects.mjs list [--all] [--json]',
    '  projects.mjs update <id|name> [--root <path>] [--prepare-cmd <cmd>]',
    '                   [--worktree-root <path>] [--merge-mode manual|pr] [--vcs git|none]',
    '  projects.mjs remove <id|name>',
    '',
    'values: --prepare-cmd "" clears prepare, --worktree-root "" restores the default',
    '        (<root>/.agents/worktrees); project name is identity and cannot be renamed.',
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

function requireDirectory(raw) {
  const absolute = resolve(raw)
  if (!existsSync(absolute)) throw new Error(`--root does not exist: ${absolute}`)
  if (!statSync(absolute).isDirectory()) throw new Error(`--root is not a directory: ${absolute}`)
  return realpathSync(absolute)
}

function within(root, candidate) {
  const path = existsSync(candidate) ? realpathSync(candidate) : candidate
  return path.startsWith(root.endsWith(sep) ? root : root + sep)
}

function checkWorktreeRoot(root, raw) {
  const candidate = resolve(root, raw)
  if (!within(root, candidate)) {
    throw new Error(`--worktree-root must stay inside --root (${root}): ${candidate}`)
  }
  return candidate
}

function detectVcs(root) {
  return existsSync(join(root, '.git')) ? 'git' : 'none'
}

function checkVcs(root, raw) {
  if (raw !== undefined && !VCS_KINDS.includes(raw)) {
    throw new Error(`--vcs must be git|none (got ${JSON.stringify(raw)})`)
  }
  const detected = raw ?? detectVcs(root)
  if (detected === 'git' && !existsSync(join(root, '.git'))) {
    throw new Error(`--vcs git but no .git under ${root}`)
  }
  return detected
}

function hasRemote(root) {
  let output
  try {
    output = execFileSync('git', ['-C', root, 'remote'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
    })
  } catch (error) {
    throw new Error(`cannot read git remote: ${error instanceof Error ? error.message : String(error)}`)
  }
  return output.trim() !== ''
}

function checkMergeMode(root, vcs, raw, fallback) {
  const mode = raw ?? fallback
  if (!MERGE_MODES.includes(mode)) {
    throw new Error(`--merge-mode must be manual|pr (got ${JSON.stringify(mode)})`)
  }
  if (mode === 'pr') {
    if (vcs !== 'git') throw new Error('--merge-mode pr needs a git project')
    if (!hasRemote(root)) throw new Error('--merge-mode pr needs a configured git remote')
  }
  return mode
}

function findProject(memory, ref) {
  return memory.getProject(ref)
    ?? memory.getProjectByName(ref)
    ?? memory.listProjects({ includeArchived: true }).find((project) => project.id === ref || project.name === ref)
    ?? null
}

function sameRoot(left, right) {
  const a = existsSync(left) ? realpathSync(left) : left
  const b = existsSync(right) ? realpathSync(right) : right
  return a === b
}

function printProject(project) {
  const archived = project.archivedAt === null ? '' : `  archived=${project.archivedAt}`
  console.log(`${project.id}  ${project.name}  ${project.vcs}  ${project.mergeMode}  ${project.rootPath}${archived}`)
}

function addProject(memory, rest) {
  const options = parseOptions(rest, {
    values: ['name', 'root', 'prepare-cmd', 'worktree-root', 'merge-mode', 'vcs'],
  })
  if (options.name === undefined) throw new Error('add needs --name')
  if (options.root === undefined) throw new Error('add needs --root')

  const name = options.name.trim()
  if (name === '') throw new Error('--name must not be empty')
  const existing = memory.getProjectByName(name)
  if (existing !== null) throw new Error(`project name already registered: ${name} (${existing.id})`)

  const rootPath = requireDirectory(options.root)
  const duplicate = memory
    .listProjects()
    .find((project) => sameRoot(project.rootPath, rootPath))
  if (duplicate !== undefined) {
    throw new Error(`root already registered: ${rootPath} (${duplicate.name}, ${duplicate.id})`)
  }

  const vcs = checkVcs(rootPath, options.vcs)
  const worktreeRoot = options['worktree-root'] === undefined || options['worktree-root'] === ''
    ? null
    : checkWorktreeRoot(rootPath, options['worktree-root'])
  const mergeMode = checkMergeMode(rootPath, vcs, options['merge-mode'], 'manual')

  const project = memory.upsertProject({
    name,
    rootPath,
    vcs,
    prepareCmd: options['prepare-cmd'] === undefined || options['prepare-cmd'] === ''
      ? null
      : options['prepare-cmd'],
    worktreeRoot,
    mergeMode,
  })
  console.log(`added ${project.id}  ${project.name}  ${project.vcs}  ${project.mergeMode}  ${project.rootPath}`)
}

function listProjects(memory, rest) {
  const options = parseOptions(rest, { flags: ['all', 'json'] })
  const projects = memory.listProjects({ includeArchived: options.all === true })
  if (options.json === true) {
    console.log(JSON.stringify(projects, null, 2))
    return
  }
  if (projects.length === 0) {
    console.log('no projects registered')
    return
  }
  for (const project of projects) printProject(project)
}

function updateProject(memory, rest) {
  const [ref, ...optionArgs] = rest
  if (ref === undefined) throw new Error('update needs a project id or name')
  const options = parseOptions(optionArgs, {
    values: ['root', 'prepare-cmd', 'worktree-root', 'merge-mode', 'vcs'],
  })
  const project = findProject(memory, ref)
  if (project === null) throw new Error(`project not found: ${ref}`)

  const rootPath = options.root === undefined ? project.rootPath : requireDirectory(options.root)
  const duplicate = memory
    .listProjects()
    .find((other) => other.id !== project.id && sameRoot(other.rootPath, rootPath))
  if (duplicate !== undefined) {
    throw new Error(`root already registered: ${rootPath} (${duplicate.name}, ${duplicate.id})`)
  }

  const vcs = checkVcs(rootPath, options.vcs ?? (options.root === undefined ? project.vcs : undefined))
  const worktreeRoot = options['worktree-root'] === undefined
    ? (project.worktreeRoot === null ? null : checkWorktreeRoot(rootPath, project.worktreeRoot))
    : options['worktree-root'] === ''
      ? null
      : checkWorktreeRoot(rootPath, options['worktree-root'])
  const mergeMode = checkMergeMode(rootPath, vcs, options['merge-mode'], project.mergeMode)

  const updated = memory.upsertProject({
    name: project.name,
    rootPath,
    rulesDoc: project.rulesDoc,
    defaultExpert: project.defaultExpert,
    vcs,
    prepareCmd: options['prepare-cmd'] === undefined
      ? project.prepareCmd
      : options['prepare-cmd'] === ''
        ? null
        : options['prepare-cmd'],
    worktreeRoot,
    mergeMode,
  })
  console.log(`updated ${updated.id}  ${updated.name}  ${updated.vcs}  ${updated.mergeMode}  ${updated.rootPath}`)
}

function removeProject(memory, rest) {
  const [ref, ...optionArgs] = rest
  if (ref === undefined) throw new Error('remove needs a project id or name')
  parseOptions(optionArgs, {})
  const project = findProject(memory, ref)
  if (project === null) throw new Error(`project not found: ${ref}`)
  if (project.archivedAt !== null) {
    console.log(`already archived: ${project.id}  ${project.name}  (${project.archivedAt})`)
    return
  }
  if (!memory.archiveProject(project.id)) throw new Error(`failed to archive project ${project.id}`)
  console.log(`archived ${project.id}  ${project.name}`)
}

function main(argv) {
  const [command, ...rest] = argv
  if (command === undefined || command === '--help' || command === '-h') {
    console.log(usage())
    return 0
  }
  if (!['add', 'list', 'update', 'remove'].includes(command)) {
    console.error(`unknown command ${command}`)
    console.error(usage())
    return 1
  }

  const config = parseServeConfig(process.env)
  const memory = createMemoryStore(config.dbPath)
  try {
    if (command === 'add') addProject(memory, rest)
    else if (command === 'list') listProjects(memory, rest)
    else if (command === 'update') updateProject(memory, rest)
    else removeProject(memory, rest)
    return 0
  } finally {
    memory.close()
  }
}

try {
  process.exitCode = main(process.argv.slice(2))
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
