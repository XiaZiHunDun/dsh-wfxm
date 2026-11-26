/**
 * `changes` store（⑦ 运维域，15 §模块 ⑦）。
 *
 * 单库 `ops.sqlite`，本模块是 `changes` 的唯一写者（AR33 / docs/11 §5.4）。
 * 一行代表一次任务/服务/工作区变更走到哪一步：`applying` 就是**半应用**——
 * 进程如果在这里退出，下次启动必须能发现它、决定补账还是回滚。
 *
 * 非法迁移不抛异常：返回 `{ok:false, code:'invalid-transition'}`，由调用方
 * 决定怎么记录（AR13 不静默丢弃）。
 */

import { randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import DatabaseConstructor, { type Database } from 'better-sqlite3'
import { runMigrations } from '@dsh-wfxm/sql-migrate'

const MIGRATION_MODULE = 'changes'
/** docs/15 §七: SQL files sit next to the package, outside the compiled `lib/`. */
const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')

export type ChangeKind = 'task' | 'service' | 'workspace'
export type ChangeStatus = 'applying' | 'applied' | 'verified' | 'kept' | 'failed' | 'rolled_back'
export type ChangeRollbackStatus = 'none' | 'ready' | 'done' | 'failed'
export type ChangeErrorCode = 'invalid-input' | 'not-found' | 'invalid-transition'

export interface Change {
  id: string
  taskId: string | null
  kind: ChangeKind
  target: string
  snapshotId: string | null
  status: ChangeStatus
  rollbackStatus: ChangeRollbackStatus
  detail: string | null
  createdAt: string
  updatedAt: string
  closedAt: string | null
}

export interface BeginChangeInput {
  taskId: string
  kind?: ChangeKind
  target?: string
  snapshotId?: string | null
  detail?: string | null
  now?: Date
}

export type ChangeResult =
  | { ok: true; change: Change }
  | { ok: false; code: ChangeErrorCode }

export interface ChangeStore {
  /** 按 `task_id` 幂等：已有行原样返回，不覆盖、不重复建。 */
  begin(input: BeginChangeInput): ChangeResult
  markApplied(taskId: string, detail?: string | null, now?: Date): ChangeResult
  markVerified(taskId: string, detail?: string | null, now?: Date): ChangeResult
  keep(taskId: string, detail?: string | null, now?: Date): ChangeResult
  markFailed(taskId: string, detail?: string | null, now?: Date): ChangeResult
  /** `applying|failed` → `rollback_status='ready'`；条件更新，只成功一次。 */
  claimRollback(taskId: string, now?: Date): boolean
  markRolledBack(taskId: string, detail?: string | null, now?: Date): ChangeResult
  markRollbackFailed(taskId: string, detail?: string | null, now?: Date): ChangeResult
  get(id: string): Change | null
  getByTask(taskId: string): Change | null
  /** 半应用：仍在 `applying`，或已被 claim 但没回滚完的行。 */
  listHalfApplied(limit?: number): Change[]
  listRecent(limit?: number): Change[]
  close(): void
}

interface ChangeRow {
  id: string
  task_id: string | null
  kind: ChangeKind
  target: string
  snapshot_id: string | null
  status: ChangeStatus
  rollback_status: ChangeRollbackStatus
  detail: string | null
  created_at: string
  updated_at: string
  closed_at: string | null
}

function toChange(row: ChangeRow): Change {
  return {
    id: row.id,
    taskId: row.task_id,
    kind: row.kind,
    target: row.target,
    snapshotId: row.snapshot_id,
    status: row.status,
    rollbackStatus: row.rollback_status,
    detail: row.detail,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
  }
}

function migrate(db: Database): void {
  runMigrations(db, { module: MIGRATION_MODULE, dir: MIGRATIONS_DIR })
}

const KINDS: readonly ChangeKind[] = ['task', 'service', 'workspace']

export function createChangeStore(dbPath: string): ChangeStore {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true })
  const db = new DatabaseConstructor(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000')
  migrate(db)

  const insert = db.prepare(`
    INSERT INTO changes(
      id, task_id, kind, target, snapshot_id, status, rollback_status,
      detail, created_at, updated_at, closed_at
    ) VALUES (?, ?, ?, ?, ?, 'applying', 'none', ?, ?, ?, NULL)
  `)
  const selectById = db.prepare('SELECT * FROM changes WHERE id = ?')
  const selectByTask = db.prepare('SELECT * FROM changes WHERE task_id = ?')
  const halfApplied = db.prepare(`
    SELECT * FROM changes
     WHERE status IN ('applying','failed')
       AND rollback_status IN ('none','ready')
     ORDER BY created_at ASC, rowid ASC
     LIMIT ?
  `)
  const recent = db.prepare(`
    SELECT * FROM changes
     ORDER BY created_at DESC, rowid DESC
     LIMIT ?
  `)

  /**
   * 单条条件更新：`WHERE` 同时锁住起点状态，迁移非法时 changes 为 0。
   * 起点集合是有限枚举，按集合缓存 statement，避免依赖 JSON1 扩展。
   */
  const updates = new Map<string, ReturnType<Database['prepare']>>()
  function updateFor(from: readonly ChangeStatus[]) {
    const key = from.join(',')
    let statement = updates.get(key)
    if (statement === undefined) {
      statement = db.prepare(`
        UPDATE changes
           SET status = @status,
               rollback_status = @rollbackStatus,
               detail = COALESCE(@detail, detail),
               updated_at = @now,
               closed_at = @closedAt
         WHERE task_id = @taskId
           AND status IN (${from.map((_, index) => `@s${index}`).join(',')})
      `)
      updates.set(key, statement)
    }
    return { statement, from }
  }
  const claim = db.prepare(`
    UPDATE changes
       SET rollback_status = 'ready', updated_at = ?
     WHERE task_id = ?
       AND status IN ('applying','failed')
       AND rollback_status = 'none'
  `)
  const rollbackFailed = db.prepare(`
    UPDATE changes
       SET rollback_status = 'failed',
           detail = COALESCE(?, detail),
           updated_at = ?
     WHERE task_id = ? AND rollback_status = 'ready'
  `)
  /** 回滚完成必须先 claim：`rollback_status='ready'` 是唯一入口。 */
  const rollbackDone = db.prepare(`
    UPDATE changes
       SET status = 'rolled_back',
           rollback_status = 'done',
           detail = COALESCE(?, detail),
           updated_at = ?,
           closed_at = ?
     WHERE task_id = ?
       AND status IN ('applying','failed')
       AND rollback_status = 'ready'
  `)

  function result(taskId: string, changed: number): ChangeResult {
    if (changed === 0) {
      const existing = selectByTask.get(taskId) as ChangeRow | undefined
      return { ok: false, code: existing === undefined ? 'not-found' : 'invalid-transition' }
    }
    const row = selectByTask.get(taskId) as ChangeRow | undefined
    return row === undefined ? { ok: false, code: 'not-found' } : { ok: true, change: toChange(row) }
  }

  function transition(
    taskId: string,
    from: readonly ChangeStatus[],
    to: ChangeStatus,
    input: { detail?: string | null; now?: Date; rollbackStatus?: ChangeRollbackStatus; close?: boolean },
  ): ChangeResult {
    const now = (input.now ?? new Date()).toISOString()
    const { statement, from: statuses } = updateFor(from)
    const bindings: Record<string, unknown> = {
      taskId,
      status: to,
      rollbackStatus: input.rollbackStatus ?? 'none',
      detail: input.detail ?? null,
      now,
      closedAt: input.close === true ? now : null,
    }
    statuses.forEach((status, index) => {
      bindings[`s${index}`] = status
    })
    const changed = statement.run(bindings).changes
    return result(taskId, changed)
  }

  return {
    begin(input) {
      const taskId = input.taskId?.trim()
      if (typeof taskId !== 'string' || taskId === '') {
        return { ok: false, code: 'invalid-input' }
      }
      const kind = input.kind ?? 'task'
      if (!KINDS.includes(kind)) return { ok: false, code: 'invalid-input' }
      const target = (input.target ?? taskId).trim()
      if (target === '') return { ok: false, code: 'invalid-input' }

      const existing = selectByTask.get(taskId) as ChangeRow | undefined
      if (existing !== undefined) return { ok: true, change: toChange(existing) }

      const now = (input.now ?? new Date()).toISOString()
      const id = `chg_${randomBytes(8).toString('hex')}`
      insert.run(
        id,
        taskId,
        kind,
        target,
        input.snapshotId ?? null,
        input.detail ?? null,
        now,
        now,
      )
      return { ok: true, change: toChange(selectById.get(id) as ChangeRow) }
    },

    markApplied(taskId, detail = null, now = new Date()) {
      return transition(taskId, ['applying'], 'applied', { detail, now })
    },

    markVerified(taskId, detail = null, now = new Date()) {
      return transition(taskId, ['applied'], 'verified', { detail, now })
    },

    // `applying` 也允许：启动恢复发现任务其实已成功时直接补账（docs/11 §5.4）。
    keep(taskId, detail = null, now = new Date()) {
      return transition(taskId, ['applying', 'applied', 'verified'], 'kept', {
        detail,
        now,
        close: true,
      })
    },

    markFailed(taskId, detail = null, now = new Date()) {
      return transition(taskId, ['applying'], 'failed', { detail, now })
    },

    claimRollback(taskId, now = new Date()) {
      return claim.run(now.toISOString(), taskId).changes === 1
    },

    markRolledBack(taskId, detail = null, now = new Date()) {
      const at = now.toISOString()
      const changed = rollbackDone.run(detail, at, at, taskId).changes
      if (changed === 0) {
        const existing = selectByTask.get(taskId) as ChangeRow | undefined
        return { ok: false, code: existing === undefined ? 'not-found' : 'invalid-transition' }
      }
      return { ok: true, change: toChange(selectByTask.get(taskId) as ChangeRow) }
    },

    markRollbackFailed(taskId, detail = null, now = new Date()) {
      const changed = rollbackFailed.run(detail, now.toISOString(), taskId).changes
      if (changed === 0) {
        const existing = selectByTask.get(taskId) as ChangeRow | undefined
        return { ok: false, code: existing === undefined ? 'not-found' : 'invalid-transition' }
      }
      return { ok: true, change: toChange(selectByTask.get(taskId) as ChangeRow) }
    },

    get(id) {
      const row = selectById.get(id) as ChangeRow | undefined
      return row === undefined ? null : toChange(row)
    },

    getByTask(taskId) {
      const row = selectByTask.get(taskId) as ChangeRow | undefined
      return row === undefined ? null : toChange(row)
    },

    listHalfApplied(limit = 50) {
      return (halfApplied.all(Math.max(1, limit)) as ChangeRow[]).map(toChange)
    },

    listRecent(limit = 50) {
      return (recent.all(Math.max(1, limit)) as ChangeRow[]).map(toChange)
    },

    close() {
      db.close()
    },
  }
}
