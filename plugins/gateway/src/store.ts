/**
 * `inbox` / `actors` / `channel_bindings` / `session_routes` / `route_decisions`
 * / `outbox` store.
 *
 * Single writer is module ① (docs/15 §三 / §四). Nothing here knows a channel
 * protocol: delivery is an injected transport (see `port.ts` / `dispatcher.ts`).
 */

import { mkdirSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { dirname } from 'node:path'
import DatabaseConstructor, { type Database } from 'better-sqlite3'
import { guardOutboundPayload } from './outbound.js'
import { inboundText } from './text.js'
import {
  ACTOR_KINDS,
  GatewayError,
  INBOX_KINDS,
  INBOX_STATUSES,
  OUTBOX_MAX_ATTEMPTS,
  ROUTE_ACTIONS,
  SESSION_KINDS,
  outboxBackoffMs,
  uuidv7,
  type Actor,
  type ActorKind,
  type ChannelBinding,
  type InboxItem,
  type InboxKind,
  type InboxStatus,
  type Json,
  type OutboxItem,
  type OutboxStatus,
  type ProjectMatchedBy,
  type RouteAction,
  type RouteDecision,
  type SessionKind,
  type SessionRoute,
  type ThreadKind,
  type ThreadRecord,
} from './model.js'

const MIGRATION_MODULE = 'gateway'

const MIGRATIONS_DDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  module      TEXT NOT NULL,
  version     INTEGER NOT NULL,
  applied_at  TEXT NOT NULL,
  PRIMARY KEY (module)
);
`

const INBOX_DDL = `
CREATE TABLE IF NOT EXISTS inbox (
  id              TEXT PRIMARY KEY,
  channel_id      TEXT NOT NULL,
  msg_id          TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('message','card_action','control')),
  actor_id        TEXT,
  content_json    TEXT NOT NULL,
  chat_id         TEXT,
  thread_id       TEXT,
  reply_to_msg_id TEXT,
  status          TEXT NOT NULL CHECK (status IN
                    ('accepted','triaged','routed','done','failed','rejected')),
  error_code      TEXT,
  received_at     TEXT NOT NULL,
  processed_at    TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_inbox_dedup ON inbox(channel_id, msg_id);
CREATE INDEX IF NOT EXISTS ix_inbox_status ON inbox(status, received_at);
`

const ACTORS_DDL = `
CREATE TABLE IF NOT EXISTS actors (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('owner','system')),
  display_name TEXT,
  created_at   TEXT NOT NULL
);
`

const BINDINGS_DDL = `
CREATE TABLE IF NOT EXISTS channel_bindings (
  id               TEXT PRIMARY KEY,
  actor_id         TEXT NOT NULL,
  channel_id       TEXT NOT NULL,
  external_user_id TEXT NOT NULL,
  bound_at         TEXT NOT NULL,
  revoked_at       TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_binding_live
  ON channel_bindings(channel_id, external_user_id) WHERE revoked_at IS NULL;
`

const SESSION_ROUTES_DDL = `
CREATE TABLE IF NOT EXISTS session_routes (
  channel_id   TEXT NOT NULL,
  thread_id    TEXT NOT NULL,
  session_kind TEXT NOT NULL CHECK (session_kind IN ('orchestrator','chat')),
  session_id   TEXT NOT NULL,
  project_id   TEXT,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (channel_id, thread_id, session_kind)
);
`

const ROUTE_DECISIONS_DDL = `
CREATE TABLE IF NOT EXISTS route_decisions (
  id             TEXT PRIMARY KEY,
  trigger_id     TEXT NOT NULL,
  action         TEXT NOT NULL CHECK (action IN
                   ('answer','ack','ask','accept','attach','ignore','stop')),
  target_task_id TEXT,
  thread_id      TEXT,
  reason         TEXT NOT NULL,
  confidence     REAL,
  prompt_version TEXT,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_route_decisions_trigger ON route_decisions(trigger_id, created_at);
CREATE INDEX IF NOT EXISTS ix_route_decisions_action  ON route_decisions(action, created_at);
CREATE TRIGGER IF NOT EXISTS route_decisions_no_update BEFORE UPDATE ON route_decisions
  BEGIN SELECT RAISE(ABORT, 'route_decisions is append-only'); END;
CREATE TRIGGER IF NOT EXISTS route_decisions_no_delete BEFORE DELETE ON route_decisions
  BEGIN SELECT RAISE(ABORT, 'route_decisions is append-only'); END;
`

const OUTBOX_DDL = `
CREATE TABLE IF NOT EXISTS outbox (
  id               TEXT PRIMARY KEY,
  topic            TEXT NOT NULL,
  payload_json     TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('pending','sent','failed')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  next_retry_at    TEXT,
  created_at       TEXT NOT NULL,
  sent_at          TEXT,
  lease_owner      TEXT,
  lease_expires_at TEXT,
  external_msg_id  TEXT,
  last_error       TEXT,
  task_id          TEXT,
  thread_id        TEXT,
  reply_to_msg_id  TEXT
);
CREATE INDEX IF NOT EXISTS ix_outbox_pending ON outbox(status, next_retry_at);
CREATE INDEX IF NOT EXISTS ix_outbox_thread  ON outbox(thread_id, status, next_retry_at);
`

/** B1 Thread anchors (15 §9.1). */
const THREADS_DDL = `
CREATE TABLE IF NOT EXISTS threads (
  id          TEXT PRIMARY KEY,
  channel_id  TEXT NOT NULL,
  chat_id     TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('topic','root')),
  topic_id    TEXT,
  root_msg_id TEXT,
  project_id  TEXT,
  created_at  TEXT NOT NULL,
  last_msg_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_thread_key
  ON threads(channel_id, chat_id, kind, COALESCE(topic_id,''), COALESCE(root_msg_id,''));
CREATE INDEX IF NOT EXISTS ix_threads_chat ON threads(channel_id, chat_id, last_msg_at);
`

/** v3: idempotency key for producers that may retry (e.g. ⑤ receipt closure). */
const OUTBOX_DEDUPE_DDL = `
ALTER TABLE outbox ADD COLUMN dedupe_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_outbox_dedupe
  ON outbox(dedupe_key) WHERE dedupe_key IS NOT NULL;
`

interface Migration {
  version: number
  sql: string
  /** Runs before the DDL; a throw refuses the migration (and therefore startup). */
  guard?: (db: Database) => void
}

/** v4 (§9.3 step 1, expand): the channel chat id gets its own column. */
const SESSION_ROUTE_ADD_CHAT_ID_DDL = `
ALTER TABLE session_routes ADD COLUMN chat_id TEXT;
`

/** v5 (§9.3 step 2, migrate): backfill from the old `thread_id` column. */
const SESSION_ROUTE_BACKFILL_CHAT_ID_DDL = `
UPDATE session_routes SET chat_id = thread_id WHERE chat_id IS NULL;
`

/**
 * v6 (§9.3 step 3, contract): rebuild with PK `(channel_id, chat_id,
 * session_kind)` and drop `thread_id`. Refuses to run on half-migrated rows.
 */
const SESSION_ROUTE_DROP_THREAD_ID_DDL = `
CREATE TABLE session_routes_next (
  channel_id   TEXT NOT NULL,
  chat_id      TEXT NOT NULL,
  session_kind TEXT NOT NULL CHECK (session_kind IN ('orchestrator','chat')),
  session_id   TEXT NOT NULL,
  project_id   TEXT,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (channel_id, chat_id, session_kind)
);
INSERT INTO session_routes_next(channel_id, chat_id, session_kind, session_id, project_id, updated_at)
  SELECT channel_id, chat_id, session_kind, session_id, project_id, updated_at FROM session_routes;
DROP TABLE session_routes;
ALTER TABLE session_routes_next RENAME TO session_routes;
`

function assertSessionRoutesContractible(db: Database): void {
  const empty = db
    .prepare("SELECT COUNT(*) AS n FROM session_routes WHERE chat_id IS NULL OR TRIM(chat_id) = ''")
    .get() as { n: number }
  if (empty.n > 0) {
    throw new GatewayError(
      'invalid-input',
      `session_routes contract refused: ${empty.n} row(s) without chat_id`,
    )
  }
  const duplicates = db
    .prepare(`
      SELECT COUNT(*) AS n FROM (
        SELECT channel_id, chat_id, session_kind
          FROM session_routes
         GROUP BY channel_id, chat_id, session_kind
        HAVING COUNT(*) > 1
      )
    `)
    .get() as { n: number }
  if (duplicates.n > 0) {
    throw new GatewayError(
      'invalid-input',
      `session_routes contract refused: ${duplicates.n} duplicate (channel_id, chat_id, session_kind)`,
    )
  }
}

/**
 * v7 (11 §5.3.1): every routing decision records which project it resolved to
 * and how (`explicit` / `anchor` / `sticky` / `single` / `asked`), so a wrong
 * answer can be explained later without guessing.
 */
const DECISION_PROJECT_DDL = `
ALTER TABLE route_decisions ADD COLUMN project_id TEXT;
ALTER TABLE route_decisions ADD COLUMN project_matched_by TEXT;
`

/**
 * v8 (AR37): a finished task can be woken after ③ re-verifies the actor, and
 * that decision deserves its own audited action. SQLite cannot alter a CHECK
 * constraint, so the append-only table is rebuilt (triggers and indexes drop
 * with it and are recreated here).
 */
const DECISION_WAKE_ACTION_DDL = `
CREATE TABLE route_decisions_next (
  id             TEXT PRIMARY KEY,
  trigger_id     TEXT NOT NULL,
  action         TEXT NOT NULL CHECK (action IN
                   ('answer','ack','ask','accept','attach','ignore','stop','wake')),
  target_task_id TEXT,
  thread_id      TEXT,
  reason         TEXT NOT NULL,
  confidence     REAL,
  prompt_version TEXT,
  created_at     TEXT NOT NULL,
  project_id     TEXT,
  project_matched_by TEXT
);
INSERT INTO route_decisions_next(
  id, trigger_id, action, target_task_id, thread_id, reason,
  confidence, prompt_version, created_at, project_id, project_matched_by
)
SELECT id, trigger_id, action, target_task_id, thread_id, reason,
       confidence, prompt_version, created_at, project_id, project_matched_by
  FROM route_decisions;
DROP TABLE route_decisions;
ALTER TABLE route_decisions_next RENAME TO route_decisions;
CREATE INDEX IF NOT EXISTS ix_route_decisions_trigger ON route_decisions(trigger_id, created_at);
CREATE INDEX IF NOT EXISTS ix_route_decisions_action  ON route_decisions(action, created_at);
CREATE TRIGGER IF NOT EXISTS route_decisions_no_update BEFORE UPDATE ON route_decisions
  BEGIN SELECT RAISE(ABORT, 'route_decisions is append-only'); END;
CREATE TRIGGER IF NOT EXISTS route_decisions_no_delete BEFORE DELETE ON route_decisions
  BEGIN SELECT RAISE(ABORT, 'route_decisions is append-only'); END;
`

/**
 * v9 (docs/14 §四): one-time pairing codes. Only the sha256 hash of the code
 * is stored; the raw code is shown to the owner once at mint time. Codes are
 * short-lived (default 5 min) and consumed exactly once — a successful consume
 * also creates the channel binding atomically.
 */
const PAIRING_CODES_DDL = `
CREATE TABLE IF NOT EXISTS pairing_codes (
  code_hash   TEXT PRIMARY KEY,
  actor_id    TEXT NOT NULL,
  channel_id  TEXT,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  consumed_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_pairing_codes_expiry ON pairing_codes(expires_at);
`

/** Append-only list; each version runs once per database. */
const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    sql: [
      INBOX_DDL,
      ACTORS_DDL,
      BINDINGS_DDL,
      SESSION_ROUTES_DDL,
      ROUTE_DECISIONS_DDL,
      OUTBOX_DDL,
    ].join('\n'),
  },
  { version: 2, sql: THREADS_DDL },
  { version: 3, sql: OUTBOX_DEDUPE_DDL },
  { version: 4, sql: SESSION_ROUTE_ADD_CHAT_ID_DDL },
  { version: 5, sql: SESSION_ROUTE_BACKFILL_CHAT_ID_DDL },
  { version: 6, sql: SESSION_ROUTE_DROP_THREAD_ID_DDL, guard: assertSessionRoutesContractible },
  { version: 7, sql: DECISION_PROJECT_DDL },
  { version: 8, sql: DECISION_WAKE_ACTION_DDL },
  { version: 9, sql: PAIRING_CODES_DDL },
]

export interface AcceptInboundInput {
  channelId: string
  msgId: string
  kind?: InboxKind
  actorId?: string | null
  content: Json
  chatId?: string | null
  threadId?: string | null
  replyToMsgId?: string | null
}

export interface AcceptInboundResult {
  inbox: InboxItem
  /** True when `(channel_id, msg_id)` was already stored (AR28 replay). */
  duplicate: boolean
}

export interface InboxFilter {
  status?: InboxStatus
  channelId?: string
  /** Inclusive lower bound on `received_at` (ISO 8601), for windowed reads. */
  since?: string
  /** Inclusive upper bound on `received_at` (ISO 8601). */
  until?: string
  limit?: number
}

export interface ResolveThreadInput {
  channelId: string
  chatId: string
  /** Feishu topic id; presence makes the thread `topic`, otherwise `root`. */
  topicId?: string | null
  rootMsgId?: string | null
  projectId?: string | null
  now?: Date
}

export interface ThreadFilter {
  channelId?: string
  chatId?: string
  limit?: number
}

/** A live task anchor read from `v_task_anchors` (15 §9.5). */
export interface TaskAnchor {
  taskId: string
  anchorMsgId: string | null
  round: number | null
  status: string | null
  /** Added in ⑤ v4 so ① can inherit the project from a reply anchor. */
  projectId: string | null
}

export interface CreateActorInput {
  kind?: ActorKind
  displayName?: string | null
}

export interface BindChannelInput {
  actorId: string
  channelId: string
  externalUserId: string
}

export interface MintPairingCodeInput {
  actorId: string
  /** When set, the code only binds identities arriving on this channel. */
  channelId?: string | null
  /** Defaults to 5 minutes; must be within [30s, 1h]. */
  ttlMs?: number
  now?: Date
}

export interface MintedPairingCode {
  /**
   * Shown to the owner exactly once (docs/14 §四: the code goes to the audit
   * trail via the inbox row of the `/bind` message, never into any reply).
   * Only its sha256 hash is persisted.
   */
  code: string
  expiresAt: string
}

export interface ConsumePairingCodeInput {
  code: string
  channelId: string
  externalUserId: string
  now?: Date
}

export interface ConsumePairingCodeResult {
  actor: Actor
  binding: ChannelBinding
}

export interface SetSessionRouteInput {
  channelId: string
  /** Channel chat id (Feishu `chat_id`), not a Thread id (§9.3). */
  chatId: string
  sessionKind: SessionKind
  sessionId: string
  projectId?: string | null
}

export interface SessionRouteFilter {
  channelId?: string
  chatId?: string
  sessionKind?: SessionKind
}

export interface AppendRouteDecisionInput {
  triggerId: string
  action: RouteAction
  reason: string
  targetTaskId?: string | null
  threadId?: string | null
  confidence?: number | null
  promptVersion?: string | null
  projectId?: string | null
  projectMatchedBy?: ProjectMatchedBy | null
}

export interface RouteDecisionFilter {
  triggerId?: string
  threadId?: string
  action?: RouteAction
  limit?: number
}

export interface EnqueueOutboxInput {
  topic: string
  payload: Json
  taskId?: string | null
  threadId?: string | null
  replyToMsgId?: string | null
  /** Idempotency key; a repeated enqueue returns the existing row. */
  dedupeKey?: string | null
  now?: Date
}

export interface ClaimOutboxInput {
  owner: string
  leaseMs: number
  limit?: number
  now?: Date
}

export interface FailOutboxInput {
  error: string
  retryable: boolean
  now?: Date
}

export interface OutboxFilter {
  status?: OutboxStatus
  limit?: number
}

/** One turn of a thread as the model should see it (text already redacted). */
export interface ThreadHistoryEntry {
  role: 'user' | 'assistant'
  text: string
  at: string
}

export interface OutboxHealthInput {
  /** Only failures among rows created at/after this instant are counted. */
  since?: Date
  now?: Date
}

/** Read-only snapshot for patrol/log visibility (Slice Q); no delivery semantics. */
export interface OutboxHealth {
  /** Rows that gave up within the window (or ever, when `since` is omitted). */
  failed: number
  /** Rows still pending, including those waiting for their next retry. */
  pending: number
  /** Pending rows that already spent at least one attempt. */
  retrying: number
  /** Age of the oldest pending row in ms; `null` when nothing is pending. */
  oldestPendingAgeMs: number | null
}

export interface GatewayStore {
  acceptInbound(input: AcceptInboundInput): AcceptInboundResult
  findInbox(channelId: string, msgId: string): InboxItem | null
  getInbox(id: string): InboxItem | null
  listInbox(filter?: InboxFilter): InboxItem[]
  /**
   * Recent user/assistant turns of one thread, oldest first. Only inbound
   * `message` rows and delivered `say` rows count; controls, card actions and
   * other outbox topics are not conversation. Text is redacted (① boundary).
   */
  threadHistory(threadId: string, limit?: number): ThreadHistoryEntry[]
  updateInboxStatus(id: string, status: InboxStatus, errorCode?: string | null): InboxItem

  createActor(input?: CreateActorInput): Actor
  getActor(id: string): Actor | null
  bindChannel(input: BindChannelInput): ChannelBinding
  unbindChannel(input: { channelId: string; externalUserId: string }): ChannelBinding
  resolveActor(channelId: string, externalUserId: string): { actor: Actor; binding: ChannelBinding } | null
  listBindings(options?: { includeRevoked?: boolean }): ChannelBinding[]

  /** Mint a one-time pairing code for an actor (docs/14 §四). */
  mintPairingCode(input: MintPairingCodeInput): MintedPairingCode
  /**
   * Consume a pairing code: validates freshness/scope, marks it consumed and
   * creates the channel binding atomically. Throws `not-found` (unknown code),
   * `invalid-state` (expired) or `conflict` (consumed / wrong channel / the
   * identity already has a live binding).
   */
  consumePairingCode(input: ConsumePairingCodeInput): ConsumePairingCodeResult

  setSessionRoute(input: SetSessionRouteInput): SessionRoute
  /**
   * Sticky project for one chat (11 §5.3.1). Returns false when the chat has no
   * session route yet — the caller must not invent a session id.
   */
  setSessionProject(input: {
    channelId: string
    chatId: string
    sessionKind: SessionKind
    projectId: string | null
  }): boolean
  getSessionRoute(channelId: string, chatId: string, sessionKind: SessionKind): SessionRoute | null
  listSessionRoutes(filter?: SessionRouteFilter): SessionRoute[]

  appendRouteDecision(input: AppendRouteDecisionInput): RouteDecision
  listRouteDecisions(filter?: RouteDecisionFilter): RouteDecision[]

  resolveThread(input: ResolveThreadInput): ThreadRecord
  getThread(id: string): ThreadRecord | null
  listThreads(filter?: ThreadFilter): ThreadRecord[]
  /** True once ⑤ has created the `v_task_anchors` view (15 §9.5). */
  hasTaskAnchorView(): boolean
  listTaskAnchors(threadId: string): TaskAnchor[]

  enqueueOutbox(input: EnqueueOutboxInput): OutboxItem
  claimOutbox(input: ClaimOutboxInput): OutboxItem[]
  markOutboxSent(id: string, externalMsgId: string, now?: Date): OutboxItem
  markOutboxFailed(id: string, input: FailOutboxInput): OutboxItem
  requeueOutbox(id: string): OutboxItem
  getOutbox(id: string): OutboxItem | null
  /** Read-only lookup by idempotency key (Slice R: skip a duplicate before inserting). */
  findOutboxByDedupe(dedupeKey: string): OutboxItem | null
  listOutbox(filter?: OutboxFilter): OutboxItem[]
  outboxHealth(input?: OutboxHealthInput): OutboxHealth

  close(): void
}

interface InboxRow {
  id: string
  channel_id: string
  msg_id: string
  kind: InboxKind
  actor_id: string | null
  content_json: string
  chat_id: string | null
  thread_id: string | null
  reply_to_msg_id: string | null
  status: InboxStatus
  error_code: string | null
  received_at: string
  processed_at: string | null
}

interface ActorRow {
  id: string
  kind: ActorKind
  display_name: string | null
  created_at: string
}

interface BindingRow {
  id: string
  actor_id: string
  channel_id: string
  external_user_id: string
  bound_at: string
  revoked_at: string | null
}

interface SessionRouteRow {
  channel_id: string
  chat_id: string
  session_kind: SessionKind
  session_id: string
  project_id: string | null
  updated_at: string
}

interface ThreadRow {
  id: string
  channel_id: string
  chat_id: string
  kind: ThreadKind
  topic_id: string | null
  root_msg_id: string | null
  project_id: string | null
  created_at: string
  last_msg_at: string | null
}

interface DecisionRow {
  id: string
  trigger_id: string
  action: RouteAction
  target_task_id: string | null
  thread_id: string | null
  reason: string
  confidence: number | null
  prompt_version: string | null
  created_at: string
  project_id: string | null
  project_matched_by: string | null
}

interface OutboxRow {
  id: string
  topic: string
  payload_json: string
  status: OutboxStatus
  attempts: number
  next_retry_at: string | null
  created_at: string
  sent_at: string | null
  lease_owner: string | null
  lease_expires_at: string | null
  external_msg_id: string | null
  last_error: string | null
  task_id: string | null
  thread_id: string | null
  reply_to_msg_id: string | null
}

function parseJson(raw: string): Json {
  return JSON.parse(raw) as Json
}

function toInbox(row: InboxRow): InboxItem {
  return {
    id: row.id,
    channelId: row.channel_id,
    msgId: row.msg_id,
    kind: row.kind,
    actorId: row.actor_id,
    content: parseJson(row.content_json),
    chatId: row.chat_id,
    threadId: row.thread_id,
    replyToMsgId: row.reply_to_msg_id,
    status: row.status,
    errorCode: row.error_code,
    receivedAt: row.received_at,
    processedAt: row.processed_at,
  }
}

function toActor(row: ActorRow): Actor {
  return {
    id: row.id,
    kind: row.kind,
    displayName: row.display_name,
    createdAt: row.created_at,
  }
}

function toBinding(row: BindingRow): ChannelBinding {
  return {
    id: row.id,
    actorId: row.actor_id,
    channelId: row.channel_id,
    externalUserId: row.external_user_id,
    boundAt: row.bound_at,
    revokedAt: row.revoked_at,
  }
}

function toSessionRoute(row: SessionRouteRow): SessionRoute {
  return {
    channelId: row.channel_id,
    chatId: row.chat_id,
    sessionKind: row.session_kind,
    sessionId: row.session_id,
    projectId: row.project_id,
    updatedAt: row.updated_at,
  }
}

function toThread(row: ThreadRow): ThreadRecord {
  return {
    id: row.id,
    channelId: row.channel_id,
    chatId: row.chat_id,
    kind: row.kind,
    topicId: row.topic_id,
    rootMsgId: row.root_msg_id,
    projectId: row.project_id,
    createdAt: row.created_at,
    lastMsgAt: row.last_msg_at,
  }
}

function toDecision(row: DecisionRow): RouteDecision {
  return {
    id: row.id,
    triggerId: row.trigger_id,
    action: row.action,
    targetTaskId: row.target_task_id,
    threadId: row.thread_id,
    reason: row.reason,
    confidence: row.confidence,
    promptVersion: row.prompt_version,
    createdAt: row.created_at,
    projectId: row.project_id ?? null,
    projectMatchedBy: (row.project_matched_by ?? null) as RouteDecision['projectMatchedBy'],
  }
}

function toOutbox(row: OutboxRow): OutboxItem {
  return {
    id: row.id,
    topic: row.topic,
    payload: parseJson(row.payload_json),
    status: row.status,
    attempts: row.attempts,
    nextRetryAt: row.next_retry_at,
    createdAt: row.created_at,
    sentAt: row.sent_at,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    externalMsgId: row.external_msg_id,
    lastError: row.last_error,
    taskId: row.task_id,
    threadId: row.thread_id,
    replyToMsgId: row.reply_to_msg_id,
  }
}

function migrate(db: Database): void {
  db.exec(MIGRATIONS_DDL)
  const row = db
    .prepare('SELECT MAX(version) AS version FROM schema_migrations WHERE module = ?')
    .get(MIGRATION_MODULE) as { version: number | null } | undefined
  let current = row?.version ?? 0

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue
    db.transaction(() => {
      migration.guard?.(db)
      db.exec(migration.sql)
      // `schema_migrations` is shared by every module on the same `ops.sqlite`.
      // Modules that predate docs/15 created it with `PRIMARY KEY (module)`,
      // while ③/⑦ use `PRIMARY KEY (module, version)`; `CREATE TABLE IF NOT
      // EXISTS` lets whoever opens first decide. A DELETE + INSERT keeps one
      // row per module without relying on an `ON CONFLICT` target that may not
      // exist, so migration stays correct regardless of which shape won.
      db.prepare('DELETE FROM schema_migrations WHERE module = ?').run(MIGRATION_MODULE)
      db.prepare('INSERT INTO schema_migrations(module, version, applied_at) VALUES (?, ?, ?)').run(
        MIGRATION_MODULE,
        migration.version,
        new Date().toISOString(),
      )
    }).immediate()
    current = migration.version
  }
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new GatewayError('invalid-input', `${field} must be a non-empty string`)
  }
  return value
}

function optionalText(value: string | null | undefined, field: string): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') {
    throw new GatewayError('invalid-input', `${field} must be a string`)
  }
  return value
}

function serializeJson(value: Json, field: string): string {
  if (value === undefined) throw new GatewayError('invalid-input', `${field} must be JSON`)
  let serialized: string | undefined
  try {
    serialized = JSON.stringify(value)
  } catch {
    throw new GatewayError('invalid-input', `${field} must be JSON-serializable`)
  }
  if (serialized === undefined) throw new GatewayError('invalid-input', `${field} must be JSON`)
  return serialized
}

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: string }).code
  if (code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY') return true
  return /UNIQUE constraint failed/.test(String((error as Error).message))
}

// ---------------------------------------------------------------------------
// Pairing codes (docs/14 §四)
// ---------------------------------------------------------------------------

/** Unambiguous alphabet (no 0/O/1/I/L) for codes humans type on a phone. */
const PAIRING_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const PAIRING_CODE_LENGTH = 8
export const PAIRING_CODE_DEFAULT_TTL_MS = 5 * 60_000
export const PAIRING_CODE_MIN_TTL_MS = 30_000
export const PAIRING_CODE_MAX_TTL_MS = 60 * 60_000

/** Codes compare case-insensitively and ignore dashes/spaces. */
export function normalizePairingCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '')
}

function hashPairingCode(normalized: string): string {
  return createHash('sha256').update(normalized).digest('hex')
}

function generatePairingCode(): string {
  const bytes = randomBytes(PAIRING_CODE_LENGTH)
  let raw = ''
  for (let index = 0; index < PAIRING_CODE_LENGTH; index += 1) {
    raw += PAIRING_CODE_ALPHABET[bytes[index]! % PAIRING_CODE_ALPHABET.length]
  }
  return `${raw.slice(0, 4)}-${raw.slice(4)}`
}

interface PairingCodeRow {
  code_hash: string
  actor_id: string
  channel_id: string | null
  created_at: string
  expires_at: string
  consumed_at: string | null
}

export function createGatewayStore(dbPath: string): GatewayStore {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true })
  const db = new DatabaseConstructor(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000')
  migrate(db)

  const insertInbox = db.prepare(`
    INSERT INTO inbox(
      id, channel_id, msg_id, kind, actor_id, content_json, chat_id, thread_id,
      reply_to_msg_id, status, error_code, received_at, processed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'accepted', NULL, ?, NULL)
  `)
  const selectInbox = db.prepare('SELECT * FROM inbox WHERE id = ?')
  const selectInboxByKey = db.prepare(
    'SELECT * FROM inbox WHERE channel_id = ? AND msg_id = ?',
  )
  const listInboxAll = db.prepare('SELECT * FROM inbox ORDER BY received_at ASC, rowid ASC')
  const listInboxByStatus = db.prepare(
    'SELECT * FROM inbox WHERE status = ? ORDER BY received_at ASC, rowid ASC',
  )
  const listInboxByChannel = db.prepare(
    'SELECT * FROM inbox WHERE channel_id = ? ORDER BY received_at ASC, rowid ASC',
  )
  const listInboxByStatusChannel = db.prepare(
    'SELECT * FROM inbox WHERE status = ? AND channel_id = ? ORDER BY received_at ASC, rowid ASC',
  )
  const updateInbox = db.prepare(
    'UPDATE inbox SET status = ?, error_code = ?, processed_at = ? WHERE id = ?',
  )

  const insertActor = db.prepare(
    'INSERT INTO actors(id, kind, display_name, created_at) VALUES (?, ?, ?, ?)',
  )
  const selectActor = db.prepare('SELECT * FROM actors WHERE id = ?')

  const insertBinding = db.prepare(`
    INSERT INTO channel_bindings(id, actor_id, channel_id, external_user_id, bound_at, revoked_at)
    VALUES (?, ?, ?, ?, ?, NULL)
  `)
  const selectLiveBinding = db.prepare(`
    SELECT * FROM channel_bindings
     WHERE channel_id = ? AND external_user_id = ? AND revoked_at IS NULL
  `)
  const selectBinding = db.prepare('SELECT * FROM channel_bindings WHERE id = ?')
  const revokeBinding = db.prepare('UPDATE channel_bindings SET revoked_at = ? WHERE id = ?')
  const listBindingsLive = db.prepare(
    'SELECT * FROM channel_bindings WHERE revoked_at IS NULL ORDER BY bound_at ASC, rowid ASC',
  )
  const listBindingsAll = db.prepare(
    'SELECT * FROM channel_bindings ORDER BY bound_at ASC, rowid ASC',
  )
  const resolveBindingActor = db.prepare(`
    SELECT a.*, b.id AS binding_id, b.actor_id AS binding_actor_id,
           b.channel_id AS binding_channel_id, b.external_user_id AS binding_external_user_id,
           b.bound_at AS binding_bound_at, b.revoked_at AS binding_revoked_at
      FROM channel_bindings b
      JOIN actors a ON a.id = b.actor_id
     WHERE b.channel_id = ? AND b.external_user_id = ? AND b.revoked_at IS NULL
  `)

  const insertPairingCode = db.prepare(`
    INSERT INTO pairing_codes(code_hash, actor_id, channel_id, created_at, expires_at, consumed_at)
    VALUES (?, ?, ?, ?, ?, NULL)
  `)
  const selectPairingCode = db.prepare('SELECT * FROM pairing_codes WHERE code_hash = ?')
  const consumePairingCodeStmt = db.prepare(
    'UPDATE pairing_codes SET consumed_at = ? WHERE code_hash = ?',
  )

  const upsertRoute = db.prepare(`
    INSERT INTO session_routes(channel_id, chat_id, session_kind, session_id, project_id, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(channel_id, chat_id, session_kind) DO UPDATE SET
      session_id = excluded.session_id,
      project_id = excluded.project_id,
      updated_at = excluded.updated_at
  `)
  const updateRouteProject = db.prepare(`
    UPDATE session_routes SET project_id = ?, updated_at = ?
     WHERE channel_id = ? AND chat_id = ? AND session_kind = ?
  `)
  const selectRoute = db.prepare(`
    SELECT * FROM session_routes
     WHERE channel_id = ? AND chat_id = ? AND session_kind = ?
  `)
  const listRoutesAll = db.prepare(
    'SELECT * FROM session_routes ORDER BY updated_at ASC, rowid ASC',
  )
  const listRoutesByChannel = db.prepare(
    'SELECT * FROM session_routes WHERE channel_id = ? ORDER BY updated_at ASC, rowid ASC',
  )
  const listRoutesByChat = db.prepare(
    'SELECT * FROM session_routes WHERE chat_id = ? ORDER BY updated_at ASC, rowid ASC',
  )

  const insertDecision = db.prepare(`
    INSERT INTO route_decisions(
      id, trigger_id, action, target_task_id, thread_id, reason, confidence, prompt_version,
      created_at, project_id, project_matched_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const listDecisionsAll = db.prepare(
    'SELECT * FROM route_decisions ORDER BY created_at ASC, rowid ASC',
  )
  const listDecisionsByTrigger = db.prepare(
    'SELECT * FROM route_decisions WHERE trigger_id = ? ORDER BY created_at ASC, rowid ASC',
  )
  const listDecisionsByThread = db.prepare(
    'SELECT * FROM route_decisions WHERE thread_id = ? ORDER BY created_at ASC, rowid ASC',
  )
  const listDecisionsByAction = db.prepare(
    'SELECT * FROM route_decisions WHERE action = ? ORDER BY created_at ASC, rowid ASC',
  )

  const selectThreadById = db.prepare('SELECT * FROM threads WHERE id = ?')
  const selectThreadByKey = db.prepare(`
    SELECT * FROM threads
     WHERE channel_id = ? AND chat_id = ? AND kind = ?
       AND COALESCE(topic_id, '') = ? AND COALESCE(root_msg_id, '') = ?
  `)
  const insertThread = db.prepare(`
    INSERT INTO threads(
      id, channel_id, chat_id, kind, topic_id, root_msg_id, project_id, created_at, last_msg_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const touchThread = db.prepare('UPDATE threads SET last_msg_at = ? WHERE id = ?')
  const listThreadsAll = db.prepare(
    'SELECT * FROM threads ORDER BY last_msg_at ASC, rowid ASC',
  )
  const listThreadsByChannel = db.prepare(
    'SELECT * FROM threads WHERE channel_id = ? ORDER BY last_msg_at ASC, rowid ASC',
  )
  const listThreadsByChat = db.prepare(
    'SELECT * FROM threads WHERE channel_id = ? AND chat_id = ? ORDER BY last_msg_at ASC, rowid ASC',
  )
  const selectTaskAnchorView = db.prepare(
    "SELECT 1 AS ok FROM sqlite_master WHERE type = 'view' AND name = 'v_task_anchors'",
  )

  const insertOutbox = db.prepare(`
    INSERT INTO outbox(
      id, topic, payload_json, status, attempts, next_retry_at, created_at, sent_at,
      lease_owner, lease_expires_at, external_msg_id, last_error,
      task_id, thread_id, reply_to_msg_id, dedupe_key
    ) VALUES (?, ?, ?, 'pending', 0, NULL, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, ?)
  `)
  const selectOutbox = db.prepare('SELECT * FROM outbox WHERE id = ?')
  const selectOutboxByDedupe = db.prepare('SELECT * FROM outbox WHERE dedupe_key = ?')
  const selectClaimable = db.prepare(`
    SELECT * FROM outbox
     WHERE status = 'pending'
       AND (next_retry_at IS NULL OR next_retry_at <= ?)
       AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
     ORDER BY created_at ASC, rowid ASC
     LIMIT ?
  `)
  const leaseOutbox = db.prepare(
    'UPDATE outbox SET attempts = ?, lease_owner = ?, lease_expires_at = ? WHERE id = ?',
  )
  const exhaustOutbox = db.prepare(`
    UPDATE outbox
       SET status = 'failed', last_error = ?, lease_owner = NULL, lease_expires_at = NULL
     WHERE id = ?
  `)
  const markSent = db.prepare(`
    UPDATE outbox
       SET status = 'sent', sent_at = ?, external_msg_id = ?, last_error = NULL,
           lease_owner = NULL, lease_expires_at = NULL, next_retry_at = NULL
     WHERE id = ?
  `)
  const markRetry = db.prepare(`
    UPDATE outbox
       SET status = 'pending', next_retry_at = ?, last_error = ?,
           lease_owner = NULL, lease_expires_at = NULL
     WHERE id = ?
  `)
  const markFailed = db.prepare(`
    UPDATE outbox
       SET status = 'failed', next_retry_at = NULL, last_error = ?,
           lease_owner = NULL, lease_expires_at = NULL
     WHERE id = ?
  `)
  const requeue = db.prepare(`
    UPDATE outbox
       SET status = 'pending', attempts = 0, next_retry_at = NULL, sent_at = NULL,
           lease_owner = NULL, lease_expires_at = NULL, external_msg_id = NULL, last_error = NULL
     WHERE id = ?
  `)
  const listOutboxAll = db.prepare('SELECT * FROM outbox ORDER BY created_at ASC, rowid ASC')
  const listOutboxByStatus = db.prepare(
    'SELECT * FROM outbox WHERE status = ? ORDER BY created_at ASC, rowid ASC',
  )
  const listHistoryInbox = db.prepare(`
    SELECT content_json, received_at FROM inbox
     WHERE thread_id = ? AND kind = 'message' AND status <> 'failed'
     ORDER BY received_at DESC, rowid DESC LIMIT ?
  `)
  const listHistoryOutbox = db.prepare(`
    SELECT payload_json, COALESCE(sent_at, created_at) AS at FROM outbox
     WHERE thread_id = ? AND topic = 'say' AND status = 'sent'
     ORDER BY COALESCE(sent_at, created_at) DESC, rowid DESC LIMIT ?
  `)
  const countOutboxFailedSince = db.prepare(
    "SELECT COUNT(*) AS n FROM outbox WHERE status = 'failed' AND created_at >= ?",
  )
  const countOutboxFailedAll = db.prepare(
    "SELECT COUNT(*) AS n FROM outbox WHERE status = 'failed'",
  )
  const countOutboxPending = db.prepare(
    "SELECT COUNT(*) AS n FROM outbox WHERE status = 'pending'",
  )
  const countOutboxRetrying = db.prepare(
    "SELECT COUNT(*) AS n FROM outbox WHERE status = 'pending' AND attempts > 0",
  )
  const selectOldestPending = db.prepare(
    "SELECT created_at FROM outbox WHERE status = 'pending' ORDER BY created_at ASC, rowid ASC LIMIT 1",
  )

  const getInbox = (id: string): InboxItem | null => {
    const row = selectInbox.get(id) as InboxRow | undefined
    return row === undefined ? null : toInbox(row)
  }

  const getOutbox = (id: string): OutboxItem | null => {
    const row = selectOutbox.get(id) as OutboxRow | undefined
    return row === undefined ? null : toOutbox(row)
  }

  const findOutboxByDedupe = (dedupeKey: string): OutboxItem | null => {
    const row = selectOutboxByDedupe.get(dedupeKey) as OutboxRow | undefined
    return row === undefined ? null : toOutbox(row)
  }

  return {
    acceptInbound(input) {
      const channelId = requiredText(input.channelId, 'channelId')
      const msgId = requiredText(input.msgId, 'msgId')
      const kind = input.kind ?? 'message'
      if (!INBOX_KINDS.includes(kind)) {
        throw new GatewayError('invalid-input', `unknown inbox kind ${JSON.stringify(kind)}`)
      }
      const contentJson = serializeJson(input.content, 'content')

      const existing = selectInboxByKey.get(channelId, msgId) as InboxRow | undefined
      if (existing !== undefined) {
        return { inbox: toInbox(existing), duplicate: true }
      }

      const item: InboxItem = {
        id: uuidv7(),
        channelId,
        msgId,
        kind,
        actorId: optionalText(input.actorId, 'actorId'),
        content: input.content,
        chatId: optionalText(input.chatId, 'chatId'),
        threadId: optionalText(input.threadId, 'threadId'),
        replyToMsgId: optionalText(input.replyToMsgId, 'replyToMsgId'),
        status: 'accepted',
        errorCode: null,
        receivedAt: new Date().toISOString(),
        processedAt: null,
      }

      try {
        insertInbox.run(
          item.id,
          item.channelId,
          item.msgId,
          item.kind,
          item.actorId,
          contentJson,
          item.chatId,
          item.threadId,
          item.replyToMsgId,
          item.receivedAt,
        )
      } catch (error) {
        // Two processes may race the same replay; the unique index wins, we
        // return the row that landed first (AR28).
        if (isUniqueViolation(error)) {
          const raced = selectInboxByKey.get(channelId, msgId) as InboxRow
          return { inbox: toInbox(raced), duplicate: true }
        }
        throw error
      }
      return { inbox: item, duplicate: false }
    },

    findInbox(channelId, msgId) {
      const row = selectInboxByKey.get(
        requiredText(channelId, 'channelId'),
        requiredText(msgId, 'msgId'),
      ) as InboxRow | undefined
      return row === undefined ? null : toInbox(row)
    },

    getInbox,

    listInbox(filter) {
      const limit = filter?.limit === undefined ? undefined : Math.max(1, Math.floor(filter.limit))
      let rows: InboxRow[]
      if (filter?.since !== undefined || filter?.until !== undefined) {
        // Windowed reads (conversation digest) get their own SQL so the whole
        // inbox is never materialised just to throw most of it away.
        const conditions: string[] = []
        const params: string[] = []
        if (filter.since !== undefined) {
          conditions.push('received_at >= ?')
          params.push(filter.since)
        }
        if (filter.until !== undefined) {
          conditions.push('received_at <= ?')
          params.push(filter.until)
        }
        rows = db
          .prepare(`SELECT * FROM inbox WHERE ${conditions.join(' AND ')} ORDER BY received_at ASC, rowid ASC`)
          .all(...params) as InboxRow[]
        if (filter.status !== undefined) {
          rows = rows.filter((row) => row.status === filter.status)
        }
        if (filter.channelId !== undefined) {
          rows = rows.filter((row) => row.channel_id === filter.channelId)
        }
      } else if (filter?.status !== undefined && filter?.channelId !== undefined) {
        rows = listInboxByStatusChannel.all(filter.status, filter.channelId) as InboxRow[]
      } else if (filter?.status !== undefined) {
        rows = listInboxByStatus.all(filter.status) as InboxRow[]
      } else if (filter?.channelId !== undefined) {
        rows = listInboxByChannel.all(filter.channelId) as InboxRow[]
      } else {
        rows = listInboxAll.all() as InboxRow[]
      }
      const items = rows.map(toInbox)
      return limit === undefined ? items : items.slice(0, limit)
    },

    threadHistory(threadId, limit = 12) {
      const n = Number.isInteger(limit) ? Math.max(1, Math.min(50, limit)) : 12
      const entries: ThreadHistoryEntry[] = []
      const inbound = listHistoryInbox.all(threadId, n) as Array<{
        content_json: string
        received_at: string
      }>
      for (const row of inbound) {
        const text = inboundText(parseJson(row.content_json))
        if (text !== null) entries.push({ role: 'user', text, at: row.received_at })
      }
      const outbound = listHistoryOutbox.all(threadId, n) as Array<{
        payload_json: string
        at: string
      }>
      for (const row of outbound) {
        const payload = parseJson(row.payload_json)
        if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) continue
        const text = (payload as Record<string, Json>).text
        if (typeof text === 'string' && text.trim() !== '') {
          entries.push({ role: 'assistant', text: text.trim(), at: row.at })
        }
      }
      return entries
        .sort((a, b) => (a.at === b.at ? 0 : a.at < b.at ? -1 : 1))
        .slice(-n)
    },

    updateInboxStatus(id, status, errorCode) {
      if (!INBOX_STATUSES.includes(status)) {
        throw new GatewayError('invalid-input', `unknown inbox status ${JSON.stringify(status)}`)
      }
      const row = selectInbox.get(id) as InboxRow | undefined
      if (row === undefined) throw new GatewayError('not-found', `inbox ${id} not found`)
      const processed = status === 'done' || status === 'failed' || status === 'rejected'
      updateInbox.run(
        status,
        optionalText(errorCode, 'errorCode'),
        processed ? new Date().toISOString() : null,
        id,
      )
      return toInbox(selectInbox.get(id) as InboxRow)
    },

    createActor(input) {
      const kind = input?.kind ?? 'owner'
      if (!ACTOR_KINDS.includes(kind)) {
        throw new GatewayError('invalid-input', `unknown actor kind ${JSON.stringify(kind)}`)
      }
      const actor: Actor = {
        id: uuidv7(),
        kind,
        displayName: optionalText(input?.displayName, 'displayName'),
        createdAt: new Date().toISOString(),
      }
      insertActor.run(actor.id, actor.kind, actor.displayName, actor.createdAt)
      return actor
    },

    getActor(id) {
      const row = selectActor.get(id) as ActorRow | undefined
      return row === undefined ? null : toActor(row)
    },

    bindChannel(input) {
      const actorId = requiredText(input.actorId, 'actorId')
      const channelId = requiredText(input.channelId, 'channelId')
      const externalUserId = requiredText(input.externalUserId, 'externalUserId')
      if (selectActor.get(actorId) === undefined) {
        throw new GatewayError('not-found', `actor ${actorId} not found`)
      }
      const live = selectLiveBinding.get(channelId, externalUserId) as BindingRow | undefined
      if (live !== undefined) {
        throw new GatewayError(
          'conflict',
          `${channelId}/${externalUserId} is already bound to actor ${live.actor_id}`,
        )
      }
      const binding: ChannelBinding = {
        id: uuidv7(),
        actorId,
        channelId,
        externalUserId,
        boundAt: new Date().toISOString(),
        revokedAt: null,
      }
      try {
        insertBinding.run(binding.id, actorId, channelId, externalUserId, binding.boundAt)
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new GatewayError('conflict', `${channelId}/${externalUserId} is already bound`)
        }
        throw error
      }
      return binding
    },

    unbindChannel(input) {
      const channelId = requiredText(input.channelId, 'channelId')
      const externalUserId = requiredText(input.externalUserId, 'externalUserId')
      const live = selectLiveBinding.get(channelId, externalUserId) as BindingRow | undefined
      if (live === undefined) {
        throw new GatewayError('not-found', `${channelId}/${externalUserId} has no live binding`)
      }
      revokeBinding.run(new Date().toISOString(), live.id)
      return toBinding(selectBinding.get(live.id) as BindingRow)
    },

    resolveActor(channelId, externalUserId) {
      const row = resolveBindingActor.get(channelId, externalUserId) as
        | (ActorRow & {
            binding_id: string
            binding_actor_id: string
            binding_channel_id: string
            binding_external_user_id: string
            binding_bound_at: string
            binding_revoked_at: string | null
          })
        | undefined
      if (row === undefined) return null
      return {
        actor: toActor(row),
        binding: {
          id: row.binding_id,
          actorId: row.binding_actor_id,
          channelId: row.binding_channel_id,
          externalUserId: row.binding_external_user_id,
          boundAt: row.binding_bound_at,
          revokedAt: row.binding_revoked_at,
        },
      }
    },

    listBindings(options) {
      const rows = options?.includeRevoked === true
        ? listBindingsAll.all() as BindingRow[]
        : listBindingsLive.all() as BindingRow[]
      return rows.map(toBinding)
    },

    mintPairingCode(input) {
      const actorId = requiredText(input.actorId, 'actorId')
      if (selectActor.get(actorId) === undefined) {
        throw new GatewayError('not-found', `actor ${actorId} not found`)
      }
      const ttlMs = input.ttlMs ?? PAIRING_CODE_DEFAULT_TTL_MS
      if (
        !Number.isFinite(ttlMs)
        || ttlMs < PAIRING_CODE_MIN_TTL_MS
        || ttlMs > PAIRING_CODE_MAX_TTL_MS
      ) {
        throw new GatewayError(
          'invalid-input',
          `ttlMs must be within [${PAIRING_CODE_MIN_TTL_MS}, ${PAIRING_CODE_MAX_TTL_MS}]`,
        )
      }
      const createdAt = (input.now ?? new Date()).toISOString()
      const expiresAt = new Date(new Date(createdAt).getTime() + ttlMs).toISOString()
      const code = generatePairingCode()
      insertPairingCode.run(
        hashPairingCode(normalizePairingCode(code)),
        actorId,
        optionalText(input.channelId, 'channelId'),
        createdAt,
        expiresAt,
      )
      return { code, expiresAt }
    },

    consumePairingCode(input) {
      const channelId = requiredText(input.channelId, 'channelId')
      const externalUserId = requiredText(input.externalUserId, 'externalUserId')
      const normalized = normalizePairingCode(requiredText(input.code, 'code'))
      const row = selectPairingCode.get(hashPairingCode(normalized)) as PairingCodeRow | undefined
      if (row === undefined) {
        throw new GatewayError('not-found', 'pairing code not found')
      }
      if (row.consumed_at !== null) {
        throw new GatewayError('conflict', 'pairing code already consumed')
      }
      const nowIso = (input.now ?? new Date()).toISOString()
      if (row.expires_at <= nowIso) {
        throw new GatewayError('invalid-state', 'pairing code expired')
      }
      if (row.channel_id !== null && row.channel_id !== channelId) {
        throw new GatewayError('conflict', 'pairing code is scoped to a different channel')
      }
      if (selectLiveBinding.get(channelId, externalUserId) !== undefined) {
        throw new GatewayError('conflict', `${channelId}/${externalUserId} is already bound`)
      }
      const actorRow = selectActor.get(row.actor_id) as ActorRow | undefined
      if (actorRow === undefined) {
        throw new GatewayError('not-found', `actor ${row.actor_id} not found`)
      }
      const binding = db.transaction(() => {
        consumePairingCodeStmt.run(nowIso, row.code_hash)
        const record: ChannelBinding = {
          id: uuidv7(),
          actorId: row.actor_id,
          channelId,
          externalUserId,
          boundAt: nowIso,
          revokedAt: null,
        }
        insertBinding.run(record.id, record.actorId, channelId, externalUserId, record.boundAt)
        return record
      }).immediate()
      return { actor: toActor(actorRow), binding }
    },

    setSessionRoute(input) {
      const channelId = requiredText(input.channelId, 'channelId')
      const chatId = requiredText(input.chatId, 'chatId')
      if (!SESSION_KINDS.includes(input.sessionKind)) {
        throw new GatewayError(
          'invalid-input',
          `unknown session kind ${JSON.stringify(input.sessionKind)}`,
        )
      }
      const sessionId = requiredText(input.sessionId, 'sessionId')
      const projectId = optionalText(input.projectId, 'projectId')
      upsertRoute.run(
        channelId,
        chatId,
        input.sessionKind,
        sessionId,
        projectId,
        new Date().toISOString(),
      )
      return toSessionRoute(
        selectRoute.get(channelId, chatId, input.sessionKind) as SessionRouteRow,
      )
    },

    setSessionProject(input) {
      const channelId = requiredText(input.channelId, 'channelId')
      const chatId = requiredText(input.chatId, 'chatId')
      if (!SESSION_KINDS.includes(input.sessionKind)) {
        throw new GatewayError(
          'invalid-input',
          `unknown session kind ${JSON.stringify(input.sessionKind)}`,
        )
      }
      return updateRouteProject.run(
        optionalText(input.projectId, 'projectId'),
        new Date().toISOString(),
        channelId,
        chatId,
        input.sessionKind,
      ).changes > 0
    },

    getSessionRoute(channelId, chatId, sessionKind) {
      const row = selectRoute.get(channelId, chatId, sessionKind) as SessionRouteRow | undefined
      return row === undefined ? null : toSessionRoute(row)
    },

    listSessionRoutes(filter) {
      let rows: SessionRouteRow[]
      if (filter?.channelId !== undefined) {
        rows = listRoutesByChannel.all(filter.channelId) as SessionRouteRow[]
      } else if (filter?.chatId !== undefined) {
        rows = listRoutesByChat.all(filter.chatId) as SessionRouteRow[]
      } else {
        rows = listRoutesAll.all() as SessionRouteRow[]
      }
      const routes = rows.map(toSessionRoute)
      if (filter?.chatId !== undefined && filter?.channelId !== undefined) {
        return routes.filter((route) => route.chatId === filter.chatId)
      }
      if (filter?.sessionKind !== undefined) {
        return routes.filter((route) => route.sessionKind === filter.sessionKind)
      }
      return routes
    },

    appendRouteDecision(input) {
      const triggerId = requiredText(input.triggerId, 'triggerId')
      if (!ROUTE_ACTIONS.includes(input.action)) {
        throw new GatewayError('invalid-input', `unknown route action ${JSON.stringify(input.action)}`)
      }
      const reason = requiredText(input.reason, 'reason')
      if (input.confidence !== undefined && input.confidence !== null
        && typeof input.confidence !== 'number') {
        throw new GatewayError('invalid-input', 'confidence must be a number')
      }
      const decision: RouteDecision = {
        id: uuidv7(),
        triggerId,
        action: input.action,
        targetTaskId: optionalText(input.targetTaskId, 'targetTaskId'),
        threadId: optionalText(input.threadId, 'threadId'),
        reason,
        confidence: input.confidence ?? null,
        promptVersion: optionalText(input.promptVersion, 'promptVersion'),
        createdAt: new Date().toISOString(),
        projectId: optionalText(input.projectId, 'projectId'),
        projectMatchedBy: optionalText(input.projectMatchedBy, 'projectMatchedBy') as
          RouteDecision['projectMatchedBy'],
      }
      insertDecision.run(
        decision.id,
        decision.triggerId,
        decision.action,
        decision.targetTaskId,
        decision.threadId,
        decision.reason,
        decision.confidence,
        decision.promptVersion,
        decision.createdAt,
        decision.projectId,
        decision.projectMatchedBy,
      )
      return decision
    },

    listRouteDecisions(filter) {
      const limit = filter?.limit === undefined ? undefined : Math.max(1, Math.floor(filter.limit))
      let rows: DecisionRow[]
      if (filter?.triggerId !== undefined) {
        rows = listDecisionsByTrigger.all(filter.triggerId) as DecisionRow[]
      } else if (filter?.threadId !== undefined) {
        rows = listDecisionsByThread.all(filter.threadId) as DecisionRow[]
      } else if (filter?.action !== undefined) {
        rows = listDecisionsByAction.all(filter.action) as DecisionRow[]
      } else {
        rows = listDecisionsAll.all() as DecisionRow[]
      }
      const decisions = rows.map(toDecision)
      const filtered = filter?.action === undefined
        ? decisions
        : decisions.filter((decision) => decision.action === filter.action)
      return limit === undefined ? filtered : filtered.slice(0, limit)
    },

    resolveThread(input) {
      const channelId = requiredText(input.channelId, 'channelId')
      const chatId = requiredText(input.chatId, 'chatId')
      const topicId = optionalText(input.topicId, 'topicId')
      const rootMsgId = optionalText(input.rootMsgId, 'rootMsgId')
      const projectId = optionalText(input.projectId, 'projectId')
      const kind: ThreadKind = topicId === null ? 'root' : 'topic'
      const nowIso = (input.now ?? new Date()).toISOString()

      const existing = selectThreadByKey.get(
        channelId,
        chatId,
        kind,
        topicId ?? '',
        rootMsgId ?? '',
      ) as ThreadRow | undefined
      if (existing !== undefined) {
        touchThread.run(nowIso, existing.id)
        return toThread(selectThreadById.get(existing.id) as ThreadRow)
      }

      const thread: ThreadRecord = {
        id: uuidv7(),
        channelId,
        chatId,
        kind,
        topicId,
        rootMsgId,
        projectId,
        createdAt: nowIso,
        lastMsgAt: nowIso,
      }
      try {
        insertThread.run(
          thread.id,
          thread.channelId,
          thread.chatId,
          thread.kind,
          thread.topicId,
          thread.rootMsgId,
          thread.projectId,
          thread.createdAt,
          thread.lastMsgAt,
        )
      } catch (error) {
        if (isUniqueViolation(error)) {
          const raced = selectThreadByKey.get(
            channelId,
            chatId,
            kind,
            topicId ?? '',
            rootMsgId ?? '',
          ) as ThreadRow
          touchThread.run(nowIso, raced.id)
          return toThread(selectThreadById.get(raced.id) as ThreadRow)
        }
        throw error
      }
      return thread
    },

    getThread(id) {
      const row = selectThreadById.get(id) as ThreadRow | undefined
      return row === undefined ? null : toThread(row)
    },

    listThreads(filter) {
      const limit = filter?.limit === undefined ? undefined : Math.max(1, Math.floor(filter.limit))
      let rows: ThreadRow[]
      if (filter?.channelId !== undefined && filter?.chatId !== undefined) {
        rows = listThreadsByChat.all(filter.channelId, filter.chatId) as ThreadRow[]
      } else if (filter?.channelId !== undefined) {
        rows = listThreadsByChannel.all(filter.channelId) as ThreadRow[]
      } else {
        rows = listThreadsAll.all() as ThreadRow[]
      }
      const threads = rows.map(toThread)
      const filtered = filter?.chatId === undefined
        ? threads
        : threads.filter((thread) => thread.chatId === filter.chatId)
      return limit === undefined ? filtered : filtered.slice(0, limit)
    },

    hasTaskAnchorView() {
      return selectTaskAnchorView.get() !== undefined
    },

    listTaskAnchors(threadId) {
      if (selectTaskAnchorView.get() === undefined) return []
      // Prepared lazily: the view may be created by ⑤ after this store opens.
      const rows = db.prepare(
        'SELECT task_id, anchor_msg_id, round, status, project_id FROM v_task_anchors WHERE thread_id = ?',
      ).all(threadId) as {
        task_id: string
        anchor_msg_id: string | null
        round: number | null
        status: string | null
        project_id: string | null
      }[]
      return rows.map((row) => ({
        taskId: row.task_id,
        anchorMsgId: row.anchor_msg_id,
        round: row.round,
        status: row.status,
        projectId: row.project_id ?? null,
      }))
    },

    enqueueOutbox(input) {
      const topic = requiredText(input.topic, 'topic')
      // Outbound guard (M7 / Slice BE): redact secrets first, then cap text.
      // ① owns `outbox`, so this is the single export choke point — nothing a
      // secret could leak through reaches the transport or the stored payload.
      const guarded = guardOutboundPayload(input.payload)
      const payloadJson = serializeJson(guarded.payload, 'payload')
      const dedupeKey = optionalText(input.dedupeKey, 'dedupeKey')
      const now = input.now ?? new Date()
      const item: OutboxItem = {
        id: uuidv7(),
        topic,
        payload: guarded.payload,
        status: 'pending',
        attempts: 0,
        nextRetryAt: null,
        createdAt: now.toISOString(),
        sentAt: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        externalMsgId: null,
        lastError: null,
        taskId: optionalText(input.taskId, 'taskId'),
        threadId: optionalText(input.threadId, 'threadId'),
        replyToMsgId: optionalText(input.replyToMsgId, 'replyToMsgId'),
      }
      try {
        insertOutbox.run(
          item.id,
          item.topic,
          payloadJson,
          item.createdAt,
          item.taskId,
          item.threadId,
          item.replyToMsgId,
          dedupeKey,
        )
      } catch (error) {
        if (dedupeKey !== null && isUniqueViolation(error)) {
          const existing = selectOutboxByDedupe.get(dedupeKey) as OutboxRow | undefined
          if (existing !== undefined) return toOutbox(existing)
        }
        throw error
      }
      return item
    },

    claimOutbox(input) {
      const owner = requiredText(input.owner, 'owner')
      if (!Number.isFinite(input.leaseMs) || input.leaseMs <= 0) {
        throw new GatewayError('invalid-input', 'leaseMs must be a positive number')
      }
      const limit = Math.max(1, Math.floor(input.limit ?? 10))
      const now = input.now ?? new Date()
      const nowIso = now.toISOString()
      const leaseUntil = new Date(now.getTime() + input.leaseMs).toISOString()

      const claimed: OutboxItem[] = []
      db.transaction(() => {
        const candidates = selectClaimable.all(nowIso, nowIso, limit) as OutboxRow[]
        for (const row of candidates) {
          const attempts = row.attempts + 1
          if (attempts > OUTBOX_MAX_ATTEMPTS) {
            // An attempt was started but never resolved (crash / lease loss).
            exhaustOutbox.run('attempts exhausted', row.id)
            continue
          }
          leaseOutbox.run(attempts, owner, leaseUntil, row.id)
          claimed.push(toOutbox(selectOutbox.get(row.id) as OutboxRow))
        }
      }).immediate()
      return claimed
    },

    markOutboxSent(id, externalMsgId, now) {
      const ack = requiredText(externalMsgId, 'externalMsgId')
      const row = selectOutbox.get(id) as OutboxRow | undefined
      if (row === undefined) throw new GatewayError('not-found', `outbox ${id} not found`)
      if (row.status !== 'pending') {
        throw new GatewayError('invalid-state', `outbox ${id} is ${row.status}, not pending`)
      }
      markSent.run((now ?? new Date()).toISOString(), ack, id)
      return toOutbox(selectOutbox.get(id) as OutboxRow)
    },

    markOutboxFailed(id, input) {
      const error = requiredText(input.error, 'error')
      const row = selectOutbox.get(id) as OutboxRow | undefined
      if (row === undefined) throw new GatewayError('not-found', `outbox ${id} not found`)
      if (row.status !== 'pending') {
        throw new GatewayError('invalid-state', `outbox ${id} is ${row.status}, not pending`)
      }
      const now = input.now ?? new Date()
      const delay = outboxBackoffMs(row.attempts)
      if (!input.retryable || delay === null) {
        markFailed.run(error, id)
      } else {
        markRetry.run(new Date(now.getTime() + delay).toISOString(), error, id)
      }
      return toOutbox(selectOutbox.get(id) as OutboxRow)
    },

    requeueOutbox(id) {
      const row = selectOutbox.get(id) as OutboxRow | undefined
      if (row === undefined) throw new GatewayError('not-found', `outbox ${id} not found`)
      if (row.status !== 'failed') {
        throw new GatewayError('invalid-state', `outbox ${id} is ${row.status}, not failed`)
      }
      requeue.run(id)
      return toOutbox(selectOutbox.get(id) as OutboxRow)
    },

    getOutbox,

    findOutboxByDedupe,

    listOutbox(filter) {
      const limit = filter?.limit === undefined ? undefined : Math.max(1, Math.floor(filter.limit))
      const rows = filter?.status === undefined
        ? listOutboxAll.all() as OutboxRow[]
        : listOutboxByStatus.all(filter.status) as OutboxRow[]
      const items = rows.map(toOutbox)
      return limit === undefined ? items : items.slice(0, limit)
    },

    outboxHealth(input) {
      const failed = (input?.since === undefined
        ? countOutboxFailedAll.get()
        : countOutboxFailedSince.get(input.since.toISOString())) as { n: number }
      const pending = countOutboxPending.get() as { n: number }
      const retrying = countOutboxRetrying.get() as { n: number }
      const oldest = selectOldestPending.get() as { created_at: string } | undefined
      const now = input?.now ?? new Date()
      const oldestAt = oldest === undefined ? Number.NaN : Date.parse(oldest.created_at)
      return {
        failed: failed.n,
        pending: pending.n,
        retrying: retrying.n,
        oldestPendingAgeMs: Number.isNaN(oldestAt) ? null : Math.max(0, now.getTime() - oldestAt),
      }
    },

    close() {
      db.close()
    },
  }
}
