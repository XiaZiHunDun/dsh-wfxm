/**
 * `reminders` store（J5）。
 *
 * 单库 `ops.sqlite`，本模块是提醒的唯一写者（AR33）。一条提醒只落在**创建它的
 * 线程**（11 §SchedPort：定时不得投递到非原会话），host 的 pump 负责到点入队。
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import DatabaseConstructor, { type Database } from 'better-sqlite3'
import { nextDueAt, type ReminderRepeat } from './time.js'

const MIGRATION_MODULE = 'reminder'
const MIGRATION_VERSION = 1

const MIGRATIONS_DDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  module      TEXT NOT NULL,
  version     INTEGER NOT NULL,
  applied_at  TEXT NOT NULL,
  PRIMARY KEY (module)
);
`

const REMINDERS_DDL = `
CREATE TABLE IF NOT EXISTS reminders (
  id            TEXT PRIMARY KEY,
  thread_id     TEXT NOT NULL,
  text          TEXT NOT NULL,
  due_at        TEXT NOT NULL,
  repeat        TEXT NOT NULL CHECK (repeat IN ('none','daily','weekly')),
  status        TEXT NOT NULL CHECK (status IN ('pending','done','cancelled')),
  source_msg_id TEXT,
  created_at    TEXT NOT NULL,
  fired_at      TEXT
);
CREATE INDEX IF NOT EXISTS ix_reminders_due ON reminders(status, due_at);
CREATE INDEX IF NOT EXISTS ix_reminders_thread ON reminders(thread_id, status, due_at);
`

export type ReminderStatus = 'pending' | 'done' | 'cancelled'

export interface Reminder {
  id: string
  threadId: string
  text: string
  /** UTC ISO 字符串。 */
  dueAt: string
  repeat: ReminderRepeat
  status: ReminderStatus
  sourceMsgId: string | null
  createdAt: string
  firedAt: string | null
}

export interface CreateReminderInput {
  threadId: string
  text: string
  /** `Date` 或可解析的 ISO 字符串；不能是过去时间（由调用方保证业务上限）。 */
  dueAt: string | Date
  repeat?: ReminderRepeat
  sourceMsgId?: string | null
  now?: Date
}

export interface MarkReminderFiredInput {
  /** 周期提醒的下一次时间；一次性传 `null`/省略即结束。 */
  nextDueAt?: string | null
  now?: Date
}

export interface ReminderStore {
  create(input: CreateReminderInput): Reminder
  get(id: string): Reminder | null
  /** 某线程按时间升序的待触发提醒（列表/取序号用）。 */
  listPending(threadId: string, limit?: number): Reminder[]
  /** 全部到期未触发的提醒（pump 用）。 */
  listDue(now: Date, limit?: number): Reminder[]
  /** 记录一次触发：一次性转 `done`，周期转下一次 `pending`。 */
  markFired(id: string, input?: MarkReminderFiredInput): Reminder | null
  /** 只能取消 `pending`；不存在或已结束返回 `null`。 */
  cancel(id: string): Reminder | null
  close(): void
}

/** 参数/状态错误统一抛出，调用方据此给出可见反馈而不是静默失败。 */
export class ReminderError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReminderError'
  }
}

interface ReminderRow {
  id: string
  thread_id: string
  text: string
  due_at: string
  repeat: ReminderRepeat
  status: ReminderStatus
  source_msg_id: string | null
  created_at: string
  fired_at: string | null
}

function toReminder(row: ReminderRow): Reminder {
  return {
    id: row.id,
    threadId: row.thread_id,
    text: row.text,
    dueAt: row.due_at,
    repeat: row.repeat,
    status: row.status,
    sourceMsgId: row.source_msg_id,
    createdAt: row.created_at,
    firedAt: row.fired_at,
  }
}

function migrate(db: Database): void {
  db.exec(MIGRATIONS_DDL)
  const row = db
    .prepare('SELECT MAX(version) AS version FROM schema_migrations WHERE module = ?')
    .get(MIGRATION_MODULE) as { version: number | null } | undefined
  if ((row?.version ?? 0) >= MIGRATION_VERSION) return

  db.transaction(() => {
    db.exec(REMINDERS_DDL)
    // `schema_migrations` 被同一 `ops.sqlite` 的多个模块共用，主键形状可能是
    // `(module)` 或 `(module, version)`；DELETE + INSERT 不依赖 ON CONFLICT 目标。
    db.prepare('DELETE FROM schema_migrations WHERE module = ?').run(MIGRATION_MODULE)
    db.prepare('INSERT INTO schema_migrations(module, version, applied_at) VALUES (?, ?, ?)').run(
      MIGRATION_MODULE,
      MIGRATION_VERSION,
      new Date().toISOString(),
    )
  }).immediate()
}

function requiredText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') throw new ReminderError(`${field} must be a string`)
  const trimmed = value.trim()
  if (trimmed === '') throw new ReminderError(`${field} must not be empty`)
  if (trimmed.length > max) throw new ReminderError(`${field} exceeds ${max} characters`)
  return trimmed
}

export function createReminderStore(dbPath: string): ReminderStore {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true })
  const db = new DatabaseConstructor(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000')
  migrate(db)

  const insert = db.prepare(`
    INSERT INTO reminders(
      id, thread_id, text, due_at, repeat, status, source_msg_id, created_at, fired_at
    ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, NULL)
  `)
  const select = db.prepare('SELECT * FROM reminders WHERE id = ?')
  const listPending = db.prepare(`
    SELECT * FROM reminders
     WHERE thread_id = ? AND status = 'pending'
     ORDER BY due_at ASC, created_at ASC
     LIMIT ?
  `)
  const listDue = db.prepare(`
    SELECT * FROM reminders
     WHERE status = 'pending' AND due_at <= ?
     ORDER BY due_at ASC, created_at ASC
     LIMIT ?
  `)
  const finish = db.prepare(`
    UPDATE reminders
       SET status = 'done', fired_at = ?
     WHERE id = ? AND status = 'pending'
  `)
  const advance = db.prepare(`
    UPDATE reminders
       SET due_at = ?, fired_at = ?
     WHERE id = ? AND status = 'pending'
  `)
  const cancelStmt = db.prepare(`
    UPDATE reminders SET status = 'cancelled'
     WHERE id = ? AND status = 'pending'
  `)

  return {
    create(input) {
      const threadId = requiredText(input.threadId, 'threadId', 200)
      const text = requiredText(input.text, 'text', 200)
      const repeat = input.repeat ?? 'none'
      if (repeat !== 'none' && repeat !== 'daily' && repeat !== 'weekly') {
        throw new ReminderError(`repeat must be none|daily|weekly, got ${String(repeat)}`)
      }
      const due = input.dueAt instanceof Date ? input.dueAt : new Date(input.dueAt)
      if (Number.isNaN(due.getTime())) throw new ReminderError('dueAt is not a valid date')

      const now = input.now ?? new Date()
      const row: ReminderRow = {
        id: randomUUID(),
        thread_id: threadId,
        text,
        due_at: due.toISOString(),
        repeat,
        status: 'pending',
        source_msg_id: input.sourceMsgId ?? null,
        created_at: now.toISOString(),
        fired_at: null,
      }
      insert.run(
        row.id,
        row.thread_id,
        row.text,
        row.due_at,
        row.repeat,
        row.source_msg_id,
        row.created_at,
      )
      return toReminder(row)
    },

    get(id) {
      const row = select.get(id) as ReminderRow | undefined
      return row === undefined ? null : toReminder(row)
    },

    listPending(threadId, limit = 10) {
      const rows = listPending.all(threadId, Math.max(1, limit)) as ReminderRow[]
      return rows.map(toReminder)
    },

    listDue(now, limit = 50) {
      const rows = listDue.all(now.toISOString(), Math.max(1, limit)) as ReminderRow[]
      return rows.map(toReminder)
    },

    markFired(id, input = {}) {
      const now = input.now ?? new Date()
      const next = input.nextDueAt ?? null
      const changed = next === null
        ? finish.run(now.toISOString(), id).changes
        : advance.run(next, now.toISOString(), id).changes
      if (changed === 0) return null
      const row = select.get(id) as ReminderRow | undefined
      return row === undefined ? null : toReminder(row)
    },

    cancel(id) {
      const changed = cancelStmt.run(id).changes
      if (changed === 0) return null
      const row = select.get(id) as ReminderRow | undefined
      return row === undefined ? null : toReminder(row)
    },

    close() {
      db.close()
    },
  }
}

export { nextDueAt }
