import DatabaseConstructor, { type Database } from 'better-sqlite3'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runMigrations } from '@dsh-wfxm/sql-migrate'
import { uuidv7 } from '../audit/store.js'

const MIGRATION_MODULE = 'approval'
/** docs/15 §七: SQL files sit next to the package, outside the compiled `lib/`. */
const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations', 'approval')
const DEFAULT_TTL_MS = 10 * 60 * 1000

export type ApprovalLevel = 'R2' | 'R3'
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'withdrawn'
/**
 * `confirmed` is the second click of an R3 approval (Slice L); it is never the
 * first one, and R2 rejects it. Both `approved` and `confirmed` settle to
 * `approved` in the record.
 */
export type ApprovalDecision = 'approved' | 'rejected' | 'confirmed'

export interface CreateApprovalInput {
  correlationId: string
  level: ApprovalLevel
  summary: string
  impact: Record<string, unknown>
  taskId?: string
  channelId?: string
  externalMsgId?: string
  ttlMs?: number
}

export interface ApprovalTicket {
  id: string
  nonce: string
  requestedAt: string
  expiresAt: string
}

export interface ApprovalRecord {
  id: string
  taskId: string | null
  correlationId: string
  level: ApprovalLevel
  summary: string
  impact: Record<string, unknown>
  status: ApprovalStatus
  requestedAt: string
  expiresAt: string
  decidedAt: string | null
  decidedBy: string | null
  channelId: string | null
  externalMsgId: string | null
  nonceConsumedAt: string | null
  /** 0 = untouched; 1 = the first R3 "approve" click was recorded (Slice L). */
  confirmStage: number
  confirmActor: string | null
  confirmAt: string | null
}

export interface AnswerApprovalInput {
  approvalId: string
  decision: ApprovalDecision
  actorId: string
  nonce: string
}

export type AnswerCode =
  | 'ok'
  | 'not-found'
  | 'not-pending'
  | 'expired'
  | 'nonce-invalid'
  | 'actor-invalid'
  /** R3's first "approve" click: recorded, not decided; ask again explicitly. */
  | 'confirm-required'
  /** The `confirmed` click does not match a recorded first click (or R2). */
  | 'confirm-invalid'

export interface AnswerResult {
  ok: boolean
  code: AnswerCode
  approvalId: string
  status?: ApprovalStatus
  /** Echoed on `confirm-required` so the host can render the second card. */
  stage?: number
  /**
   * Present only on `confirm-required`: the still-unconsumed nonce, so the
   * confirmation card carries the same single-use token (no new bypass path).
   */
  nonce?: string
}

export interface ApprovalStoreOptions {
  now?: () => Date
  nonce?: () => string
}

/**
 * A pending approval that ran past `expires_at`. Without a sweep the row stays
 * `pending` forever and the task it gates never leaves `waiting_approval`, which
 * keeps the thread occupied (any new message is absorbed as supplementary input).
 */
export interface ExpiredApproval {
  approvalId: string
  taskId: string | null
}

export interface ApprovalStore {
  create(input: CreateApprovalInput): ApprovalTicket
  answer(input: AnswerApprovalInput): AnswerResult
  withdraw(approvalId: string): AnswerResult
  /**
   * Sweep pending approvals whose TTL has passed. Returns the rows this call
   * expired so the caller can settle the gated task; already-expired rows are
   * not returned twice.
   */
  expireOverdue(at?: Date): ExpiredApproval[]
  get(approvalId: string): ApprovalRecord | null
  /**
   * Record the id of the card the channel rendered for this approval (docs/14 §六).
   * The card is only a view; this column lets the transport patch it later.
   * Idempotent: re-setting the same or a new id returns true; unknown id → false.
   */
  setExternalMsgId(approvalId: string, externalMsgId: string): boolean
  close(): void
}

interface ApprovalRow {
  id: string
  task_id: string | null
  correlation_id: string
  level: ApprovalLevel
  summary: string
  impact_json: string
  status: ApprovalStatus
  requested_at: string
  expires_at: string
  decided_at: string | null
  decided_by: string | null
  channel_id: string | null
  external_msg_id: string | null
  nonce: string
  nonce_consumed_at: string | null
  confirm_stage: number
  confirm_actor: string | null
  confirm_at: string | null
}

function migrate(db: Database): void {
  runMigrations(db, { module: MIGRATION_MODULE, dir: MIGRATIONS_DIR })
}

function nonceMatches(expected: string, actual: string): boolean {
  const left = Buffer.from(expected, 'utf8')
  const right = Buffer.from(actual, 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

function toRecord(row: ApprovalRow): ApprovalRecord {
  let impact: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(row.impact_json)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) impact = parsed
  } catch {
    // Keep the malformed payload out of the record; it stays visible in the row.
  }
  return {
    id: row.id,
    taskId: row.task_id,
    correlationId: row.correlation_id,
    level: row.level,
    summary: row.summary,
    impact,
    status: row.status,
    requestedAt: row.requested_at,
    expiresAt: row.expires_at,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
    channelId: row.channel_id,
    externalMsgId: row.external_msg_id,
    nonceConsumedAt: row.nonce_consumed_at,
    confirmStage: row.confirm_stage ?? 0,
    confirmActor: row.confirm_actor,
    confirmAt: row.confirm_at,
  }
}

export function createApprovalStore(dbPath: string, options: ApprovalStoreOptions = {}): ApprovalStore {
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new DatabaseConstructor(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000')
  migrate(db)

  const now = options.now ?? (() => new Date())
  const makeNonce = options.nonce ?? (() => randomBytes(32).toString('hex'))

  const insert = db.prepare(`
    INSERT INTO approvals
      (id, task_id, correlation_id, level, summary, impact_json, status,
       requested_at, expires_at, channel_id, external_msg_id, nonce)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)
  `)
  const select = db.prepare('SELECT * FROM approvals WHERE id = ?')
  const expire = db.prepare(`
    UPDATE approvals SET status = 'expired'
    WHERE id = ? AND status = 'pending'
  `)
  const decide = db.prepare(`
    UPDATE approvals
       SET status = ?, decided_at = ?, decided_by = ?, nonce_consumed_at = ?
     WHERE id = ? AND status = 'pending' AND nonce_consumed_at IS NULL
  `)
  const withdraw = db.prepare(`
    UPDATE approvals SET status = 'withdrawn', decided_at = ?
     WHERE id = ? AND status = 'pending'
  `)
  const setCard = db.prepare('UPDATE approvals SET external_msg_id = ? WHERE id = ?')
  const markConfirm = db.prepare(`
    UPDATE approvals SET confirm_stage = 1, confirm_actor = ?, confirm_at = ?
     WHERE id = ? AND status = 'pending' AND confirm_stage = 0
  `)
  const selectOverdue = db.prepare(`
    SELECT id, task_id FROM approvals
     WHERE status = 'pending' AND expires_at <= ?
     ORDER BY expires_at
  `)

  const answerTransaction = db.transaction((input: AnswerApprovalInput): AnswerResult => {
    const row = select.get(input.approvalId) as ApprovalRow | undefined
    if (!row) return { ok: false, code: 'not-found', approvalId: input.approvalId }
    if (row.status !== 'pending') {
      return { ok: false, code: 'not-pending', approvalId: input.approvalId, status: row.status }
    }
    const at = now()
    if (at.toISOString() >= row.expires_at) {
      expire.run(row.id)
      return { ok: false, code: 'expired', approvalId: row.id, status: 'expired' }
    }
    if (typeof input.actorId !== 'string' || input.actorId.trim().length === 0) {
      return { ok: false, code: 'actor-invalid', approvalId: row.id, status: row.status }
    }
    if (typeof input.nonce !== 'string' || !nonceMatches(row.nonce, input.nonce)) {
      return { ok: false, code: 'nonce-invalid', approvalId: row.id, status: row.status }
    }

    // Slice L: R3 is a two-step decision. The first `approved` click only records
    // who asked, and the record stays pending with the same nonce; settling needs
    // the dedicated `confirmed` click that only the confirmation card carries.
    if (input.decision === 'confirmed') {
      if (row.level !== 'R3' || (row.confirm_stage ?? 0) < 1) {
        return { ok: false, code: 'confirm-invalid', approvalId: row.id, status: row.status }
      }
      if (row.confirm_actor !== null && row.confirm_actor !== input.actorId) {
        return { ok: false, code: 'confirm-invalid', approvalId: row.id, status: row.status }
      }
    } else if (input.decision === 'approved' && row.level === 'R3') {
      if ((row.confirm_stage ?? 0) < 1) {
        markConfirm.run(input.actorId, at.toISOString(), row.id)
      }
      return {
        ok: false,
        code: 'confirm-required',
        approvalId: row.id,
        status: 'pending',
        stage: 1,
        nonce: row.nonce,
      }
    }

    const settled: ApprovalStatus = input.decision === 'rejected' ? 'rejected' : 'approved'
    const changed = decide.run(
      settled,
      at.toISOString(),
      input.actorId,
      at.toISOString(),
      row.id,
    )
    if (changed.changes !== 1) {
      return { ok: false, code: 'not-pending', approvalId: row.id }
    }
    return { ok: true, code: 'ok', approvalId: row.id, status: settled }
  })

  const withdrawTransaction = db.transaction((approvalId: string): AnswerResult => {
    const row = select.get(approvalId) as ApprovalRow | undefined
    if (!row) return { ok: false, code: 'not-found', approvalId }
    if (row.status !== 'pending') {
      return { ok: false, code: 'not-pending', approvalId, status: row.status }
    }
    const changed = withdraw.run(now().toISOString(), approvalId)
    if (changed.changes !== 1) return { ok: false, code: 'not-pending', approvalId }
    return { ok: true, code: 'ok', approvalId, status: 'withdrawn' }
  })

  const expireOverdueTransaction = db.transaction((at: Date): ExpiredApproval[] => {
    const iso = at.toISOString()
    const rows = selectOverdue.all(iso) as Array<{ id: string; task_id: string | null }>
    const expired: ExpiredApproval[] = []
    for (const row of rows) {
      // `expire` is guarded on `status = 'pending'`, so a racing answer wins and
      // this row is simply not reported as expired.
      if (expire.run(row.id).changes !== 1) continue
      expired.push({ approvalId: row.id, taskId: row.task_id })
    }
    return expired
  })

  return {
    create: (input) => {
      const at = now()
      const expiresAt = new Date(
        at.getTime() + (input.ttlMs ?? DEFAULT_TTL_MS),
      ).toISOString()
      const ticket: ApprovalTicket = {
        id: uuidv7(),
        nonce: makeNonce(),
        requestedAt: at.toISOString(),
        expiresAt,
      }
      insert.run(
        ticket.id,
        input.taskId ?? null,
        input.correlationId,
        input.level,
        input.summary,
        JSON.stringify(input.impact ?? {}),
        ticket.requestedAt,
        ticket.expiresAt,
        input.channelId ?? null,
        input.externalMsgId ?? null,
        ticket.nonce,
      )
      return ticket
    },
    answer: (input) => answerTransaction(input),
    withdraw: (approvalId) => withdrawTransaction(approvalId),
    expireOverdue: (at) => expireOverdueTransaction(at ?? now()),
    get: (approvalId) => {
      const row = select.get(approvalId) as ApprovalRow | undefined
      return row ? toRecord(row) : null
    },
    setExternalMsgId: (approvalId, externalMsgId) => {
      if (typeof externalMsgId !== 'string' || externalMsgId.length === 0) return false
      return setCard.run(externalMsgId, approvalId).changes === 1
    },
    close: () => db.close(),
  }
}
