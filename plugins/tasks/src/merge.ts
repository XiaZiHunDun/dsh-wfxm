/**
 * B4-b merge / release / prune (11 §14.4 / 15 §10.5–10.7, Phase 2).
 *
 * Merging is a **post-terminal** step: `succeeded` only means the task branch
 * is ready. This module owns `merge_state` and never rewrites task status; a
 * conflict is carried by `merge_state='conflict'` plus a `task.merge` event
 * (owner decision 2026-11-12), so terminal tasks stay terminal.
 *
 * Only ⑤ writes these columns. The caller supplies the project shape it read
 * through ⑥'s port, exactly like the isolation resolver.
 */

import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { join, resolve, sep } from 'node:path'
import type { Task } from './model.js'
import { TaskError } from './model.js'
import type { CommandResult, CommandRunner } from './isolation.js'
import { realRun } from './isolation.js'
import type { TaskStore } from './store.js'
import { noteTelemetry, type TaskTelemetryPort } from './telemetry.js'

export const DEFAULT_MERGE_TIMEOUT_MS = 60_000
export const DEFAULT_LOCK_TIMEOUT_MS = 30_000
export const DEFAULT_LOCK_STALE_MS = 10 * 60_000
export const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60_000
/** Merge holds `git:<repoRoot>` long enough for any single git operation. */
const GIT_LOCK_TTL_SEC = 600
const GIT_LOCK_RETRY_MS = 100

/** Structural view of ⑥'s project row; ⑤ never imports the knowledge module. */
export interface MergeProject {
  id: string
  name: string
  rootPath: string
  vcs: 'git' | 'none'
  mergeMode: 'manual' | 'pr'
}

export interface IsolationServiceOptions {
  tasks: TaskStore
  /** Defaults to a real child process; tests inject a deterministic runner. */
  run?: CommandRunner
  gitTimeoutMs?: number
  lockTimeoutMs?: number
  retentionMs?: number
  now?: () => Date
  logger?: { info?(message: string): void; warn?(message: string): void } | null
  /** P6-1: merge spans; absent means no telemetry. */
  telemetry?: TaskTelemetryPort | null
}

export interface MergeOptions {
  /** Defaults to the branch currently checked out in the project root. */
  targetBranch?: string
  /** Remove the worktree (default true) after a successful merge. */
  cleanup?: boolean
}

export interface MergeResult {
  task: Task
  state: 'merged' | 'conflict'
  targetBranch: string
  commit: string | null
  conflictPaths: string[]
  worktreeRemoved: boolean
  branchDeleted: boolean
}

export type ReleaseReason = 'merged' | 'abandoned' | 'failed'

export interface ReleaseOptions {
  /** Defaults to true; only a merged release deletes the branch. */
  deleteBranch?: boolean
}

export interface ReleaseResult {
  task: Task
  alreadyReleased: boolean
  removedWorktree: boolean
  deletedBranch: boolean
}

export interface PruneOptions {
  olderThanMs?: number
  dryRun?: boolean
}

export interface PruneResult {
  scanned: number
  candidates: Task[]
  removed: string[]
  failed: string[]
}

export interface IsolationStatus {
  taskId: string
  mode: Task['isolation']
  prepareState: Task['prepareState']
  mergeState: Task['mergeState']
  worktreePath: string | null
  branch: string | null
  worktreeExists: boolean
}

export interface IsolationService {
  merge(taskId: string, project: MergeProject, options?: MergeOptions): Promise<MergeResult>
  release(taskId: string, reason: ReleaseReason, project: MergeProject, options?: ReleaseOptions): Promise<ReleaseResult>
  prune(project: MergeProject, options?: PruneOptions): Promise<PruneResult>
  status(taskId: string): IsolationStatus
}

function delay(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms))
}

function isUnder(root: string, target: string): boolean {
  const path = resolve(target)
  return path === root || path.startsWith(root + sep)
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as { code?: unknown }).code !== 'ESRCH'
  }
}

export function createIsolationService(options: IsolationServiceOptions): IsolationService {
  const { tasks } = options
  const run = options.run ?? realRun
  const gitTimeoutMs = options.gitTimeoutMs ?? DEFAULT_MERGE_TIMEOUT_MS
  const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS
  const retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS
  const now = options.now ?? (() => new Date())
  const telemetry = options.telemetry ?? null

  /** In-process queue per repository; the lock file covers other processes. */
  const queues = new Map<string, Promise<unknown>>()

  function git(cwd: string, args: string[]): Promise<CommandResult> {
    return run('git', ['-C', cwd, ...args], { cwd, timeoutMs: gitTimeoutMs })
  }

  function requireTask(taskId: string): Task {
    const task = tasks.getTask(taskId)
    if (task === null) throw new TaskError('not-found', `task ${taskId} not found`)
    return task
  }

  function requireWorktree(task: Task): void {
    if (
      task.isolation !== 'worktree'
      || task.worktreePath === null
      || task.baseCommit === null
      || task.branch === null
    ) {
      throw new TaskError(
        'invalid-task',
        `task ${task.taskRef ?? task.id} is not a worktree task with worktreePath/baseCommit/branch`,
      )
    }
  }

  async function repositoryRoot(project: MergeProject): Promise<string> {
    if (project.vcs !== 'git') {
      throw new TaskError('invalid-input', `project ${project.name} is not a git repository`)
    }
    const root = resolve(project.rootPath)
    const top = await git(root, ['rev-parse', '--show-toplevel'])
    if (top.code !== 0 || resolve(top.stdout.trim()) !== root) {
      throw new TaskError('invalid-input', `project root ${root} is not the repository root`)
    }
    return root
  }

  async function lockDirectory(root: string): Promise<string> {
    const out = await git(root, ['rev-parse', '--git-common-dir'])
    if (out.code !== 0 || out.stdout.trim() === '') {
      throw new TaskError('invalid-input', `cannot resolve the git directory of ${root}`)
    }
    return resolve(root, out.stdout.trim())
  }

  function lockIsStale(file: string): boolean {
    let ageMs = Number.POSITIVE_INFINITY
    try {
      ageMs = Date.now() - statSync(file).mtimeMs
    } catch {
      return true
    }
    let pid: number | null = null
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { pid?: unknown }
      if (typeof parsed.pid === 'number' && Number.isInteger(parsed.pid)) pid = parsed.pid
    } catch {
      // A truncated lock is only stale once it is old; until then it is busy.
    }
    if (pid !== null && !pidAlive(pid)) return true
    return ageMs > DEFAULT_LOCK_STALE_MS
  }

  async function acquireLock(dir: string): Promise<string> {
    const file = join(dir, 'wfxm-merge.lock')
    const deadline = Date.now() + lockTimeoutMs
    for (;;) {
      try {
        const fd = openSync(file, 'wx', 0o600)
        try {
          writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }))
        } finally {
          closeSync(fd)
        }
        return file
      } catch (error) {
        if ((error as { code?: unknown }).code !== 'EEXIST') throw error
        if (lockIsStale(file)) {
          try {
            unlinkSync(file)
          } catch {
            // Another process may have removed it first; retry.
          }
          continue
        }
        if (Date.now() >= deadline) {
          throw new TaskError('conflict', 'another merge is already running for this repository')
        }
        await delay(100)
      }
    }
  }

  function releaseLock(file: string): void {
    try {
      unlinkSync(file)
    } catch (error) {
      options.logger?.warn?.(`[merge] could not remove ${file}: ${String(error)}`)
    }
  }

  async function withRepoLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
    const previous = queues.get(dir) ?? Promise.resolve()
    let open!: () => void
    const gate = new Promise<void>((done) => {
      open = done
    })
    const tail = previous.then(() => gate)
    queues.set(dir, tail)
    await previous
    try {
      const file = await acquireLock(dir)
      try {
        return await fn()
      } finally {
        releaseLock(file)
      }
    } finally {
      open()
      if (queues.get(dir) === tail) queues.delete(dir)
    }
  }

  /**
   * Cross-process merge serialisation (15 §10.7). The lock file still protects
   * the git directory, but `git:<repoRoot>` makes the same repository visible as
   * a leased resource and survives stale-lock inspection across processes.
   */
  async function withGitResourceLock<T>(taskId: string, root: string, fn: () => Promise<T>): Promise<T> {
    const key = `git:${root}`
    const deadline = Date.now() + lockTimeoutMs
    let lockIds: string[] = []
    while (lockIds.length === 0) {
      const result = tasks.acquireResourceLocks({
        taskId,
        keys: [key],
        ttlSec: GIT_LOCK_TTL_SEC,
        owner: 'merge',
      })
      if (result.acquired.length > 0) {
        lockIds = result.acquired.map((lock) => lock.id)
        break
      }
      if (Date.now() >= deadline) {
        const holder = result.conflicts[0]
        throw new TaskError(
          'conflict',
          `repository ${root} is being merged by ${holder === undefined ? 'another task' : `task ${holder.taskId}`}`,
        )
      }
      await new Promise<void>((done) => {
        setTimeout(done, GIT_LOCK_RETRY_MS)
      })
    }
    try {
      return await fn()
    } finally {
      tasks.releaseResourceLocks(lockIds)
    }
  }

  async function removeWorktree(task: Task, root: string): Promise<boolean> {
    if (task.worktreePath === null) return true
    if (!isUnder(root, task.worktreePath)) {
      throw new TaskError('invalid-task', `worktree ${task.worktreePath} escapes project root ${root}`)
    }
    const existed = existsSync(task.worktreePath)
    if (existed) {
      const removed = await git(root, ['worktree', 'remove', '--force', task.worktreePath])
      if (removed.code !== 0) {
        options.logger?.warn?.(
          `[merge] worktree remove failed for ${task.taskRef ?? task.id}: ${removed.stderr.trim() || `exit ${removed.code}`}`,
        )
        return false
      }
    }
    // Clears the admin entry when the directory was already gone.
    await git(root, ['worktree', 'prune'])
    return true
  }

  async function deleteBranch(task: Task, root: string): Promise<boolean> {
    if (task.branch === null) return false
    const deleted = await git(root, ['branch', '-d', task.branch])
    if (deleted.code !== 0) {
      options.logger?.warn?.(
        `[merge] branch ${task.branch} kept: ${deleted.stderr.trim() || `exit ${deleted.code}`}`,
      )
      return false
    }
    return true
  }

  async function merge(taskId: string, project: MergeProject, opts: MergeOptions = {}): Promise<MergeResult> {
    const task = requireTask(taskId)
    requireWorktree(task)
    if (task.status !== 'succeeded') {
      throw new TaskError('invalid-task', `merge requires a succeeded task (current ${task.status})`)
    }
    if (task.mergeState !== 'none' && task.mergeState !== 'conflict') {
      throw new TaskError('invalid-task', `merge requires merge_state none or conflict (current ${task.mergeState})`)
    }
    if (project.mergeMode === 'pr') {
      throw new TaskError('invalid-input', 'project merge_mode is pr; merge is not performed locally')
    }

    const root = await repositoryRoot(project)
    const branch = task.branch as string
    const head = await git(root, ['symbolic-ref', '--short', 'HEAD'])
    if (head.code !== 0 || head.stdout.trim() === '') {
      throw new TaskError('invalid-input', 'repository is in detached HEAD; check out the target branch first')
    }
    const targetBranch = opts.targetBranch ?? head.stdout.trim()
    if (targetBranch === branch) {
      throw new TaskError('invalid-input', 'the task branch cannot be its own merge target')
    }
    const target = await git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${targetBranch}`])
    if (target.code !== 0) {
      throw new TaskError('not-found', `target branch ${targetBranch} not found`)
    }
    const exists = await git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
    if (exists.code !== 0) {
      throw new TaskError('not-found', `branch ${branch} not found; worktree branches are never recreated`)
    }

    const mainStatus = await git(root, ['status', '--porcelain', '--untracked-files=no'])
    if (mainStatus.code !== 0 || mainStatus.stdout.trim() !== '') {
      throw new TaskError('conflict', 'repository has uncommitted changes; refusing to merge')
    }
    if (existsSync(task.worktreePath as string)) {
      const worktreeStatus = await git(task.worktreePath as string, ['status', '--porcelain'])
      if (worktreeStatus.code !== 0 || worktreeStatus.stdout.trim() !== '') {
        throw new TaskError(
          'conflict',
          'worktree has uncommitted changes; commit them to the task branch before merging',
        )
      }
    }

    const startedAt = now()
    const span = `merge:${task.id}:${task.attempt}`
    const traceId = task.correlationId ?? task.id
    noteTelemetry(telemetry, {
      event: 'merge.started',
      level: 'info',
      phase: 'merge',
      traceId,
      spanId: span,
      parentSpanId: `task:${task.id}`,
      taskId: task.id,
      taskRef: task.taskRef ?? undefined,
      attempt: task.attempt,
      status: 'running',
      attrs: { merge_state: task.mergeState, branch: task.branch },
    })

    try {
      const dir = await lockDirectory(root)
      return await withRepoLock(dir, () => withGitResourceLock(taskId, root, async () => {
      // Re-read under the lock: another process may have merged meanwhile.
      const fresh = requireTask(taskId)
      if (fresh.mergeState !== 'none' && fresh.mergeState !== 'conflict') {
        throw new TaskError('invalid-task', `merge requires merge_state none or conflict (current ${fresh.mergeState})`)
      }
      const previous = fresh.mergeState
      tasks.setIsolation(taskId, { mergeState: 'pending' })

      const message = `merge ${fresh.taskRef ?? fresh.id}: ${fresh.intent.slice(0, 72)}`
      const merged = await git(root, ['merge', '--no-ff', '--no-edit', branch, '-m', message])

      if (merged.code === 0) {
        const headCommit = await git(root, ['rev-parse', 'HEAD'])
        const commit = headCommit.code === 0 ? headCommit.stdout.trim() : null
        tasks.appendEvent(taskId, 'task.merge', {
          state: 'merged',
          branch,
          targetBranch,
          commit,
        })
        let updated = tasks.setIsolation(taskId, { mergeState: 'merged' })
        let worktreeRemoved = false
        let branchDeleted = false
        if (opts.cleanup !== false) {
          worktreeRemoved = await removeWorktree(updated, root)
          branchDeleted = await deleteBranch(updated, root)
          updated = requireTask(taskId)
        }
        options.logger?.info?.(`[merge] ${fresh.taskRef ?? fresh.id}: merged into ${targetBranch}`)
        noteTelemetry(telemetry, {
          event: 'merge.succeeded',
          level: 'info',
          phase: 'merge',
          traceId,
          spanId: span,
          parentSpanId: `task:${task.id}`,
          taskId: task.id,
          taskRef: task.taskRef ?? undefined,
          attempt: task.attempt,
          status: 'merged',
          durationMs: Math.max(0, now().getTime() - startedAt.getTime()),
          attrs: { merge_state: 'merged', branch },
        })
        return {
          task: updated,
          state: 'merged' as const,
          targetBranch,
          commit,
          conflictPaths: [],
          worktreeRemoved,
          branchDeleted,
        }
      }

      const unmerged = await git(root, ['diff', '--name-only', '--diff-filter=U'])
      const conflictPaths = unmerged.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '')
      const mergeHead = await git(root, ['rev-parse', '--quiet', '--verify', 'MERGE_HEAD'])
      if (mergeHead.code === 0) {
        await git(root, ['merge', '--abort'])
      }

      if (conflictPaths.length > 0) {
        tasks.setIsolation(taskId, { mergeState: 'conflict' })
        tasks.appendEvent(taskId, 'task.merge', {
          state: 'conflict',
          branch,
          targetBranch,
          conflictPaths,
        })
        options.logger?.warn?.(
          `[merge] ${fresh.taskRef ?? fresh.id}: conflict in ${conflictPaths.length} file(s)`,
        )
        noteTelemetry(telemetry, {
          event: 'merge.conflict',
          // P6-4: a conflict is terminal for the merge, so `/diag` must surface
          // it as an error; a warn-level row was invisible to the report.
          level: 'error',
          phase: 'merge',
          traceId,
          spanId: span,
          parentSpanId: `task:${task.id}`,
          taskId: task.id,
          taskRef: task.taskRef ?? undefined,
          attempt: task.attempt,
          status: 'conflict',
          durationMs: Math.max(0, now().getTime() - startedAt.getTime()),
          error: { code: 'merge-conflict', message: `${conflictPaths.length} file(s)` },
          attrs: { merge_state: 'conflict', branch },
        })
        return {
          task: requireTask(taskId),
          state: 'conflict' as const,
          targetBranch,
          commit: null,
          conflictPaths,
          worktreeRemoved: false,
          branchDeleted: false,
        }
      }

      // Not a content conflict (dirty index, unrelated histories, …): undo the
      // pending marker so the task does not look stuck, then surface the error.
      tasks.setIsolation(taskId, { mergeState: previous })
      throw new TaskError(
        merged.code === 128 ? 'transient' : 'unknown',
        `git merge failed: ${merged.stderr.trim() || `exit ${merged.code}`}`,
      )
      }))
    } catch (error) {
      const code = typeof (error as { code?: unknown }).code === 'string'
        ? (error as { code: string }).code
        : typeof (error as { kind?: unknown }).kind === 'string'
          ? (error as { kind: string }).kind
          : 'merge-failed'
      noteTelemetry(telemetry, {
        event: 'merge.failed',
        level: 'error',
        phase: 'merge',
        traceId,
        spanId: span,
        parentSpanId: `task:${task.id}`,
        taskId: task.id,
        taskRef: task.taskRef ?? undefined,
        attempt: task.attempt,
        status: 'failed',
        durationMs: Math.max(0, now().getTime() - startedAt.getTime()),
        error: { code, message: error instanceof Error ? error.message : String(error) },
        attrs: { branch: task.branch },
      })
      throw error
    }
  }

  async function release(
    taskId: string,
    reason: ReleaseReason,
    project: MergeProject,
    opts: ReleaseOptions = {},
  ): Promise<ReleaseResult> {
    const task = requireTask(taskId)
    requireWorktree(task)
    if (reason === 'merged') {
      if (task.mergeState !== 'merged') {
        throw new TaskError('invalid-task', 'release --reason merged requires merge_state=merged')
      }
    } else if (task.status !== 'succeeded' && task.status !== 'failed' && task.status !== 'cancelled') {
      throw new TaskError('invalid-task', `release requires a terminal task (current ${task.status})`)
    }

    const root = await repositoryRoot(project)
    const existed = task.worktreePath !== null && existsSync(task.worktreePath)
    const removed = await removeWorktree(task, root)
    const branchDeleted = reason === 'merged' && opts.deleteBranch !== false
      ? await deleteBranch(task, root)
      : false

    const nextState = reason === 'merged'
      ? 'merged'
      : task.mergeState === 'merged' ? 'merged' : 'abandoned'
    const updated = nextState === task.mergeState
      ? task
      : tasks.setIsolation(taskId, { mergeState: nextState })

    return {
      task: updated,
      alreadyReleased: !existed && removed,
      removedWorktree: existed && removed,
      deletedBranch: branchDeleted,
    }
  }

  async function prune(project: MergeProject, opts: PruneOptions = {}): Promise<PruneResult> {
    const root = await repositoryRoot(project)
    const dir = await lockDirectory(root)
    const cutoff = now().getTime() - (opts.olderThanMs ?? retentionMs)
    const all = tasks.listTasks({ projectId: project.id })
    const candidates = all.filter((task) => {
      if (task.isolation !== 'worktree' || task.worktreePath === null) return false
      if (task.status !== 'succeeded' && task.status !== 'failed' && task.status !== 'cancelled') return false
      if (task.mergeState !== 'none' && task.mergeState !== 'merged') return false
      const stamp = Date.parse(task.finishedAt ?? task.createdAt)
      return Number.isFinite(stamp) && stamp <= cutoff
    })

    if (opts.dryRun === true) {
      return { scanned: all.length, candidates, removed: [], failed: [] }
    }
    if (candidates.length === 0) return { scanned: all.length, candidates, removed: [], failed: [] }

    return withRepoLock(dir, async () => {
      const removed: string[] = []
      const failed: string[] = []
      for (const task of candidates) {
        try {
          const ok = await removeWorktree(task, root)
          if (!ok) {
            failed.push(task.id)
            continue
          }
          if (task.mergeState === 'none') {
            tasks.setIsolation(task.id, { mergeState: 'abandoned' })
          }
          removed.push(task.id)
        } catch (error) {
          options.logger?.warn?.(
            `[prune] ${task.taskRef ?? task.id}: ${error instanceof Error ? error.message : String(error)}`,
          )
          failed.push(task.id)
        }
      }
      return { scanned: all.length, candidates, removed, failed }
    })
  }

  function status(taskId: string): IsolationStatus {
    const task = requireTask(taskId)
    return {
      taskId: task.id,
      mode: task.isolation,
      prepareState: task.prepareState,
      mergeState: task.mergeState,
      worktreePath: task.worktreePath,
      branch: task.branch,
      worktreeExists: task.worktreePath !== null && existsSync(task.worktreePath),
    }
  }

  return { merge, release, prune, status }
}
