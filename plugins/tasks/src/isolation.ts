/**
 * B4-b isolation resolver (11 §十四 / 15 §十).
 *
 * Decides the write unit for one task and returns the cwd the executor must
 * spawn in:
 *
 *   - git project, clean head, task still `serial` → create one worktree +
 *     branch (`wfxm/<task_ref>`), run `prepare_cmd` once, then run there;
 *   - non-git / dirty / unavailable → stay on the project workspace (serial);
 *   - an existing worktree is reused; a missing one is **not** recreated
 *     (base_commit drift), and a failed/interrupted prepare is not retried.
 *
 * This module only writes ⑤'s isolation fields. It never touches ⑥'s tables:
 * the caller passes the project shape it already read through the project port.
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { isAbsolute, join, resolve, sep } from 'node:path'
import type { Task, TaskAssertion } from './model.js'
import type { TaskStore } from './store.js'

export const DEFAULT_GIT_TIMEOUT_MS = 30_000
export const DEFAULT_PREPARE_TIMEOUT_MS = 600_000

/** Structural view of ⑥'s project row; ⑤ never imports the knowledge module. */
export interface IsolationProject {
  id: string
  name: string
  rootPath: string
  vcs: 'git' | 'none'
  prepareCmd: string | null
  worktreeRoot: string | null
}

export interface CommandResult {
  code: number | null
  stdout: string
  stderr: string
}

export type CommandRunner = (
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs: number },
) => Promise<CommandResult>

export interface IsolationResolverOptions {
  tasks: TaskStore
  /** Defaults to a real child process; tests inject a deterministic runner. */
  run?: CommandRunner
  gitTimeoutMs?: number
  prepareTimeoutMs?: number
  now?: () => Date
  logger?: { info?(message: string): void; warn?(message: string): void } | null
}

export function realRun(
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs: number },
): Promise<CommandResult> {
  return new Promise((resolveResult) => {
    execFile(
      command,
      args,
      { cwd: options.cwd, timeout: options.timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error === null
          ? 0
          : typeof (error as { code?: unknown }).code === 'number'
            ? (error as { code: number }).code
            : null
        resolveResult({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
      },
    )
  })
}

export interface CommitWorktreeOptions {
  /** Defaults to a real child process; tests inject a deterministic runner. */
  run?: CommandRunner
  gitTimeoutMs?: number
  logger?: { info?(message: string): void; warn?(message: string): void } | null
}

export interface CommitWorktreeResult {
  committed: boolean
  commit: string | null
}

const COMMIT_SUBJECT_CHARS = 120

/** 带 `commit-failed` 码的失败：worker 直接把 code 写进任务失败原因。 */
function commitFailure(message: string): Error {
  return Object.assign(new Error(message), { code: 'commit-failed' })
}

/** `task <ref>: <intent 首行>`，单行且限长，避免提交信息里塞进整段需求。 */
function commitSubject(task: Task): string {
  const firstLine = task.intent.replace(/\s+/g, ' ').trim()
  const clipped = firstLine.length <= COMMIT_SUBJECT_CHARS
    ? firstLine
    : `${firstLine.slice(0, COMMIT_SUBJECT_CHARS)}…`
  return clipped === '' ? `task ${task.taskRef ?? task.id}` : `task ${task.taskRef ?? task.id}: ${clipped}`
}

/**
 * 任务收敛前的提交步骤（11 §14.5 / 17 §8.5）。
 *
 * 执行器只改工作区、不碰 git；而合并闸门要求任务分支干净（`merge.ts`），
 * 所以 worker 在进入 `succeeded` 前把工作区改动提交到 `wfxm/<ref>`。
 * 干净工作区不产生空提交；非 worktree 任务直接跳过。
 */
export async function commitWorktreeChanges(
  task: Task,
  options: CommitWorktreeOptions = {},
): Promise<CommitWorktreeResult> {
  if (task.isolation !== 'worktree' || task.worktreePath === null || task.branch === null) {
    return { committed: false, commit: null }
  }
  const cwd = task.worktreePath
  if (!existsSync(cwd)) {
    throw commitFailure(`isolation: worktree ${cwd} is missing; cannot commit the task branch`)
  }
  const run = options.run ?? realRun
  const gitTimeoutMs = options.gitTimeoutMs ?? DEFAULT_GIT_TIMEOUT_MS
  const git = (args: string[]): Promise<CommandResult> =>
    run('git', ['-C', cwd, ...args], { cwd, timeoutMs: gitTimeoutMs })

  const status = await git(['status', '--porcelain'])
  if (status.code !== 0) {
    throw commitFailure(`isolation: git status failed: ${status.stderr.trim() || `exit ${status.code}`}`)
  }
  if (status.stdout.trim() === '') return { committed: false, commit: null }

  const added = await git(['add', '-A'])
  if (added.code !== 0) {
    throw commitFailure(`isolation: git add failed: ${added.stderr.trim() || `exit ${added.code}`}`)
  }
  const committed = await git([
    '-c',
    'user.name=dsh-wfxm',
    '-c',
    'user.email=dsh-wfxm@localhost',
    'commit',
    '-q',
    '-m',
    commitSubject(task),
  ])
  if (committed.code !== 0) {
    throw commitFailure(`isolation: git commit failed: ${committed.stderr.trim() || `exit ${committed.code}`}`)
  }
  const head = await git(['rev-parse', 'HEAD'])
  const commit = head.code === 0 ? head.stdout.trim() : null
  options.logger?.info?.(
    `[isolation] ${task.taskRef ?? task.id}: committed ${commit === null ? '?' : commit.slice(0, 12)}`,
  )
  return { committed: true, commit }
}

function isUnder(root: string, target: string): boolean {
  const path = resolve(target)
  return path === root || path.startsWith(root + sep)
}

/**
 * A deliverable that lives under the executor's shared workspace (切片 AH).
 *
 * dsh's `workspace-write` sandbox root is the child's cwd (`sandbox-policy`
 * pins `workspaceRoot` to `process.cwd()`), so a task whose `file_exists`
 * target is the shared workspace must run there — in a git worktree the target
 * would sit outside the sandbox and the write would be denied. Running in the
 * shared workspace keeps the boundary at exactly that root; it is not the same
 * as `danger-full-access`.
 */
function sharedWriteTarget(assertions: readonly TaskAssertion[], root: string): string | null {
  for (const assertion of assertions) {
    if (assertion.kind !== 'file_exists') continue
    const target = assertion.spec.path
    if (typeof target !== 'string' || !isAbsolute(target)) continue
    const resolved = resolve(target)
    if (isUnder(root, resolved)) return resolved
  }
  return null
}

export function createIsolationResolver(
  options: IsolationResolverOptions,
): (task: Task, project: IsolationProject | null, fallback: string) => Promise<string> {
  const { tasks } = options
  const run = options.run ?? realRun
  const gitTimeoutMs = options.gitTimeoutMs ?? DEFAULT_GIT_TIMEOUT_MS
  const prepareTimeoutMs = options.prepareTimeoutMs ?? DEFAULT_PREPARE_TIMEOUT_MS
  const now = options.now ?? (() => new Date())

  async function git(root: string, args: string[]): Promise<CommandResult> {
    return run('git', ['-C', root, ...args], { cwd: root, timeoutMs: gitTimeoutMs })
  }

  /**
   * Returns the cwd for one attempt. Throws on any isolation failure so the
   * executor reports a loud failure instead of silently using the shared root.
   */
  async function resolveWorkdir(task: Task, project: IsolationProject | null, fallback: string): Promise<string> {
    if (project === null) return fallback
    const root = resolve(project.rootPath)

    // 切片 AH: a deliverable in the shared workspace runs there, never in a
    // worktree — see `sharedWriteTarget`. Checked before worktree reuse so a
    // retry of such a task also lands in the sandbox's writable root.
    const sharedRoot = resolve(fallback)
    const sharedTarget = sharedWriteTarget(tasks.listAssertions(task.id), sharedRoot)
    if (sharedTarget !== null) {
      return serial(task, sharedRoot, `deliverable ${sharedTarget} is in the shared workspace`)
    }

    if (task.worktreePath !== null) {
      if (task.prepareState === 'failed') {
        throw new Error(`isolation: worktree ${task.worktreePath} has a failed prepare; not retrying`)
      }
      if (task.prepareState === 'running') {
        tasks.setIsolation(task.id, { prepareState: 'failed' })
        throw new Error('isolation: prepare was interrupted; task needs a new attempt')
      }
      if (!existsSync(task.worktreePath)) {
        throw new Error(`isolation: worktree ${task.worktreePath} is missing; not recreating`)
      }
      return task.worktreePath
    }

    if (project.vcs !== 'git') {
      return serial(task, root, 'project vcs is not git')
    }
    const inside = await git(root, ['rev-parse', '--is-inside-work-tree'])
    const top = await git(root, ['rev-parse', '--show-toplevel'])
    if (inside.code !== 0 || inside.stdout.trim() !== 'true' || top.code !== 0) {
      return serial(task, root, 'not a git checkout')
    }
    if (resolve(top.stdout.trim()) !== root) {
      return serial(task, root, 'project root is not the repository root')
    }
    const status = await git(root, ['status', '--porcelain', '--untracked-files=no'])
    if (status.code !== 0 || status.stdout.trim() !== '') {
      return serial(task, root, 'worktree is not clean')
    }
    const head = await git(root, ['rev-parse', 'HEAD'])
    const baseCommit = head.stdout.trim()
    if (head.code !== 0 || baseCommit === '') {
      return serial(task, root, 'cannot resolve HEAD')
    }

    const ref = task.taskRef ?? task.id
    const branch = `wfxm/${ref}`
    const worktreePath = resolve(
      project.worktreeRoot === null || project.worktreeRoot === ''
        ? join(root, '.agents', 'worktrees', ref)
        : join(project.worktreeRoot, ref),
    )
    if (!isUnder(root, worktreePath)) {
      throw new Error(`isolation: worktree path ${worktreePath} escapes project root ${root}`)
    }
    if (existsSync(worktreePath)) {
      throw new Error(`isolation: worktree path ${worktreePath} already exists without a task record`)
    }

    const created = await git(root, ['worktree', 'add', '-b', branch, worktreePath, baseCommit])
    if (created.code !== 0) {
      throw new Error(`isolation: git worktree add failed: ${created.stderr.trim() || `exit ${created.code}`}`)
    }
    const hasPrepare = project.prepareCmd !== null && project.prepareCmd.trim() !== ''
    tasks.setIsolation(task.id, {
      isolation: 'worktree',
      worktreePath,
      baseCommit,
      branch,
      prepareState: hasPrepare ? 'running' : 'none',
    })
    options.logger?.info?.(
      `[isolation] ${task.taskRef ?? task.id}: worktree ${worktreePath} (base ${baseCommit.slice(0, 12)})`,
    )

    if (hasPrepare) {
      const prepared = await run('/bin/bash', ['-lc', project.prepareCmd as string], {
        cwd: worktreePath,
        timeoutMs: prepareTimeoutMs,
      })
      if (prepared.code !== 0) {
        tasks.setIsolation(task.id, { prepareState: 'failed' })
        throw new Error(
          `isolation: prepare failed (exit ${prepared.code}): ${prepared.stderr.trim().slice(-500)}`,
        )
      }
      tasks.setIsolation(task.id, {
        prepareState: 'done',
        preparedAt: now().toISOString(),
      })
      options.logger?.info?.(`[isolation] ${task.taskRef ?? task.id}: prepare done`)
    }

    return worktreePath
  }

  function serial(task: Task, root: string, reason: string): string {
    if (task.isolation !== 'serial') {
      tasks.setIsolation(task.id, { isolation: 'serial' })
      options.logger?.warn?.(`[isolation] ${task.taskRef ?? task.id}: serial (${reason})`)
    }
    return root
  }

  return resolveWorkdir
}
