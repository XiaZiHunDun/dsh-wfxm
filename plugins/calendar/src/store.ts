/**
 * 日程本地存储（J4 / Slice BP）。
 *
 * 日程正本在服务器：单库 `ops.sqlite` 的 `calendar_events` 表，本模块是唯一写者。
 * 飞书只是对话渠道，**不调用**飞书日历 API，也不需要任何日历 scope。
 *
 * 时间统一存 epoch 毫秒（写入前已校验为带偏移的 ISO8601），展示按
 * `Asia/Shanghai`；表里另存原始 ISO，便于排障与外部对账。
 */

import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import DatabaseConstructor, { type Database } from 'better-sqlite3'

const MIGRATION_MODULE = 'calendar'
const MIGRATION_VERSION = 2

const MIGRATIONS_DDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  module     TEXT NOT NULL,
  version    INTEGER NOT NULL,
  applied_at TEXT NOT NULL,
  PRIMARY KEY (module)
);
`

/** v2：会前提醒只发一次，用 `reminded_at` 做库级去重。 */
const CALENDAR_V2_DDL = 'ALTER TABLE calendar_events ADD COLUMN reminded_at TEXT'

const CALENDAR_DDL = `
CREATE TABLE IF NOT EXISTS calendar_events (
  id          TEXT PRIMARY KEY,
  summary     TEXT NOT NULL,
  description TEXT,
  start_at    TEXT NOT NULL,
  end_at      TEXT NOT NULL,
  start_ms    INTEGER NOT NULL,
  end_ms      INTEGER NOT NULL,
  location    TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_calendar_events_start ON calendar_events(start_ms);
`

export interface StoredCalendarEvent {
  eventId: string
  summary: string
  description: string
  startAt: string
  endAt: string
  startMs: number
  endMs: number
  location: string
  createdAt: string
  updatedAt: string
  remindedAt: string | null
}

export interface CalendarEventWrite {
  summary: string
  start: string
  end: string
  description?: string
  location?: string
}

export interface CalendarEventPatch {
  summary?: string
  start?: string
  end?: string
  description?: string
  location?: string
}

export interface CalendarStore {
  listEvents(range: { startMs: number; endMs: number }): StoredCalendarEvent[]
  /** 即将开始且尚未提醒的事件（`start_ms` 在 (now, now+lead] 内）。 */
  listStartingSoon(options: { nowMs: number; leadMs: number }): StoredCalendarEvent[]
  getEvent(eventId: string): StoredCalendarEvent | null
  createEvent(input: CalendarEventWrite): StoredCalendarEvent
  updateEvent(eventId: string, input: CalendarEventPatch): StoredCalendarEvent | null
  /** 标记已提醒；已提醒过或未知 id 返回 false。 */
  markReminded(eventId: string, at?: string): boolean
  close(): void
}

interface Row {
  id: string
  summary: string
  description: string | null
  start_at: string
  end_at: string
  start_ms: number
  end_ms: number
  location: string | null
  created_at: string
  updated_at: string
  reminded_at: string | null
}

function toEvent(row: Row): StoredCalendarEvent {
  return {
    eventId: row.id,
    summary: row.summary,
    description: row.description ?? '',
    startAt: row.start_at,
    endAt: row.end_at,
    startMs: row.start_ms,
    endMs: row.end_ms,
    location: row.location ?? '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    remindedAt: row.reminded_at,
  }
}

/** 默认库路径与宿主一致：`DSH_WFXM_DB` → `<DSH_WFXM_DATA_DIR>/ops.sqlite`。 */
export function defaultCalendarDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.DSH_WFXM_DB?.trim()
  if (explicit !== undefined && explicit !== '') return explicit
  const dataDir = env.DSH_WFXM_DATA_DIR?.trim()
  return join(dataDir === undefined || dataDir === '' ? '/var/lib/dsh-wfxm' : dataDir, 'ops.sqlite')
}

function migrate(db: Database): void {
  db.exec(MIGRATIONS_DDL)
  const row = db
    .prepare('SELECT MAX(version) AS version FROM schema_migrations WHERE module = ?')
    .get(MIGRATION_MODULE) as { version: number | null } | undefined
  const version = row?.version ?? 0
  if (version >= MIGRATION_VERSION) return

  db.transaction(() => {
    if (version < 1) db.exec(CALENDAR_DDL)
    if (version < 2) db.exec(CALENDAR_V2_DDL)
    db.prepare('DELETE FROM schema_migrations WHERE module = ?').run(MIGRATION_MODULE)
    db.prepare('INSERT INTO schema_migrations (module, version, applied_at) VALUES (?, ?, ?)')
      .run(MIGRATION_MODULE, MIGRATION_VERSION, new Date().toISOString())
  })()
}

function newEventId(): string {
  return `evt_${randomBytes(10).toString('hex')}`
}

export function createCalendarStore(dbPath: string = defaultCalendarDbPath()): CalendarStore {
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new DatabaseConstructor(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  migrate(db)

  const selectById = db.prepare('SELECT * FROM calendar_events WHERE id = ?')
  const insert = db.prepare(`
    INSERT INTO calendar_events
      (id, summary, description, start_at, end_at, start_ms, end_ms, location, created_at, updated_at)
    VALUES
      (@id, @summary, @description, @startAt, @endAt, @startMs, @endMs, @location, @createdAt, @updatedAt)
  `)

  return {
    listEvents(range) {
      const rows = db.prepare(`
        SELECT * FROM calendar_events
        WHERE start_ms < ? AND end_ms > ?
        ORDER BY start_ms ASC, created_at ASC
      `).all(range.endMs, range.startMs) as Row[]
      return rows.map(toEvent)
    },

    listStartingSoon({ nowMs, leadMs }) {
      const rows = db.prepare(`
        SELECT * FROM calendar_events
        WHERE reminded_at IS NULL AND start_ms > ? AND start_ms <= ?
        ORDER BY start_ms ASC, created_at ASC
      `).all(nowMs, nowMs + leadMs) as Row[]
      return rows.map(toEvent)
    },

    getEvent(eventId) {
      const row = selectById.get(eventId) as Row | undefined
      return row === undefined ? null : toEvent(row)
    },

    createEvent(input) {
      const now = new Date().toISOString()
      const event: Row = {
        id: newEventId(),
        summary: input.summary,
        description: input.description ?? null,
        start_at: input.start,
        end_at: input.end,
        start_ms: Date.parse(input.start),
        end_ms: Date.parse(input.end),
        location: input.location ?? null,
        created_at: now,
        updated_at: now,
        reminded_at: null,
      }
      insert.run({
        id: event.id,
        summary: event.summary,
        description: event.description,
        startAt: event.start_at,
        endAt: event.end_at,
        startMs: event.start_ms,
        endMs: event.end_ms,
        location: event.location,
        createdAt: event.created_at,
        updatedAt: event.updated_at,
      })
      return toEvent(event)
    },

    updateEvent(eventId, input) {
      const current = selectById.get(eventId) as Row | undefined
      if (current === undefined) return null
      const startAt = input.start ?? current.start_at
      const endAt = input.end ?? current.end_at
      const rescheduled = input.start !== undefined || input.end !== undefined
      const updated: Row = {
        ...current,
        summary: input.summary ?? current.summary,
        description: input.description ?? current.description,
        start_at: startAt,
        end_at: endAt,
        start_ms: Date.parse(startAt),
        end_ms: Date.parse(endAt),
        location: input.location ?? current.location,
        updated_at: new Date().toISOString(),
        // 改期后允许重新提醒；只改标题/地点不重置。
        reminded_at: rescheduled ? null : current.reminded_at,
      }
      db.prepare(`
        UPDATE calendar_events
        SET summary = ?, description = ?, start_at = ?, end_at = ?,
            start_ms = ?, end_ms = ?, location = ?, updated_at = ?, reminded_at = ?
        WHERE id = ?
      `).run(
        updated.summary,
        updated.description,
        updated.start_at,
        updated.end_at,
        updated.start_ms,
        updated.end_ms,
        updated.location,
        updated.updated_at,
        updated.reminded_at,
        eventId,
      )
      return toEvent(updated)
    },

    markReminded(eventId, at) {
      const stamp = at ?? new Date().toISOString()
      const result = db.prepare(
        'UPDATE calendar_events SET reminded_at = ? WHERE id = ? AND reminded_at IS NULL',
      ).run(stamp, eventId)
      return result.changes > 0
    },

    close() {
      db.close()
    },
  }
}
