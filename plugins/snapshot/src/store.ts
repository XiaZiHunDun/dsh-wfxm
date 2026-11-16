/**
 * Snapshot ledger (module ⑦, 15 §九 快照).
 *
 * Two tables, both owned by ⑦:
 *   - `snapshots`      工作区级检查点（粒度二）——locator 必须自包含，baseline 只作校验
 *   - `file_preimages` 文件级前镜像（粒度一）——(tool_call_id, path) 幂等，`absent` 墓碑
 *
 * Only ⑦ writes here; ④/⑤ go through ports (AR33). A row is metadata: the bytes
 * live in the locator (dir: / restic:) or inline in `content_ref`.
 */

import { randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import DatabaseConstructor, { type Database } from 'better-sqlite3'

export type SnapshotErrorCode =
  | 'invalid-input'
  | 'not-found'
  | 'conflict'
  | 'concurrent-mutation'
  | 'snapshot-timeout'
  | 'io-error'
  | 'not-supported'

export class SnapshotError extends Error {
  readonly code: SnapshotErrorCode

  constructor(code: SnapshotErrorCode, message: string) {
    super(message)
    this.name = 'SnapshotError'
    this.code = code
  }
}

export type SnapshotKind = 'workspace' | 'task'

export interface SnapshotRecord {
  id: string
  kind: SnapshotKind
  /** Self-contained restore target: `dir:<abs>` or `restic:<snapshot>:<subpath>`. */
  locator: string
  /** Baseline only (`git:` / `manifest:`); never a restore mechanism. */
  baselineRef: string | null
  excludes: string[]
  contentKey: string | null
  refCount: number
  sizeBytes: number | null
  createdAt: string
  expiresAt: string | null
}

export interface PreimageRecord {
  id: string
  taskId: string | null
  toolCallId: string
  /** realpath: symlink / relative paths are normalised before recording. */
  path: string
  state: 'present' | 'absent'
  contentRef: string | null
  sha256: string | null
  sizeBytes: number | null
  checkpointId: string | null
  createdAt: string
  expiresAt: string | null
}

export interface SnapshotFilter {
  kind?: SnapshotKind
}

export interface PreimageFilter {
  taskId?: string
  /** Step boundary (⑤ `beginCheckpoint`), stamped by ④'s hook. */
  checkpointId?: string
}

export interface CreateSnapshotInput {
  kind?: SnapshotKind
  locator: string
  baselineRef?: string | null
  excludes?: string[]
  contentKey?: string | null
  sizeBytes?: number | null
  createdAt?: Date
  expiresAt?: Date | null
}

export interface AddPreimageInput {
  taskId?: string | null
  toolCallId: string
  path: string
  state: 'present' | 'absent'
  contentRef?: string | null
  sha256?: string | null
  sizeBytes?: number | null
  checkpointId?: string | null
  createdAt?: Date
  expiresAt?: Date | null
}

export interface SnapshotStore {
  readonly db: Database
  createSnapshot(input: CreateSnapshotInput): SnapshotRecord
  getSnapshot(id: string): SnapshotRecord | null
  listSnapshots(filter?: SnapshotFilter): SnapshotRecord[]
  /** Drop one reference; the row is kept (and synchronously deletable at 0). */
  releaseSnapshot(id: string): SnapshotRecord | null
  /** Keep the newest `keep` rows per kind; returns the ids to delete on disk. */
  pruneSnapshots(options?: { keep?: number; kind?: SnapshotKind }): string[]
  addPreimage(input: AddPreimageInput): PreimageRecord
  getPreimage(toolCallId: string, path: string): PreimageRecord | null
  listPreimages(filter?: PreimageFilter): PreimageRecord[]
  deletePreimage(id: string): void
  close(): void
}

export const DEFAULT_SNAPSHOT_KEEP = 100
export const PREIMAGE_INLINE_LIMIT = 1024 * 1024

const SNAPSHOTS_DDL = `
CREATE TABLE IF NOT EXISTS snapshots (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('workspace','task')),
  locator      TEXT NOT NULL,
  baseline_ref TEXT,
  excludes_json TEXT NOT NULL DEFAULT '[]',
  content_key  TEXT,
  ref_count    INTEGER NOT NULL DEFAULT 0,
  size_bytes   INTEGER,
  created_at   TEXT NOT NULL,
  expires_at   TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_snapshots_content ON snapshots(content_key) WHERE content_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_snapshots_kind ON snapshots(kind, created_at);

CREATE TABLE IF NOT EXISTS file_preimages (
  id            TEXT PRIMARY KEY,
  task_id       TEXT,
  tool_call_id  TEXT NOT NULL,
  path          TEXT NOT NULL,
  state         TEXT NOT NULL CHECK (state IN ('present','absent')),
  content_ref   TEXT,
  sha256        TEXT,
  size_bytes    INTEGER,
  checkpoint_id TEXT,
  created_at    TEXT NOT NULL,
  expires_at    TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_file_preimages_call ON file_preimages(tool_call_id, path);
CREATE INDEX IF NOT EXISTS ix_file_preimages_task ON file_preimages(task_id, created_at);
`

const MIGRATIONS: readonly { version: number; ddl: string }[] = [
  { version: 1, ddl: SNAPSHOTS_DDL },
]

interface SnapshotRow {
  id: string
  kind: string
  locator: string
  baseline_ref: string | null
  excludes_json: string
  content_key: string | null
  ref_count: number
  size_bytes: number | null
  created_at: string
  expires_at: string | null
}

interface PreimageRow {
  id: string
  task_id: string | null
  tool_call_id: string
  path: string
  state: string
  content_ref: string | null
  sha256: string | null
  size_bytes: number | null
  checkpoint_id: string | null
  created_at: string
  expires_at: string | null
}

export function createSnapshotStore(dbPath: string): SnapshotStore {
  if (!dbPath) throw new SnapshotError('invalid-input', 'a database path is required')
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new DatabaseConstructor(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  migrate(db)

  const insertSnapshot = db.prepare(`
    INSERT INTO snapshots(id, kind, locator, baseline_ref, excludes_json, content_key,
                          ref_count, size_bytes, created_at, expires_at)
    VALUES (@id, @kind, @locator, @baselineRef, @excludesJson, @contentKey,
            @refCount, @sizeBytes, @createdAt, @expiresAt)
  `)
  const selectSnapshot = db.prepare('SELECT * FROM snapshots WHERE id = ?')
  const selectByContent = db.prepare('SELECT * FROM snapshots WHERE content_key = ?')
  const selectSnapshots = db.prepare(`
    SELECT * FROM snapshots
     WHERE (@kind IS NULL OR kind = @kind)
     ORDER BY created_at DESC, rowid DESC
  `)
  const touchRef = db.prepare('UPDATE snapshots SET ref_count = ref_count + 1 WHERE id = ?')
  const dropRef = db.prepare('UPDATE snapshots SET ref_count = MAX(ref_count - 1, 0) WHERE id = ?')
  const deleteSnapshot = db.prepare('DELETE FROM snapshots WHERE id = ?')

  const insertPreimage = db.prepare(`
    INSERT INTO file_preimages(id, task_id, tool_call_id, path, state, content_ref,
                               sha256, size_bytes, checkpoint_id, created_at, expires_at)
    VALUES (@id, @taskId, @toolCallId, @path, @state, @contentRef,
            @sha256, @sizeBytes, @checkpointId, @createdAt, @expiresAt)
  `)
  const selectPreimage = db.prepare(
    'SELECT * FROM file_preimages WHERE tool_call_id = ? AND path = ?',
  )
  const selectPreimages = db.prepare(`
    SELECT * FROM file_preimages
     WHERE (@taskId IS NULL OR task_id = @taskId)
       AND (@checkpointId IS NULL OR checkpoint_id = @checkpointId)
     ORDER BY created_at ASC, rowid ASC
  `)
  const deletePreimageStmt = db.prepare('DELETE FROM file_preimages WHERE id = ?')

  const store: SnapshotStore = {
    db,

    createSnapshot(input) {
      assertLocator(input.locator)
      const contentKey = input.contentKey ?? null
      if (contentKey !== null) {
        const existing = selectByContent.get(contentKey) as SnapshotRow | undefined
        if (existing !== undefined) {
          touchRef.run(existing.id)
          return toSnapshot(selectSnapshot.get(existing.id) as SnapshotRow)
        }
      }
      const id = `snap_${randomBytes(8).toString('hex')}`
      const createdAt = (input.createdAt ?? new Date()).toISOString()
      insertSnapshot.run({
        id,
        kind: input.kind ?? 'workspace',
        locator: input.locator,
        baselineRef: input.baselineRef ?? null,
        excludesJson: JSON.stringify(input.excludes ?? []),
        contentKey,
        refCount: 0,
        sizeBytes: input.sizeBytes ?? null,
        createdAt,
        expiresAt: input.expiresAt === undefined || input.expiresAt === null
          ? null
          : input.expiresAt.toISOString(),
      })
      return toSnapshot(selectSnapshot.get(id) as SnapshotRow)
    },

    getSnapshot(id) {
      const row = selectSnapshot.get(id) as SnapshotRow | undefined
      return row === undefined ? null : toSnapshot(row)
    },

    listSnapshots(filter = {}) {
      return (selectSnapshots.all({ kind: filter.kind ?? null }) as SnapshotRow[]).map(toSnapshot)
    },

    releaseSnapshot(id) {
      const row = selectSnapshot.get(id) as SnapshotRow | undefined
      if (row === undefined) return null
      dropRef.run(id)
      return toSnapshot(selectSnapshot.get(id) as SnapshotRow)
    },

    pruneSnapshots(options = {}) {
      const keep = options.keep ?? DEFAULT_SNAPSHOT_KEEP
      if (!Number.isInteger(keep) || keep < 0) {
        throw new SnapshotError('invalid-input', 'keep must be a non-negative integer')
      }
      const rows = selectSnapshots.all({ kind: options.kind ?? null }) as SnapshotRow[]
      const doomed = rows.slice(keep)
      const remove = db.transaction((ids: string[]) => {
        for (const id of ids) deleteSnapshot.run(id)
      })
      remove(doomed.map((row) => row.id))
      return doomed.map((row) => row.id)
    },

    addPreimage(input) {
      if (!input.toolCallId) throw new SnapshotError('invalid-input', 'toolCallId is required')
      if (!input.path) throw new SnapshotError('invalid-input', 'path is required')
      if (input.state !== 'present' && input.state !== 'absent') {
        throw new SnapshotError('invalid-input', 'state must be present or absent')
      }
      const existing = selectPreimage.get(input.toolCallId, input.path) as PreimageRow | undefined
      if (existing !== undefined) return toPreimage(existing)
      const id = `pre_${randomBytes(8).toString('hex')}`
      insertPreimage.run({
        id,
        taskId: input.taskId ?? null,
        toolCallId: input.toolCallId,
        path: input.path,
        state: input.state,
        contentRef: input.contentRef ?? null,
        sha256: input.sha256 ?? null,
        sizeBytes: input.sizeBytes ?? null,
        checkpointId: input.checkpointId ?? null,
        createdAt: (input.createdAt ?? new Date()).toISOString(),
        expiresAt: input.expiresAt === undefined || input.expiresAt === null
          ? null
          : input.expiresAt.toISOString(),
      })
      return toPreimage(selectPreimage.get(input.toolCallId, input.path) as PreimageRow)
    },

    getPreimage(toolCallId, path) {
      const row = selectPreimage.get(toolCallId, path) as PreimageRow | undefined
      return row === undefined ? null : toPreimage(row)
    },

    listPreimages(filter = {}) {
      return (selectPreimages.all({
        taskId: filter.taskId ?? null,
        checkpointId: filter.checkpointId ?? null,
      }) as PreimageRow[]).map(toPreimage)
    },

    deletePreimage(id) {
      deletePreimageStmt.run(id)
    },

    close() {
      db.close()
    },
  }
  return store
}

function migrate(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      module     TEXT NOT NULL,
      version    INTEGER NOT NULL,
      applied_at TEXT NOT NULL,
      PRIMARY KEY (module, version)
    );
  `)
  const applied = new Set(
    (db.prepare("SELECT version FROM schema_migrations WHERE module = 'snapshot'").all() as {
      version: number
    }[]).map((row) => row.version),
  )
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue
    db.transaction(() => {
      db.exec(migration.ddl)
      db.prepare(
        "INSERT INTO schema_migrations(module, version, applied_at) VALUES ('snapshot', ?, ?)",
      ).run(migration.version, new Date().toISOString())
    })()
  }
}

/** 13 §3.4: a snapshot without a self-contained locator cannot restore anything. */
function assertLocator(locator: string): void {
  if (typeof locator !== 'string' || locator.trim() === '') {
    throw new SnapshotError('invalid-input', 'locator is required')
  }
  if (!/^(dir|restic):/.test(locator)) {
    throw new SnapshotError(
      'invalid-input',
      `locator must be self-contained (dir: or restic:), got ${JSON.stringify(locator)}`,
    )
  }
}

function toSnapshot(row: SnapshotRow): SnapshotRecord {
  return {
    id: row.id,
    kind: row.kind === 'task' ? 'task' : 'workspace',
    locator: row.locator,
    baselineRef: row.baseline_ref ?? null,
    excludes: parseExcludes(row.excludes_json),
    contentKey: row.content_key ?? null,
    refCount: row.ref_count,
    sizeBytes: row.size_bytes ?? null,
    createdAt: row.created_at,
    expiresAt: row.expires_at ?? null,
  }
}

function toPreimage(row: PreimageRow): PreimageRecord {
  return {
    id: row.id,
    taskId: row.task_id ?? null,
    toolCallId: row.tool_call_id,
    path: row.path,
    state: row.state === 'absent' ? 'absent' : 'present',
    contentRef: row.content_ref ?? null,
    sha256: row.sha256 ?? null,
    sizeBytes: row.size_bytes ?? null,
    checkpointId: row.checkpoint_id ?? null,
    createdAt: row.created_at,
    expiresAt: row.expires_at ?? null,
  }
}

function parseExcludes(json: string): string[] {
  try {
    const value: unknown = JSON.parse(json)
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}
