/**
 * `tasks` / `task_events` / `task_assertions` / `receipts` store.
 *
 * Single writer is module ⑤ (docs/15 §三 / §四). `outbox` is NOT here: from v2
 * it belongs to module ①, and ⑤ only writes a receipt plus a
 * `task.completed` event (docs/15 §三).
 */

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomBytes } from 'node:crypto'
import DatabaseConstructor, { type Database } from 'better-sqlite3'
import {
  TaskError,
  assertMergeTransition,
  assertTransition,
  eventTypeFor,
  isTerminal,
  uuidv7,
  type AssertionKind,
  type AssertionStatus,
  type IsolationMode,
  type Json,
  type JsonObject,
  type MergeState,
  type PrepareState,
  type Receipt,
  type RiskLevel,
  type Task,
  type TaskAssertion,
  type TaskCheckpoint,
  type TaskEvent,
  type TaskEventType,
  type TaskInput,
  type TaskInputStatus,
  type TaskStatus,
  type TaskThread,
  type TaskThreadRelation,
  type ThreadOccupancy,
  type ThreadReleaseReason,
} from './model.js'
import type { PreparedAssertion } from './assertions.js'
import { MAX_RESOURCE_TTL_SEC, declaredResources, normalizeResourceKeys } from './resource-locks.js'

const MIGRATION_MODULE = 'tasks'

const MIGRATIONS_DDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  module      TEXT NOT NULL,
  version     INTEGER NOT NULL,
  applied_at  TEXT NOT NULL,
  PRIMARY KEY (module)
);
`

const TASKS_DDL = `
CREATE TABLE IF NOT EXISTS tasks (
  id              TEXT PRIMARY KEY,
  project_id      TEXT,
  conversation_id TEXT,
  session_id      TEXT,
  start_cursor    TEXT,
  intent          TEXT NOT NULL,
  risk_level      TEXT NOT NULL CHECK (risk_level IN ('R0','R1','R2','R3')),
  status          TEXT NOT NULL CHECK (status IN
                    ('queued','running','waiting_approval','waiting_input',
                     'paused','succeeded','failed','cancelled')),
  plan_json       TEXT,
  attempt         INTEGER NOT NULL DEFAULT 0,
  max_attempts    INTEGER NOT NULL DEFAULT 2,
  lease_owner     TEXT,
  lease_expires_at TEXT,
  correlation_id  TEXT NOT NULL,
  round           INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL,
  started_at      TEXT,
  finished_at     TEXT
);
CREATE INDEX IF NOT EXISTS ix_tasks_status ON tasks(status, created_at);
CREATE INDEX IF NOT EXISTS ix_tasks_lease  ON tasks(status, lease_expires_at);
`

const TASK_EVENTS_DDL = `
CREATE TABLE IF NOT EXISTS task_events (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL,
  seq          INTEGER NOT NULL,
  type         TEXT NOT NULL,
  payload_json TEXT,
  created_at   TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_task_events_seq ON task_events(task_id, seq);
CREATE INDEX IF NOT EXISTS ix_task_events_task ON task_events(task_id, created_at);
CREATE TRIGGER IF NOT EXISTS task_events_no_update BEFORE UPDATE ON task_events
  BEGIN SELECT RAISE(ABORT, 'task_events is append-only'); END;
CREATE TRIGGER IF NOT EXISTS task_events_no_delete BEFORE DELETE ON task_events
  BEGIN SELECT RAISE(ABORT, 'task_events is append-only'); END;
`

const TASK_ASSERTIONS_DDL = `
CREATE TABLE IF NOT EXISTS task_assertions (
  id            TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN
                  ('exit_code','file_exists','port_listening','service_active',
                   'http_status','git_diff_matches','page_contains')),
  spec_json     TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('pending','pass','fail','skipped')),
  evidence_json TEXT,
  checked_at    TEXT
);
CREATE INDEX IF NOT EXISTS ix_task_assertions_task ON task_assertions(task_id);
`

const RECEIPTS_DDL = `
CREATE TABLE IF NOT EXISTS receipts (
  id               TEXT PRIMARY KEY,
  task_id          TEXT NOT NULL,
  round            INTEGER,
  summary          TEXT NOT NULL,
  evidence_locator TEXT,
  external_msg_id  TEXT,
  delivered_at     TEXT,
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_receipts_task ON receipts(task_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_receipts_round
  ON receipts(task_id, round) WHERE round IS NOT NULL;
`

/**
 * v2 (docs/15 §9.1 / §9.5): thread subscriptions, pending inputs, the
 * read-only anchor view consumed by ①, plus the two `tasks` columns.
 * `receipts.round` / `receipts.external_msg_id` shipped in v1 already.
 */
const TASKS_V2_DDL = `
ALTER TABLE tasks ADD COLUMN origin_msg_id TEXT;
ALTER TABLE tasks ADD COLUMN task_ref TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_tasks_task_ref
  ON tasks(task_ref) WHERE task_ref IS NOT NULL;

CREATE TABLE IF NOT EXISTS task_threads (
  id             TEXT PRIMARY KEY,
  task_id        TEXT NOT NULL,
  thread_id      TEXT NOT NULL,
  relation       TEXT NOT NULL CHECK (relation IN ('default_owner','anchor')),
  anchor_msg_id  TEXT,
  created_at     TEXT NOT NULL,
  released_at    TEXT,
  release_reason TEXT CHECK (release_reason IN ('handback','stopped','superseded','failed'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_task_thread_live
  ON task_threads(task_id, thread_id, relation, COALESCE(anchor_msg_id,''))
  WHERE released_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_thread_default_owner
  ON task_threads(thread_id) WHERE relation='default_owner' AND released_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_task_threads_thread ON task_threads(thread_id, released_at);

CREATE TABLE IF NOT EXISTS task_inputs (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL,
  inbox_id     TEXT NOT NULL,
  round        INTEGER NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('pending','delivered','read','returned')),
  delivered_at TEXT,
  read_at      TEXT,
  error_code   TEXT,
  created_at   TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_task_input_dedup ON task_inputs(task_id, inbox_id);
CREATE INDEX IF NOT EXISTS ix_task_inputs_pending ON task_inputs(task_id, status, round);

CREATE VIEW IF NOT EXISTS v_task_anchors AS
SELECT tt.task_id,
       tt.thread_id,
       COALESCE(tt.anchor_msg_id, tk.origin_msg_id) AS anchor_msg_id,
       tk.round,
       tk.status
FROM task_threads tt
JOIN tasks tk ON tk.id = tt.task_id
WHERE tt.released_at IS NULL;
`

/**
 * v4 (11 §5.3.1): anchors also carry the task's project, so ① can inherit
 * "which project" from a reply without reading ⑤'s tables (AR33).
 * `project_id` is appended, existing columns keep their order.
 */
const TASKS_V4_DDL = `
DROP VIEW IF EXISTS v_task_anchors;
CREATE VIEW v_task_anchors AS
SELECT tt.task_id,
       tt.thread_id,
       COALESCE(tt.anchor_msg_id, tk.origin_msg_id) AS anchor_msg_id,
       tk.round,
       tk.status,
       tk.project_id
FROM task_threads tt
JOIN tasks tk ON tk.id = tt.task_id
WHERE tt.released_at IS NULL;
`

/**
 * v3 (13 §3.3): the worker leases a claimed task and schedules retries.
 * `next_attempt_at` keeps a transient failure from being re-claimed instantly.
 */
const TASKS_V3_DDL = `
ALTER TABLE tasks ADD COLUMN next_attempt_at TEXT;
CREATE INDEX IF NOT EXISTS ix_tasks_wake ON tasks(status, next_attempt_at);
`

/**
 * v5 (13 §3.4): step boundaries. A checkpoint is opened by the executor around
 * one semantic step; pre-images captured while it is open carry its id, so a
 * failed step rolls back alone. `seq` is 1-based per task.
 */
const TASKS_V5_DDL = `
CREATE TABLE IF NOT EXISTS task_checkpoints (
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  label      TEXT,
  status     TEXT NOT NULL CHECK (status IN ('open','committed','aborted')),
  created_at TEXT NOT NULL,
  closed_at  TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_task_checkpoints_seq ON task_checkpoints(task_id, seq);
CREATE INDEX IF NOT EXISTS ix_task_checkpoints_task ON task_checkpoints(task_id, status);
`

/**
 * v6 (11 §十四 / 15 §十, B4-b): one isolation unit per task. `worktree` tasks
 * carry the checkout address and branch; `merge_state` stays `none` after
 * success (a ready branch is not a merge). Existing rows default to `serial`.
 */
const TASKS_V6_DDL = `
ALTER TABLE tasks ADD COLUMN isolation TEXT NOT NULL DEFAULT 'serial'
  CHECK (isolation IN ('serial','worktree'));
ALTER TABLE tasks ADD COLUMN worktree_path TEXT;
ALTER TABLE tasks ADD COLUMN base_commit TEXT;
ALTER TABLE tasks ADD COLUMN branch TEXT;
ALTER TABLE tasks ADD COLUMN merge_state TEXT NOT NULL DEFAULT 'none'
  CHECK (merge_state IN ('none','pending','merged','conflict','abandoned'));
ALTER TABLE tasks ADD COLUMN prepare_state TEXT NOT NULL DEFAULT 'none'
  CHECK (prepare_state IN ('none','running','done','failed'));
ALTER TABLE tasks ADD COLUMN prepared_at TEXT;
CREATE INDEX IF NOT EXISTS ix_tasks_isolation ON tasks(isolation, merge_state);
CREATE UNIQUE INDEX IF NOT EXISTS ux_tasks_worktree_path
  ON tasks(worktree_path) WHERE worktree_path IS NOT NULL;
`

/**
 * v7 (11 §14.6 / 15 §10.4, B4-b Phase 3): non-file resources. Keys are
 * normalised before insert, so the live unique index is the serialisation point
 * for ports / databases / units / docker projects / git merges.
 */
const TASKS_V7_DDL = `
CREATE TABLE IF NOT EXISTS resource_locks (
  id               TEXT PRIMARY KEY,
  resource_key     TEXT NOT NULL,
  task_id          TEXT NOT NULL,
  lease_owner      TEXT,
  lease_expires_at TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  released_at      TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_resource_lock_live
  ON resource_locks(resource_key) WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_resource_locks_lease
  ON resource_locks(released_at, lease_expires_at);
`

/**
 * v8: `unit_restarted` becomes an assertion kind. SQLite cannot alter a CHECK
 * constraint in place, so the table is rebuilt and copied (same columns, same
 * index) — existing rows are preserved verbatim.
 */
const TASKS_V8_DDL = `
CREATE TABLE task_assertions_v8 (
  id            TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN
                  ('exit_code','file_exists','port_listening','service_active','unit_restarted',
                   'http_status','git_diff_matches','page_contains')),
  spec_json     TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('pending','pass','fail','skipped')),
  evidence_json TEXT,
  checked_at    TEXT
);
INSERT INTO task_assertions_v8 (id, task_id, kind, spec_json, status, evidence_json, checked_at)
  SELECT id, task_id, kind, spec_json, status, evidence_json, checked_at FROM task_assertions;
DROP TABLE task_assertions;
ALTER TABLE task_assertions_v8 RENAME TO task_assertions;
CREATE INDEX IF NOT EXISTS ix_task_assertions_task ON task_assertions(task_id);
`

const MIGRATIONS: ReadonlyArray<{ version: number; ddl: string }> = [
  {
    version: 1,
    ddl: TASKS_DDL + TASK_EVENTS_DDL + TASK_ASSERTIONS_DDL + RECEIPTS_DDL,
  },
  { version: 2, ddl: TASKS_V2_DDL },
  { version: 3, ddl: TASKS_V3_DDL },
  { version: 4, ddl: TASKS_V4_DDL },
  { version: 5, ddl: TASKS_V5_DDL },
  { version: 6, ddl: TASKS_V6_DDL },
  { version: 7, ddl: TASKS_V7_DDL },
  { version: 8, ddl: TASKS_V8_DDL },
]

export interface CreateTaskInput {
  intent: string
  riskLevel: RiskLevel
  projectId?: string | null
  conversationId?: string | null
  sessionId?: string | null
  startCursor?: string | null
  originMsgId?: string | null
  plan?: Json
  maxAttempts?: number
  round?: number
  correlationId?: string
}

export interface TransitionInput {
  to: TaskStatus
  /** Required for terminal transitions: the receipt the owner will see. */
  summary?: string
  evidenceLocator?: string | null
  reason?: string
}

export interface TaskFilter {
  status?: TaskStatus
  projectId?: string
  limit?: number
}

/** A receipt together with the live thread it should be announced in. */
export interface PendingReceipt extends Receipt {
  threadId: string | null
}

/** `TaskSubscriptionApi.bind` (15 §9.6). */
export interface BindThreadInput {
  taskId: string
  threadId: string
  relation: TaskThreadRelation
  anchorMsgId?: string | null
}

/** `TaskSubscriptionApi.release` (15 §9.6). */
export interface ReleaseThreadInput {
  taskId: string
  threadId: string
  reason: ThreadReleaseReason
}

/** `TaskInputApi.enqueue` (15 §9.6): `round` is taken from `tasks.round`. */
export interface EnqueueInputInput {
  taskId: string
  inboxId: string
}

/**
 * AR37 wake: re-queue a `succeeded` task that still owns a live thread.
 * The caller must already have re-verified the actor (③), and `task_ref` is
 * never an authorization input — this only enforces the state precondition.
 */
export interface WakeTaskInput {
  taskId: string
  /** Human-readable cause, kept in `task_events`. */
  reason?: string
}

/** Owner supplement already enqueued as a `task_inputs` row. */
export interface SteerTaskInput {
  taskId: string
  inputId: string
  /** Plain text of the supplement, already redacted by ①. */
  text: string
}

/**
 * `rerun`: the running attempt was interrupted and the task re-queued;
 * `merged`: the task had not started, so the supplement joined its intent;
 * `recorded`: the task is parked (`waiting_*`), the supplement applies when it
 * resumes.
 */
export interface SteerTaskResult {
  task: Task
  applied: 'rerun' | 'merged' | 'recorded'
}

/** Approval gate (Slice I): park a task before the worker can lease it. */
export interface HoldTaskInput {
  taskId: string
  reason?: string
}

export interface ResumeFromApprovalInput {
  taskId: string
  approvalId: string
  actorId?: string
  now?: Date
}

/**
 * A second resume is a no-op, not an error: clicking "approve" twice must not
 * look like a failure, and must never re-queue a task that already moved on.
 */
export interface ResumeFromApprovalResult {
  resumed: boolean
  task: Task | null
  reason?: 'not-found' | 'not-waiting'
}

export interface TaskStore {
  createTask(input: CreateTaskInput): Task
  getTask(id: string): Task | null
  listTasks(filter?: TaskFilter): Task[]
  transition(taskId: string, input: TransitionInput): Task
  addAssertion(taskId: string, assertion: PreparedAssertion): TaskAssertion
  listAssertions(taskId: string): TaskAssertion[]
  setAssertionResult(
    assertionId: string,
    result: { status: AssertionStatus; evidence: Json | null; checkedAt: string },
  ): TaskAssertion
  appendEvent(taskId: string, type: TaskEventType, payload?: Json): TaskEvent
  listEvents(taskId: string, limit?: number): TaskEvent[]
  /** Latest event by seq; `null` before the first append (Slice R stall check). */
  latestEvent(taskId: string): TaskEvent | null
  writeReceipt(input: {
    taskId: string
    summary: string
    evidenceLocator?: string | null
    round?: number | null
    externalMsgId?: string | null
  }): Receipt
  listReceipts(taskId: string): Receipt[]

  /**
   * Receipt closure with ① (15 §9.6): undelivered receipts plus the thread to
   * announce them in (default owner first, then the latest live anchor).
   */
  pendingReceipts(limit?: number): PendingReceipt[]
  /** ① after a successful send; idempotent on an already delivered receipt. */
  markReceiptDelivered(id: string, externalMsgId: string): Receipt

  /** `TaskSubscriptionApi` — writes `task_threads` (⑤ is the only writer). */
  bindThread(input: BindThreadInput): TaskThread
  releaseThread(input: ReleaseThreadInput): TaskThread[]
  occupancy(threadId: string): ThreadOccupancy
  listTaskThreads(filter?: { taskId?: string; threadId?: string; liveOnly?: boolean }): TaskThread[]

  /** `TaskInputApi` — writes `task_inputs`. */
  enqueueInput(input: EnqueueInputInput): TaskInput
  pendingInputs(taskId: string): TaskInput[]
  markInputDelivered(id: string): TaskInput
  markInputRead(id: string): TaskInput

  /**
   * AR37 wake: `succeeded → queued` with `round + 1`, clearing attempt and the
   * lease. Requires a live thread subscription (otherwise there is nobody to
   * wake into). This is the only out-edge of a terminal status; it is not part
   * of `ALLOWED_TRANSITIONS`.
   */
  wakeTask(input: WakeTaskInput): Task

  /**
   * Approval gate (Slice I): `queued → waiting_approval`, so the worker (which
   * only claims `queued`) cannot start an R2/R3 task before a human decides.
   * Throws `conflict` when the task already left `queued`.
   */
  holdForApproval(input: HoldTaskInput): Task
  /**
   * Approval granted: `waiting_approval → queued`, lease cleared, so the next
   * worker tick picks it up. A second call is a no-op (`resumed: false`).
   */
  resumeFromApproval(input: ResumeFromApprovalInput): ResumeFromApprovalResult

  /**
   * B3 v2 owner "继续" on a watchdog-paused task: `paused → queued`, lease and
   * wake time cleared, `attempt` reset so the re-run gets a fresh budget.
   * Throws `invalid-transition` unless the row is currently `paused`.
   */
  resumeTask(taskId: string): Task

  /**
   * Slice AO: apply an owner supplement to a live task instead of dropping it
   * into `task_inputs` forever. `running`/`paused` → queued with the supplement
   * appended to the intent and a fresh budget (the caller aborts the child);
   * `queued`/`waiting_*` only rewrite the intent. The input row moves to
   * `delivered`, and `claimTask` later marks it `read`.
   */
  steerTask(input: SteerTaskInput): SteerTaskResult

  /**
   * Worker lease API (13 §3.3). `claimTask` is the only way a task enters
   * `running` on its own: it picks the oldest wakeable `queued` row, takes the
   * lease and increments `attempt` in one transaction.
   */
  claimTask(input: ClaimTaskInput): Task | null
  /** Extends the lease; false when the lease was lost (another worker owns it). */
  renewLease(input: RenewLeaseInput): boolean
  /** Running → queued with a wake-up time; only for transient failures. */
  requeueTask(input: RequeueTaskInput): Task
  /**
   * Running → queued without consuming an attempt (B4-b Phase 3). Used when a
   * declared resource is held by another task: contention must park the task,
   * not burn its retry budget (11 §14.6).
   */
  deferTask(input: DeferTaskInput): Task
  /**
   * Reclaims tasks whose lease expired without a heartbeat. Attempts left →
   * queued (no backoff: the worker died, it never reported a port error).
   * Out of attempts → failed with a receipt, so it is never silently stuck.
   */
  recoverExpiredLeases(input?: { now?: Date; limit?: number }): {
    requeued: string[]
    failed: string[]
  }

  /** Step boundaries (13 §3.4): one open checkpoint per step, then commit/abort. */
  beginCheckpoint(input: BeginCheckpointInput): TaskCheckpoint
  getCheckpoint(id: string): TaskCheckpoint | null
  listCheckpoints(taskId: string): TaskCheckpoint[]
  /** open → committed / aborted; a second close is a `conflict`. */
  closeCheckpoint(id: string, status: 'committed' | 'aborted'): TaskCheckpoint

  /**
   * B4-b isolation fields (15 §十): only ⑤ writes them. `worktree` requires the
   * path/base/branch triple; a partial patch is rejected instead of guessed.
   */
  setIsolation(taskId: string, patch: IsolationPatch): Task

  /**
   * B4-b Phase 3 resource leases (15 §10.4). Keys are normalised inside the
   * store; the transaction is all-or-nothing and contention returns the live
   * holders instead of throwing (the caller parks the task).
   */
  acquireResourceLocks(input: AcquireResourceLocksInput): AcquireResourceLocksResult
  /** Extends live leases; expired rows are released first and reported as lost. */
  heartbeatResourceLocks(input: HeartbeatResourceLocksInput): HeartbeatResourceLocksResult
  /** Idempotent release of explicit ids; already released ids are ignored. */
  releaseResourceLocks(lockIds: readonly string[], at?: Date): number
  /** Lifecycle tie-in: release every lease still held by a task. */
  releaseTaskResourceLocks(taskId: string, at?: Date): number
  listResourceLocks(filter?: ResourceLockFilter): ResourceLock[]

  close(): void
}

export interface DeferTaskInput {
  taskId: string
  owner: string
  delayMs: number
  reason: string
  /** Live holders that blocked the lease (audit only). */
  blocking?: ResourceLockConflict[]
  now?: Date
}

export interface ResourceLock {
  id: string
  resourceKey: string
  taskId: string
  leaseOwner: string | null
  leaseExpiresAt: string
  createdAt: string
  releasedAt: string | null
}

export interface ResourceLockConflict {
  key: string
  taskId: string
  leaseExpiresAt: string
}

export interface AcquireResourceLocksInput {
  taskId: string
  keys: readonly string[]
  ttlSec: number
  owner?: string | null
  now?: Date
}

export interface AcquireResourceLocksResult {
  acquired: ResourceLock[]
  conflicts: ResourceLockConflict[]
  expiresAt: string
}

export interface HeartbeatResourceLocksInput {
  lockIds: readonly string[]
  ttlSec: number
  now?: Date
}

export interface HeartbeatResourceLocksResult {
  extended: number
  liveIds: string[]
  expiresAt: string
}

export interface ResourceLockFilter {
  taskId?: string
  includeReleased?: boolean
  now?: Date
}

export interface IsolationPatch {
  isolation?: IsolationMode
  worktreePath?: string | null
  baseCommit?: string | null
  branch?: string | null
  mergeState?: MergeState
  prepareState?: PrepareState
  preparedAt?: string | null
}

export interface BeginCheckpointInput {
  taskId: string
  label?: string | null
}

export interface ClaimTaskInput {
  owner: string
  leaseMs: number
  now?: Date
}

export interface RenewLeaseInput {
  taskId: string
  owner: string
  leaseMs: number
  now?: Date
}

export interface RequeueTaskInput {
  taskId: string
  owner: string
  delayMs: number
  /** Human-readable cause, kept in `task_events`. */
  reason?: string
  now?: Date
}

interface TaskRow {
  id: string
  project_id: string | null
  conversation_id: string | null
  session_id: string | null
  start_cursor: string | null
  intent: string
  risk_level: RiskLevel
  status: TaskStatus
  plan_json: string | null
  attempt: number
  max_attempts: number
  lease_owner: string | null
  lease_expires_at: string | null
  correlation_id: string
  round: number
  origin_msg_id: string | null
  task_ref: string | null
  next_attempt_at: string | null
  isolation: IsolationMode
  worktree_path: string | null
  base_commit: string | null
  branch: string | null
  merge_state: MergeState
  prepare_state: PrepareState
  prepared_at: string | null
  created_at: string
  started_at: string | null
  finished_at: string | null
}

interface EventRow {
  id: string
  task_id: string
  seq: number
  type: TaskEventType
  payload_json: string | null
  created_at: string
}

interface AssertionRow {
  id: string
  task_id: string
  kind: AssertionKind
  spec_json: string
  status: AssertionStatus
  evidence_json: string | null
  checked_at: string | null
}

interface ReceiptRow {
  id: string
  task_id: string
  round: number | null
  summary: string
  evidence_locator: string | null
  external_msg_id: string | null
  delivered_at: string | null
  created_at: string
}

interface PendingReceiptRow extends ReceiptRow {
  thread_id: string | null
}

interface TaskThreadRow {
  id: string
  task_id: string
  thread_id: string
  relation: TaskThreadRelation
  anchor_msg_id: string | null
  created_at: string
  released_at: string | null
  release_reason: ThreadReleaseReason | null
}

interface TaskInputRow {
  id: string
  task_id: string
  inbox_id: string
  round: number
  status: TaskInputStatus
  delivered_at: string | null
  read_at: string | null
  error_code: string | null
  created_at: string
}

interface OccupancyRow {
  task_id: string
  status: TaskStatus
  relation: TaskThreadRelation
}

interface CheckpointRow {
  id: string
  task_id: string
  seq: number
  label: string | null
  status: 'open' | 'committed' | 'aborted'
  created_at: string
  closed_at: string | null
}

interface ResourceLockRow {
  id: string
  resource_key: string
  task_id: string
  lease_owner: string | null
  lease_expires_at: string
  created_at: string
  released_at: string | null
}

function parseJson(raw: string | null): Json | null {
  return raw === null ? null : JSON.parse(raw) as Json
}

function toTask(row: TaskRow): Task {
  return {
    id: row.id,
    projectId: row.project_id,
    conversationId: row.conversation_id,
    sessionId: row.session_id,
    startCursor: row.start_cursor,
    intent: row.intent,
    riskLevel: row.risk_level,
    status: row.status,
    plan: parseJson(row.plan_json),
    attempt: row.attempt,
    maxAttempts: row.max_attempts,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    correlationId: row.correlation_id,
    round: row.round,
    originMsgId: row.origin_msg_id,
    taskRef: row.task_ref,
    isolation: row.isolation,
    worktreePath: row.worktree_path,
    baseCommit: row.base_commit,
    branch: row.branch,
    mergeState: row.merge_state,
    prepareState: row.prepare_state,
    preparedAt: row.prepared_at,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  }
}

function toEvent(row: EventRow): TaskEvent {
  return {
    id: row.id,
    taskId: row.task_id,
    seq: row.seq,
    type: row.type,
    payload: parseJson(row.payload_json),
    createdAt: row.created_at,
  }
}

function toAssertion(row: AssertionRow): TaskAssertion {
  return {
    id: row.id,
    taskId: row.task_id,
    kind: row.kind,
    spec: JSON.parse(row.spec_json) as JsonObject,
    status: row.status,
    evidence: parseJson(row.evidence_json),
    checkedAt: row.checked_at,
  }
}

function toReceipt(row: ReceiptRow): Receipt {
  return {
    id: row.id,
    taskId: row.task_id,
    round: row.round,
    summary: row.summary,
    evidenceLocator: row.evidence_locator,
    externalMsgId: row.external_msg_id,
    deliveredAt: row.delivered_at,
    createdAt: row.created_at,
  }
}

function toTaskThread(row: TaskThreadRow): TaskThread {
  return {
    id: row.id,
    taskId: row.task_id,
    threadId: row.thread_id,
    relation: row.relation,
    anchorMsgId: row.anchor_msg_id,
    createdAt: row.created_at,
    releasedAt: row.released_at,
    releaseReason: row.release_reason,
  }
}

function toCheckpoint(row: CheckpointRow): TaskCheckpoint {
  return {
    id: row.id,
    taskId: row.task_id,
    seq: row.seq,
    label: row.label,
    status: row.status,
    createdAt: row.created_at,
    closedAt: row.closed_at,
  }
}

function toTaskInput(row: TaskInputRow): TaskInput {
  return {
    id: row.id,
    taskId: row.task_id,
    inboxId: row.inbox_id,
    round: row.round,
    status: row.status,
    deliveredAt: row.delivered_at,
    readAt: row.read_at,
    errorCode: row.error_code,
    createdAt: row.created_at,
  }
}

function toResourceLock(row: ResourceLockRow): ResourceLock {
  return {
    id: row.id,
    resourceKey: row.resource_key,
    taskId: row.task_id,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    createdAt: row.created_at,
    releasedAt: row.released_at,
  }
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/.test(error.message)
}

function migrate(db: Database): void {
  db.exec(MIGRATIONS_DDL)
  const applied = db
    .prepare('SELECT MAX(version) AS version FROM schema_migrations WHERE module = ?')
    .get(MIGRATION_MODULE) as { version: number | null } | undefined
  let current = applied?.version ?? 0
  let hasRow = applied?.version !== null && applied?.version !== undefined

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue
    const version = migration.version
    db.transaction(() => {
      db.exec(migration.ddl)
      const stamp = new Date().toISOString()
      if (hasRow) {
        db.prepare('UPDATE schema_migrations SET version = ?, applied_at = ? WHERE module = ?')
          .run(version, stamp, MIGRATION_MODULE)
      } else {
        db.prepare('INSERT INTO schema_migrations(module, version, applied_at) VALUES (?, ?, ?)')
          .run(MIGRATION_MODULE, version, stamp)
        hasRow = true
      }
    }).immediate()
    current = version
  }
}

function optionalText(value: string | null | undefined, field: string): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') throw new TaskError('invalid-task', `${field} must be a string`)
  return value
}

function requiredText(value: string | null | undefined, field: string): string {
  const text = optionalText(value, field)
  if (text === null) throw new TaskError('invalid-input', `${field} must not be empty`)
  return text
}

function checkLockTtl(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_RESOURCE_TTL_SEC) {
    throw new TaskError('invalid-input', `ttlSec must be an integer within 1..${MAX_RESOURCE_TTL_SEC}`)
  }
  return value
}

function checkLockIds(ids: readonly string[]): string[] {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new TaskError('invalid-input', 'lockIds must not be empty')
  }
  for (const id of ids) {
    if (typeof id !== 'string' || id === '') {
      throw new TaskError('invalid-input', 'lockIds must be non-empty strings')
    }
  }
  return [...ids]
}

/** Short, unguessable routing hint (15 §9.2); no 0/1/i/l/o to avoid misreads. */
const TASK_REF_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz'

function generateTaskRef(): string {
  const bytes = randomBytes(10)
  let ref = ''
  for (const byte of bytes) ref += TASK_REF_ALPHABET[byte % TASK_REF_ALPHABET.length]
  return ref
}

export function createTaskStore(dbPath: string): TaskStore {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true })
  const db = new DatabaseConstructor(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000')
  migrate(db)

  const insertTask = db.prepare(`
    INSERT INTO tasks(
      id, project_id, conversation_id, session_id, start_cursor, intent, risk_level,
      status, plan_json, attempt, max_attempts, lease_owner, lease_expires_at,
      correlation_id, round, origin_msg_id, task_ref, created_at, started_at, finished_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, 0, ?, NULL, NULL, ?, ?, ?, ?, ?, NULL, NULL)
  `)
  const selectTask = db.prepare('SELECT * FROM tasks WHERE id = ?')
  const listTasksAll = db.prepare('SELECT * FROM tasks ORDER BY created_at ASC, rowid ASC')
  const listTasksByStatus = db.prepare(
    'SELECT * FROM tasks WHERE status = ? ORDER BY created_at ASC, rowid ASC',
  )
  const listTasksByProject = db.prepare(
    'SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at ASC, rowid ASC',
  )
  const updateTransition = db.prepare(`
    UPDATE tasks
       SET status = ?, attempt = ?, started_at = ?, finished_at = ?,
           lease_owner = NULL, lease_expires_at = NULL
     WHERE id = ?
  `)
  const updateIsolation = db.prepare(`
    UPDATE tasks
       SET isolation = ?, worktree_path = ?, base_commit = ?, branch = ?,
           merge_state = ?, prepare_state = ?, prepared_at = ?
     WHERE id = ?
  `)
  const selectWakeable = db.prepare(`
    SELECT id, attempt, max_attempts FROM tasks
     WHERE status = 'queued'
       AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
     ORDER BY created_at ASC, rowid ASC
     LIMIT 1
  `)
  const claimTaskRow = db.prepare(`
    UPDATE tasks
       SET status = 'running', attempt = attempt + 1, lease_owner = ?,
           lease_expires_at = ?, started_at = COALESCE(started_at, ?),
           finished_at = NULL, next_attempt_at = NULL
     WHERE id = ? AND status = 'queued' AND attempt < max_attempts
  `)
  const renewLeaseRow = db.prepare(`
    UPDATE tasks SET lease_expires_at = ?
     WHERE id = ? AND status = 'running' AND lease_owner = ?
  `)
  const requeueTaskRow = db.prepare(`
    UPDATE tasks
       SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL,
           next_attempt_at = ?
     WHERE id = ? AND status = 'running' AND lease_owner = ?
  `)
  const deferTaskRow = db.prepare(`
    UPDATE tasks
       SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL,
           next_attempt_at = ?,
           attempt = CASE WHEN attempt > 0 THEN attempt - 1 ELSE 0 END
     WHERE id = ? AND status = 'running' AND lease_owner = ?
  `)
  const listExpiredLeases = db.prepare(`
    SELECT id, attempt, max_attempts FROM tasks
     WHERE status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
     ORDER BY lease_expires_at ASC
     LIMIT ?
  `)
  const recoverExpiredRow = db.prepare(`
    UPDATE tasks
       SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL
     WHERE id = ? AND status = 'running' AND lease_expires_at <= ?
  `)

  const releaseExpiredLocks = db.prepare(`
    UPDATE resource_locks SET released_at = ?
     WHERE released_at IS NULL AND lease_expires_at <= ?
  `)
  const selectLiveLock = db.prepare(
    'SELECT * FROM resource_locks WHERE resource_key = ? AND released_at IS NULL',
  )
  const selectLock = db.prepare('SELECT * FROM resource_locks WHERE id = ?')
  const insertLock = db.prepare(`
    INSERT INTO resource_locks(
      id, resource_key, task_id, lease_owner, lease_expires_at, created_at, released_at
    ) VALUES (?, ?, ?, ?, ?, ?, NULL)
  `)
  const extendLock = db.prepare(
    'UPDATE resource_locks SET lease_expires_at = ? WHERE id = ? AND released_at IS NULL',
  )
  const releaseLock = db.prepare(
    'UPDATE resource_locks SET released_at = ? WHERE id = ? AND released_at IS NULL',
  )
  const releaseTaskLocks = db.prepare(
    'UPDATE resource_locks SET released_at = ? WHERE task_id = ? AND released_at IS NULL',
  )
  const listLocksAll = db.prepare(
    'SELECT * FROM resource_locks ORDER BY created_at ASC, rowid ASC',
  )
  const listLocksLive = db.prepare(`
    SELECT * FROM resource_locks
     WHERE released_at IS NULL AND lease_expires_at > ?
     ORDER BY created_at ASC, rowid ASC
  `)
  const listTaskLocksAll = db.prepare(
    'SELECT * FROM resource_locks WHERE task_id = ? ORDER BY created_at ASC, rowid ASC',
  )
  const listTaskLocksLive = db.prepare(`
    SELECT * FROM resource_locks
     WHERE task_id = ? AND released_at IS NULL AND lease_expires_at > ?
     ORDER BY created_at ASC, rowid ASC
  `)

  const insertEvent = db.prepare(`
    INSERT INTO task_events(id, task_id, seq, type, payload_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `)
  const nextSeq = db.prepare(
    'SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM task_events WHERE task_id = ?',
  )
  const listEventsStmt = db.prepare(
    'SELECT * FROM task_events WHERE task_id = ? ORDER BY seq ASC',
  )
  const latestEventStmt = db.prepare(
    'SELECT * FROM task_events WHERE task_id = ? ORDER BY seq DESC LIMIT 1',
  )

  const insertAssertion = db.prepare(`
    INSERT INTO task_assertions(id, task_id, kind, spec_json, status, evidence_json, checked_at)
    VALUES (?, ?, ?, ?, 'pending', NULL, NULL)
  `)
  const selectAssertion = db.prepare('SELECT * FROM task_assertions WHERE id = ?')
  const listAssertionsStmt = db.prepare(
    'SELECT * FROM task_assertions WHERE task_id = ? ORDER BY rowid ASC',
  )
  const setResult = db.prepare(
    'UPDATE task_assertions SET status = ?, evidence_json = ?, checked_at = ? WHERE id = ?',
  )

  const insertReceipt = db.prepare(`
    INSERT INTO receipts(
      id, task_id, round, summary, evidence_locator, external_msg_id, delivered_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
  `)
  const listReceiptsStmt = db.prepare(
    'SELECT * FROM receipts WHERE task_id = ? ORDER BY created_at ASC, rowid ASC',
  )
  const listPendingReceiptsStmt = db.prepare(`
    SELECT r.*, (
      SELECT tt.thread_id FROM task_threads tt
       WHERE tt.task_id = r.task_id AND tt.released_at IS NULL
       ORDER BY CASE tt.relation WHEN 'default_owner' THEN 0 ELSE 1 END,
                tt.created_at DESC, tt.rowid DESC
       LIMIT 1
    ) AS thread_id
      FROM receipts r
     WHERE r.delivered_at IS NULL
     ORDER BY r.created_at ASC, r.rowid ASC
     LIMIT ?
  `)
  const selectReceipt = db.prepare('SELECT * FROM receipts WHERE id = ?')
  const markReceiptDeliveredStmt = db.prepare(`
    UPDATE receipts SET delivered_at = ?, external_msg_id = ?
     WHERE id = ? AND delivered_at IS NULL
  `)

  const insertThread = db.prepare(`
    INSERT INTO task_threads(
      id, task_id, thread_id, relation, anchor_msg_id, created_at, released_at, release_reason
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)
  `)
  const selectThread = db.prepare('SELECT * FROM task_threads WHERE id = ?')
  const selectLiveThreadKey = db.prepare(`
    SELECT * FROM task_threads
     WHERE task_id = ? AND thread_id = ? AND relation = ?
       AND COALESCE(anchor_msg_id, '') = ?
       AND released_at IS NULL
  `)
  const selectLiveByPair = db.prepare(`
    SELECT * FROM task_threads
     WHERE task_id = ? AND thread_id = ? AND released_at IS NULL
     ORDER BY created_at ASC, rowid ASC
  `)
  const releaseThreadsByPair = db.prepare(`
    UPDATE task_threads
       SET released_at = ?, release_reason = ?
     WHERE task_id = ? AND thread_id = ? AND released_at IS NULL
  `)
  const selectLiveDefaultOwner = db.prepare(`
    SELECT tt.*, tk.status
      FROM task_threads tt
      JOIN tasks tk ON tk.id = tt.task_id
     WHERE tt.thread_id = ? AND tt.relation = 'default_owner' AND tt.released_at IS NULL
     ORDER BY tt.created_at ASC, tt.rowid ASC
  `)
  const selectOccupancy = db.prepare(`
    SELECT tt.task_id, tt.relation, tk.status
      FROM task_threads tt
      JOIN tasks tk ON tk.id = tt.task_id
     WHERE tt.thread_id = ? AND tt.released_at IS NULL
     ORDER BY tt.created_at ASC, tt.rowid ASC
  `)
  const listThreadsAll = db.prepare(
    'SELECT * FROM task_threads ORDER BY created_at ASC, rowid ASC',
  )
  const listThreadsByTask = db.prepare(
    'SELECT * FROM task_threads WHERE task_id = ? ORDER BY created_at ASC, rowid ASC',
  )
  const listThreadsByThread = db.prepare(
    'SELECT * FROM task_threads WHERE thread_id = ? ORDER BY created_at ASC, rowid ASC',
  )

  const insertInput = db.prepare(`
    INSERT INTO task_inputs(
      id, task_id, inbox_id, round, status, delivered_at, read_at, error_code, created_at
    ) VALUES (?, ?, ?, ?, 'pending', NULL, NULL, NULL, ?)
  `)
  const selectInput = db.prepare('SELECT * FROM task_inputs WHERE id = ?')
  const selectInputByDedup = db.prepare(
    'SELECT * FROM task_inputs WHERE task_id = ? AND inbox_id = ?',
  )
  const listPendingInputs = db.prepare(`
    SELECT * FROM task_inputs
     WHERE task_id = ? AND status = 'pending'
     ORDER BY round ASC, created_at ASC, rowid ASC
  `)
  const markDeliveredStmt = db.prepare(`
    UPDATE task_inputs SET status = 'delivered', delivered_at = ?
     WHERE id = ? AND status = 'pending'
  `)
  const markReadStmt = db.prepare(`
    UPDATE task_inputs SET status = 'read', read_at = ?
     WHERE id = ? AND status = 'delivered'
  `)

  const insertCheckpoint = db.prepare(`
    INSERT INTO task_checkpoints(id, task_id, seq, label, status, created_at, closed_at)
    VALUES (?, ?, ?, ?, 'open', ?, NULL)
  `)
  const selectCheckpoint = db.prepare('SELECT * FROM task_checkpoints WHERE id = ?')
  const listCheckpointsStmt = db.prepare(
    'SELECT * FROM task_checkpoints WHERE task_id = ? ORDER BY seq ASC',
  )
  const nextCheckpointSeq = db.prepare(
    'SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM task_checkpoints WHERE task_id = ?',
  )
  const closeCheckpointStmt = db.prepare(`
    UPDATE task_checkpoints SET status = ?, closed_at = ?
     WHERE id = ? AND status = 'open'
  `)

  const wakeTaskRow = db.prepare(`
    UPDATE tasks
       SET status = 'queued', round = round + 1, attempt = 0,
           lease_owner = NULL, lease_expires_at = NULL, next_attempt_at = NULL,
           started_at = NULL, finished_at = NULL
     WHERE id = ? AND status = 'succeeded'
  `)
  const countLiveThreads = db.prepare(
    'SELECT COUNT(*) AS n FROM task_threads WHERE task_id = ? AND released_at IS NULL',
  )

  // Approval gate (Slice I): both moves are conditional on the exact status, so
  // a racing writer loses instead of silently re-queueing the wrong state.
  const holdTaskRow = db.prepare(`
    UPDATE tasks SET status = 'waiting_approval'
     WHERE id = ? AND status = 'queued'
  `)
  const resumeFromApprovalRow = db.prepare(`
    UPDATE tasks
       SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL,
           next_attempt_at = ?, finished_at = NULL
     WHERE id = ? AND status = 'waiting_approval'
  `)
  // B3 v2 owner resume. `started_at` is cleared too: `claimTask` keeps the old
  // value via COALESCE, which would make the progress watchdog measure the new
  // run against the previous start and pause it almost immediately.
  const resumeTaskRow = db.prepare(`
    UPDATE tasks
       SET status = 'queued', attempt = 0, lease_owner = NULL,
           lease_expires_at = NULL, next_attempt_at = NULL,
           started_at = NULL, finished_at = NULL
     WHERE id = ? AND status = 'paused'
  `)
  // Slice AO: steering a running attempt is a new start, not a retry — the
  // attempt budget resets so a supplement cannot be starved by prior failures.
  const steerRunningRow = db.prepare(`
    UPDATE tasks
       SET intent = ?, status = 'queued', attempt = 0, lease_owner = NULL,
           lease_expires_at = NULL, next_attempt_at = NULL,
           started_at = NULL, finished_at = NULL
     WHERE id = ? AND status = 'running'
  `)
  const rewriteIntentRow = db.prepare('UPDATE tasks SET intent = ? WHERE id = ?')
  const markInputsReadForTask = db.prepare(`
    UPDATE task_inputs SET status = 'read', read_at = ?
     WHERE task_id = ? AND status = 'delivered'
  `)

  const getTask = (id: string): Task | null => {
    const row = selectTask.get(id) as TaskRow | undefined
    return row === undefined ? null : toTask(row)
  }

  function appendEvent(taskId: string, type: TaskEventType, payload?: Json): TaskEvent {
    const seqRow = nextSeq.get(taskId) as { seq: number }
    const event: TaskEvent = {
      id: uuidv7(),
      taskId,
      seq: seqRow.seq,
      type,
      payload: payload ?? null,
      createdAt: new Date().toISOString(),
    }
    insertEvent.run(
      event.id,
      event.taskId,
      event.seq,
      event.type,
      event.payload === null ? null : JSON.stringify(event.payload),
      event.createdAt,
    )
    return event
  }

  function writeReceipt(input: {
    taskId: string
    summary: string
    evidenceLocator?: string | null
    round?: number | null
    externalMsgId?: string | null
  }): Receipt {
    if (typeof input.summary !== 'string' || input.summary.trim() === '') {
      throw new TaskError('invalid-task', 'receipt summary must not be empty')
    }
    const receipt: Receipt = {
      id: uuidv7(),
      taskId: input.taskId,
      round: input.round ?? null,
      summary: input.summary,
      evidenceLocator: input.evidenceLocator ?? null,
      externalMsgId: input.externalMsgId ?? null,
      deliveredAt: null,
      createdAt: new Date().toISOString(),
    }
    insertReceipt.run(
      receipt.id,
      receipt.taskId,
      receipt.round,
      receipt.summary,
      receipt.evidenceLocator,
      receipt.externalMsgId,
      receipt.createdAt,
    )
    return receipt
  }

  function beginCheckpoint(input: BeginCheckpointInput): TaskCheckpoint {
    if (getTask(input.taskId) === null) {
      throw new TaskError('invalid-task', `task ${input.taskId} not found`)
    }
    return db.transaction(() => {
      const seqRow = nextCheckpointSeq.get(input.taskId) as { seq: number }
      const checkpoint: TaskCheckpoint = {
        id: uuidv7(),
        taskId: input.taskId,
        seq: seqRow.seq,
        label: input.label ?? null,
        status: 'open',
        createdAt: new Date().toISOString(),
        closedAt: null,
      }
      insertCheckpoint.run(
        checkpoint.id,
        checkpoint.taskId,
        checkpoint.seq,
        checkpoint.label,
        checkpoint.createdAt,
      )
      appendEvent(checkpoint.taskId, 'task.checkpoint', {
        phase: 'opened',
        checkpointId: checkpoint.id,
        seq: checkpoint.seq,
        label: checkpoint.label,
      })
      return checkpoint
    }).immediate()
  }

  function closeCheckpoint(id: string, status: 'committed' | 'aborted'): TaskCheckpoint {
    const row = selectCheckpoint.get(id) as CheckpointRow | undefined
    if (row === undefined) throw new TaskError('not-found', `checkpoint ${id} not found`)
    if (row.status !== 'open') {
      throw new TaskError('conflict', `checkpoint ${id} is already ${row.status}`)
    }
    const at = new Date().toISOString()
    closeCheckpointStmt.run(status, at, id)
    appendEvent(row.task_id, 'task.checkpoint', {
      phase: status,
      checkpointId: id,
      seq: row.seq,
    })
    return toCheckpoint(selectCheckpoint.get(id) as CheckpointRow)
  }

  /**
   * AR37: the owner replied into a thread whose task already finished. The
   * caller (③) re-verified first; here we only enforce that the task is still
   * `succeeded` and still owns a live subscription, then start a new round.
   */
  function wakeTask(input: WakeTaskInput): Task {
    const task = getTask(input.taskId)
    if (task === null) throw new TaskError('not-found', `task ${input.taskId} not found`)
    if (task.status !== 'succeeded') {
      throw new TaskError(
        'conflict',
        `only a succeeded task can be woken; ${task.id} is ${task.status}`,
      )
    }
    return db.transaction(() => {
      const live = countLiveThreads.get(task.id) as { n: number }
      if (live.n === 0) {
        throw new TaskError('conflict', `task ${task.id} has no live thread to wake into (AR37)`)
      }
      const changed = wakeTaskRow.run(task.id)
      if (changed.changes !== 1) {
        throw new TaskError('conflict', `task ${task.id} is no longer succeeded`)
      }
      appendEvent(task.id, 'task.woken', {
        from: task.status,
        previousRound: task.round,
        round: task.round + 1,
        ...input.reason === undefined ? {} : { reason: input.reason },
      })
      return getTask(task.id) as Task
    }).immediate()
  }

  /**
   * Slice I: park a R2/R3 task before the worker can lease it. The worker only
   * claims `queued`, so this is the gate — not a flag the executor has to trust.
   */
  function holdForApproval(input: HoldTaskInput): Task {
    const task = getTask(input.taskId)
    if (task === null) throw new TaskError('not-found', `task ${input.taskId} not found`)
    if (task.status !== 'queued') {
      throw new TaskError('conflict', `only a queued task can be held; ${task.id} is ${task.status}`)
    }
    return db.transaction(() => {
      const changed = holdTaskRow.run(task.id)
      if (changed.changes !== 1) {
        throw new TaskError('conflict', `task ${task.id} left queued before it could be held`)
      }
      appendEvent(task.id, 'task.waiting_approval', {
        from: 'queued',
        to: 'waiting_approval',
        ...input.reason === undefined ? {} : { reason: input.reason },
      })
      return getTask(task.id) as Task
    }).immediate()
  }

  /**
   * Slice I: an approved task goes back to `queued` (not straight to `running`) —
   * only `claimTask` may enter `running`, and it must take the lease.
   */
  function resumeFromApproval(input: ResumeFromApprovalInput): ResumeFromApprovalResult {
    const task = getTask(input.taskId)
    if (task === null) return { resumed: false, task: null, reason: 'not-found' }
    if (task.status !== 'waiting_approval') {
      return { resumed: false, task, reason: 'not-waiting' }
    }
    const nowIso = (input.now ?? new Date()).toISOString()
    const resumed = db.transaction(() => {
      const changed = resumeFromApprovalRow.run(nowIso, task.id)
      if (changed.changes !== 1) return false
      appendEvent(task.id, 'task.resumed', {
        from: 'waiting_approval',
        to: 'queued',
        approvalId: input.approvalId,
        ...input.actorId === undefined ? {} : { actorId: input.actorId },
      })
      return true
    }).immediate()
    const after = getTask(task.id) as Task
    return resumed
      ? { resumed: true, task: after }
      : { resumed: false, task: after, reason: 'not-waiting' }
  }

  /**
   * B3 v2: the owner replied `继续 <ref>` to a watchdog pause. Unlike
   * `transition`, this resets the attempt counter — the resume is the owner's
   * explicit grant of a fresh retry budget, so a task that exhausted its
   * attempts while stalled can run again from the top.
   */
  function resumeTask(taskId: string): Task {
    const task = getTask(taskId)
    if (task === null) throw new TaskError('invalid-task', `task ${taskId} not found`)
    if (task.status !== 'paused') {
      throw new TaskError(
        'invalid-transition',
        `only a paused task can be resumed; ${task.id} is ${task.status}`,
      )
    }
    return db.transaction(() => {
      const changed = resumeTaskRow.run(task.id)
      if (changed.changes !== 1) {
        throw new TaskError('invalid-transition', `task ${task.id} is no longer paused`)
      }
      appendEvent(task.id, 'task.resumed', { from: 'paused', to: 'queued', reason: 'control:resume' })
      return getTask(task.id) as Task
    }).immediate()
  }

  function steerTask(input: SteerTaskInput): SteerTaskResult {
    const task = getTask(input.taskId)
    if (task === null) throw new TaskError('invalid-task', `task ${input.taskId} not found`)
    const supplement = input.text.trim()
    if (supplement === '') throw new TaskError('invalid-input', 'supplement text is empty')
    const row = selectInput.get(input.inputId) as TaskInputRow | undefined
    if (row === undefined || row.task_id !== task.id) {
      throw new TaskError('not-found', `task input ${input.inputId} does not belong to ${task.id}`)
    }
    const intent = `${task.intent}\n\n补充指令：${supplement}`
    return db.transaction(() => {
      let applied: SteerTaskResult['applied']
      if (task.status === 'running') {
        if (steerRunningRow.run(intent, task.id).changes !== 1) {
          throw new TaskError('conflict', `task ${task.id} is no longer running`)
        }
        applied = 'rerun'
      } else if (task.status === 'paused') {
        rewriteIntentRow.run(intent, task.id)
        if (resumeTaskRow.run(task.id).changes !== 1) {
          throw new TaskError('conflict', `task ${task.id} is no longer paused`)
        }
        applied = 'rerun'
      } else if (task.status === 'queued') {
        rewriteIntentRow.run(intent, task.id)
        applied = 'merged'
      } else if (task.status === 'waiting_approval' || task.status === 'waiting_input') {
        rewriteIntentRow.run(intent, task.id)
        applied = 'recorded'
      } else {
        throw new TaskError('conflict', `cannot steer a ${task.status} task`)
      }
      markDeliveredStmt.run(new Date().toISOString(), input.inputId)
      appendEvent(task.id, 'task.steered', {
        applied,
        inputId: input.inputId,
        ...applied === 'rerun' ? { to: 'queued', reason: 'owner:supplement' } : {},
      })
      return { task: getTask(task.id) as Task, applied }
    }).immediate()
  }

  /** Shared by `transition` and lease recovery (recovery must also write a receipt). */
  function doTransition(taskId: string, input: TransitionInput): Task {
    const task = getTask(taskId)
    if (task === null) throw new TaskError('invalid-task', `task ${taskId} not found`)
    assertTransition(task.status, input.to)

    const at = new Date().toISOString()
    const terminal = isTerminal(input.to)
    if (terminal && (input.summary === undefined || input.summary.trim() === '')) {
      throw new TaskError('invalid-task', 'terminal transitions require a receipt summary')
    }
    const attempt = input.to === 'running' ? task.attempt + 1 : task.attempt
    const startedAt = task.startedAt ?? (input.to === 'running' ? at : null)
    const finishedAt = terminal ? at : null

    db.transaction(() => {
      updateTransition.run(input.to, attempt, startedAt, finishedAt, taskId)
      appendEvent(taskId, eventTypeFor(task.status, input.to), {
        from: task.status,
        to: input.to,
        ...input.reason === undefined ? {} : { reason: input.reason },
      })
      if (terminal) {
        const receipt = writeReceipt({
          taskId,
          round: task.round,
          summary: input.summary ?? input.to,
          evidenceLocator: input.evidenceLocator ?? null,
        })
        appendEvent(taskId, 'task.receipt', { receiptId: receipt.id, round: receipt.round })
      }
    }).immediate()

    return getTask(taskId) as Task
  }

  return {
    createTask(input) {
      if (typeof input.intent !== 'string' || input.intent.trim() === '') {
        throw new TaskError('invalid-task', 'intent must not be empty')
      }
      if (input.intent.length > 500) {
        throw new TaskError('invalid-task', 'intent exceeds 500 characters')
      }
      if (!['R0', 'R1', 'R2', 'R3'].includes(input.riskLevel)) {
        throw new TaskError('invalid-task', `unknown risk level ${JSON.stringify(input.riskLevel)}`)
      }
      const maxAttempts = input.maxAttempts ?? 2
      if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
        throw new TaskError('invalid-task', 'maxAttempts must be an integer in 1..10')
      }
      const round = input.round ?? 1
      if (!Number.isInteger(round) || round < 1) {
        throw new TaskError('invalid-task', 'round must be a positive integer')
      }
      // Slice Y: a plan may declare non-file resources. Validate at creation so
      // a typo fails fast instead of parking the task forever at execution.
      if (input.plan !== undefined && input.plan !== null) {
        try {
          declaredResources(input.plan)
        } catch (error) {
          throw new TaskError(
            'invalid-task',
            `invalid plan.resources: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }

      const task: Task = {
        id: uuidv7(),
        projectId: optionalText(input.projectId, 'projectId'),
        conversationId: optionalText(input.conversationId, 'conversationId'),
        sessionId: optionalText(input.sessionId, 'sessionId'),
        startCursor: optionalText(input.startCursor, 'startCursor'),
        intent: input.intent.trim(),
        riskLevel: input.riskLevel,
        status: 'queued',
        plan: input.plan ?? null,
        attempt: 0,
        maxAttempts,
        leaseOwner: null,
        leaseExpiresAt: null,
        correlationId: input.correlationId ?? uuidv7(),
        round,
        originMsgId: optionalText(input.originMsgId, 'originMsgId'),
        taskRef: null,
        isolation: 'serial',
        worktreePath: null,
        baseCommit: null,
        branch: null,
        mergeState: 'none',
        prepareState: 'none',
        preparedAt: null,
        createdAt: new Date().toISOString(),
        startedAt: null,
        finishedAt: null,
      }

      // task_ref collision retries ≥3 times, then creation fails (15 §9.2).
      let inserted = false
      for (let attempt = 0; attempt < 4 && !inserted; attempt += 1) {
        task.taskRef = generateTaskRef()
        try {
          db.transaction(() => {
            insertTask.run(
              task.id,
              task.projectId,
              task.conversationId,
              task.sessionId,
              task.startCursor,
              task.intent,
              task.riskLevel,
              task.plan === null ? null : JSON.stringify(task.plan),
              task.maxAttempts,
              task.correlationId,
              task.round,
              task.originMsgId,
              task.taskRef,
              task.createdAt,
            )
            appendEvent(task.id, 'task.created', {
              riskLevel: task.riskLevel,
              round: task.round,
              intent: task.intent,
            })
          }).immediate()
          inserted = true
        } catch (error) {
          if (!isUniqueViolation(error) || attempt === 3) throw error
        }
      }
      return task
    },

    getTask,

    listTasks(filter) {
      const limit = filter?.limit === undefined ? undefined : Math.max(1, Math.floor(filter.limit))
      let rows: TaskRow[]
      if (filter?.status !== undefined) {
        rows = listTasksByStatus.all(filter.status) as TaskRow[]
      } else if (filter?.projectId !== undefined) {
        rows = listTasksByProject.all(filter.projectId) as TaskRow[]
      } else {
        rows = listTasksAll.all() as TaskRow[]
      }
      const tasks = rows.map(toTask)
      const filtered = filter?.status !== undefined && filter?.projectId !== undefined
        ? tasks.filter((task) => task.projectId === filter.projectId)
        : tasks
      return limit === undefined ? filtered : filtered.slice(0, limit)
    },

    claimTask(input) {
      const owner = requiredText(input.owner, 'owner')
      if (!Number.isInteger(input.leaseMs) || input.leaseMs <= 0) {
        throw new TaskError('invalid-input', 'leaseMs must be a positive integer')
      }
      const now = input.now ?? new Date()
      const nowIso = now.toISOString()
      const leaseUntil = new Date(now.getTime() + input.leaseMs).toISOString()
      return db.transaction(() => {
        const candidate = selectWakeable.get(nowIso) as { id: string } | undefined
        if (candidate === undefined) return null
        const claimed = claimTaskRow.run(owner, leaseUntil, nowIso, candidate.id)
        if (claimed.changes !== 1) return null
        const task = getTask(candidate.id) as Task
        appendEvent(task.id, 'task.started', {
          owner,
          leaseExpiresAt: leaseUntil,
          attempt: task.attempt,
        })
        // A steered supplement was delivered into the intent; the claim is the
        // moment it is actually consumed.
        markInputsReadForTask.run(nowIso, candidate.id)
        return task
      }).immediate()
    },

    renewLease(input) {
      if (!Number.isInteger(input.leaseMs) || input.leaseMs <= 0) {
        throw new TaskError('invalid-input', 'leaseMs must be a positive integer')
      }
      const now = input.now ?? new Date()
      const leaseUntil = new Date(now.getTime() + input.leaseMs).toISOString()
      return renewLeaseRow.run(leaseUntil, input.taskId, input.owner).changes === 1
    },

    requeueTask(input) {
      const task = getTask(input.taskId)
      if (task === null) throw new TaskError('invalid-task', `task ${input.taskId} not found`)
      assertTransition(task.status, 'queued')
      if (task.leaseOwner !== input.owner) {
        throw new TaskError('conflict', `task ${input.taskId} is leased by another worker`)
      }
      const now = input.now ?? new Date()
      const wakeAt = new Date(now.getTime() + Math.max(0, input.delayMs)).toISOString()
      db.transaction(() => {
        const changed = requeueTaskRow.run(wakeAt, input.taskId, input.owner)
        if (changed.changes !== 1) {
          throw new TaskError('conflict', `task ${input.taskId} lost its lease`)
        }
        appendEvent(input.taskId, 'task.retried', {
          wakeAt,
          attempt: task.attempt,
          maxAttempts: task.maxAttempts,
          ...input.reason === undefined ? {} : { reason: input.reason },
        })
      }).immediate()
      return getTask(input.taskId) as Task
    },

    deferTask(input) {
      const task = getTask(input.taskId)
      if (task === null) throw new TaskError('invalid-task', `task ${input.taskId} not found`)
      assertTransition(task.status, 'queued')
      if (task.leaseOwner !== input.owner) {
        throw new TaskError('conflict', `task ${input.taskId} is leased by another worker`)
      }
      const now = input.now ?? new Date()
      const wakeAt = new Date(now.getTime() + Math.max(0, input.delayMs)).toISOString()
      db.transaction(() => {
        const changed = deferTaskRow.run(wakeAt, input.taskId, input.owner)
        if (changed.changes !== 1) {
          throw new TaskError('conflict', `task ${input.taskId} lost its lease`)
        }
        appendEvent(input.taskId, 'task.deferred', {
          wakeAt,
          reason: input.reason,
          ...input.blocking === undefined ? {} : { blocking: input.blocking as unknown as Json },
        })
      }).immediate()
      return getTask(input.taskId) as Task
    },

    recoverExpiredLeases(input) {
      const now = (input?.now ?? new Date()).toISOString()
      const limit = Math.max(1, Math.floor(input?.limit ?? 50))
      const requeued: string[] = []
      const failed: string[] = []
      const expired = listExpiredLeases.all(now, limit) as Array<{
        id: string
        attempt: number
        max_attempts: number
      }>
      for (const row of expired) {
        if (row.attempt < row.max_attempts) {
          const changed = recoverExpiredRow.run(row.id, now)
          if (changed.changes === 1) {
            appendEvent(row.id, 'task.retried', { reason: 'lease-expired', attempt: row.attempt })
            requeued.push(row.id)
          }
          continue
        }
        // Out of attempts: terminal, with a receipt — never silently stuck.
        doTransition(row.id, {
          to: 'failed',
          summary: `lease expired after ${row.attempt} attempt(s)`,
          reason: 'lease-expired',
        })
        failed.push(row.id)
      }
      return { requeued, failed }
    },

    transition(taskId, input) {
      return doTransition(taskId, input)
    },

    addAssertion(taskId, assertion) {
      if (getTask(taskId) === null) {
        throw new TaskError('invalid-task', `task ${taskId} not found`)
      }
      const id = uuidv7()
      insertAssertion.run(id, taskId, assertion.kind, JSON.stringify(assertion.spec))
      return toAssertion(selectAssertion.get(id) as AssertionRow)
    },

    listAssertions(taskId) {
      return (listAssertionsStmt.all(taskId) as AssertionRow[]).map(toAssertion)
    },

    setAssertionResult(assertionId, result) {
      const changes = setResult.run(
        result.status,
        result.evidence === null ? null : JSON.stringify(result.evidence),
        result.checkedAt,
        assertionId,
      ).changes
      if (changes === 0) throw new TaskError('invalid-assertion', `assertion ${assertionId} not found`)
      return toAssertion(selectAssertion.get(assertionId) as AssertionRow)
    },

    appendEvent(taskId, type, payload) {
      if (getTask(taskId) === null) {
        throw new TaskError('invalid-task', `task ${taskId} not found`)
      }
      return appendEvent(taskId, type, payload)
    },

    listEvents(taskId, limit) {
      const events = (listEventsStmt.all(taskId) as EventRow[]).map(toEvent)
      if (limit === undefined) return events
      return events.slice(0, Math.max(1, Math.floor(limit)))
    },

    latestEvent(taskId) {
      const row = latestEventStmt.get(taskId) as EventRow | undefined
      return row === undefined ? null : toEvent(row)
    },

    writeReceipt,

    listReceipts(taskId) {
      return (listReceiptsStmt.all(taskId) as ReceiptRow[]).map(toReceipt)
    },

    pendingReceipts(limit) {
      const capped = limit === undefined ? 50 : Math.max(1, Math.floor(limit))
      return (listPendingReceiptsStmt.all(capped) as PendingReceiptRow[]).map((row) => ({
        ...toReceipt(row),
        threadId: row.thread_id,
      }))
    },

    markReceiptDelivered(id, externalMsgId) {
      if (typeof externalMsgId !== 'string' || externalMsgId.trim() === '') {
        throw new TaskError('invalid-input', 'externalMsgId must not be empty')
      }
      const row = selectReceipt.get(id) as ReceiptRow | undefined
      if (row === undefined) throw new TaskError('not-found', `receipt ${id} not found`)
      if (row.delivered_at === null) {
        markReceiptDeliveredStmt.run(new Date().toISOString(), externalMsgId.trim(), id)
      }
      return toReceipt(selectReceipt.get(id) as ReceiptRow)
    },

    bindThread(input) {
      if (input.relation !== 'default_owner' && input.relation !== 'anchor') {
        throw new TaskError('invalid-input', `unknown relation ${JSON.stringify(input.relation)}`)
      }
      if (typeof input.threadId !== 'string' || input.threadId.trim() === '') {
        throw new TaskError('invalid-input', 'threadId must not be empty')
      }
      const anchorMsgId = optionalText(input.anchorMsgId, 'anchorMsgId')
      if (input.relation === 'anchor' && anchorMsgId === null) {
        throw new TaskError('invalid-input', 'anchor subscriptions require anchorMsgId')
      }
      if (getTask(input.taskId) === null) {
        throw new TaskError('not-found', `task ${input.taskId} not found`)
      }

      // Idempotent on the same live key (15 §9.7).
      const existing = selectLiveThreadKey.get(
        input.taskId,
        input.threadId,
        input.relation,
        anchorMsgId ?? '',
      ) as TaskThreadRow | undefined
      if (existing !== undefined) return toTaskThread(existing)

      // A finished task still holds its default_owner so AR37 wake and rollback
      // keep a live subscription; but it must not block the chat's next task.
      // A `paused` owner (approval rejected, and with no resume entry yet) is in
      // the same position: release it when the chat starts something new instead
      // of at pause time, so an explicit resume still finds its binding.
      if (input.relation === 'default_owner') {
        const live = selectLiveDefaultOwner.all(input.threadId) as Array<
          TaskThreadRow & { status: TaskStatus }
        >
        for (const owner of live) {
          if (owner.task_id === input.taskId) continue
          if (!isTerminal(owner.status) && owner.status !== 'paused') continue
          releaseThreadsByPair.run(
            new Date().toISOString(),
            'superseded',
            owner.task_id,
            input.threadId,
          )
        }
      }

      const row: TaskThreadRow = {
        id: uuidv7(),
        task_id: input.taskId,
        thread_id: input.threadId,
        relation: input.relation,
        anchor_msg_id: anchorMsgId,
        created_at: new Date().toISOString(),
        released_at: null,
        release_reason: null,
      }
      try {
        insertThread.run(
          row.id,
          row.task_id,
          row.thread_id,
          row.relation,
          row.anchor_msg_id,
          row.created_at,
        )
      } catch (error) {
        if (!isUniqueViolation(error)) throw error
        const raced = selectLiveThreadKey.get(
          input.taskId,
          input.threadId,
          input.relation,
          anchorMsgId ?? '',
        ) as TaskThreadRow | undefined
        if (raced !== undefined) return toTaskThread(raced)
        // A second live default_owner on the same thread is never preempted.
        throw new TaskError(
          'conflict',
          `thread ${input.threadId} already has a live default owner (15 §9.6)`,
        )
      }
      return toTaskThread(selectThread.get(row.id) as TaskThreadRow)
    },

    releaseThread(input) {
      const reasons: readonly ThreadReleaseReason[] = ['handback', 'stopped', 'superseded', 'failed']
      if (!reasons.includes(input.reason)) {
        throw new TaskError('invalid-input', `unknown release reason ${JSON.stringify(input.reason)}`)
      }
      const at = new Date().toISOString()
      const released = db.transaction(() => {
        const live = selectLiveByPair.all(input.taskId, input.threadId) as TaskThreadRow[]
        if (live.length === 0) return []
        releaseThreadsByPair.run(at, input.reason, input.taskId, input.threadId)
        return live.map((row) => toTaskThread({
          ...row,
          released_at: at,
          release_reason: input.reason,
        }))
      }).immediate()
      return released
    },

    occupancy(threadId) {
      const live: string[] = []
      const wakeable: string[] = []
      let defaultOwnerTaskId: string | null = null
      for (const row of selectOccupancy.all(threadId) as OccupancyRow[]) {
        if (row.relation === 'default_owner' && defaultOwnerTaskId === null) {
          defaultOwnerTaskId = row.task_id
        }
        if (isTerminal(row.status)) {
          if (row.status === 'succeeded' && !wakeable.includes(row.task_id)) wakeable.push(row.task_id)
        } else if (!live.includes(row.task_id)) {
          live.push(row.task_id)
        }
      }
      return { defaultOwnerTaskId, live, wakeable }
    },

    listTaskThreads(filter) {
      const rows = filter?.taskId !== undefined
        ? listThreadsByTask.all(filter.taskId) as TaskThreadRow[]
        : filter?.threadId !== undefined
          ? listThreadsByThread.all(filter.threadId) as TaskThreadRow[]
          : listThreadsAll.all() as TaskThreadRow[]
      const threads = rows.map(toTaskThread)
      return filter?.liveOnly === true
        ? threads.filter((thread) => thread.releasedAt === null)
        : threads
    },

    enqueueInput(input) {
      if (typeof input.inboxId !== 'string' || input.inboxId.trim() === '') {
        throw new TaskError('invalid-input', 'inboxId must not be empty')
      }
      const task = getTask(input.taskId)
      if (task === null) throw new TaskError('not-found', `task ${input.taskId} not found`)

      const existing = selectInputByDedup.get(input.taskId, input.inboxId) as TaskInputRow | undefined
      if (existing !== undefined) return toTaskInput(existing)

      const id = uuidv7()
      try {
        // round always comes from the task, never from the caller (15 §9.1).
        insertInput.run(id, input.taskId, input.inboxId, task.round, new Date().toISOString())
      } catch (error) {
        if (!isUniqueViolation(error)) throw error
        const raced = selectInputByDedup.get(input.taskId, input.inboxId) as TaskInputRow | undefined
        if (raced === undefined) throw error
        return toTaskInput(raced)
      }
      return toTaskInput(selectInput.get(id) as TaskInputRow)
    },

    pendingInputs(taskId) {
      return (listPendingInputs.all(taskId) as TaskInputRow[]).map(toTaskInput)
    },

    markInputDelivered(id) {
      const row = selectInput.get(id) as TaskInputRow | undefined
      if (row === undefined) throw new TaskError('not-found', `task input ${id} not found`)
      if (row.status === 'delivered' || row.status === 'read') return toTaskInput(row)
      if (row.status !== 'pending') {
        throw new TaskError('conflict', `cannot deliver a ${row.status} task input`)
      }
      markDeliveredStmt.run(new Date().toISOString(), id)
      return toTaskInput(selectInput.get(id) as TaskInputRow)
    },

    markInputRead(id) {
      const row = selectInput.get(id) as TaskInputRow | undefined
      if (row === undefined) throw new TaskError('not-found', `task input ${id} not found`)
      if (row.status === 'read') return toTaskInput(row)
      if (row.status !== 'delivered') {
        throw new TaskError('conflict', `cannot read a ${row.status} task input`)
      }
      markReadStmt.run(new Date().toISOString(), id)
      return toTaskInput(selectInput.get(id) as TaskInputRow)
    },

    wakeTask,

    holdForApproval,

    resumeFromApproval,

    resumeTask,

    steerTask,

    beginCheckpoint,

    getCheckpoint(id) {
      const row = selectCheckpoint.get(id) as CheckpointRow | undefined
      return row === undefined ? null : toCheckpoint(row)
    },

    listCheckpoints(taskId) {
      return (listCheckpointsStmt.all(taskId) as CheckpointRow[]).map(toCheckpoint)
    },

    closeCheckpoint,

    setIsolation(taskId, patch) {
      const current = selectTask.get(taskId) as TaskRow | undefined
      if (current === undefined) throw new TaskError('not-found', `task ${taskId} not found`)
      const next = {
        isolation: patch.isolation ?? current.isolation,
        worktreePath: patch.worktreePath === undefined ? current.worktree_path : patch.worktreePath,
        baseCommit: patch.baseCommit === undefined ? current.base_commit : patch.baseCommit,
        branch: patch.branch === undefined ? current.branch : patch.branch,
        mergeState: patch.mergeState ?? current.merge_state,
        prepareState: patch.prepareState ?? current.prepare_state,
        preparedAt: patch.preparedAt === undefined ? current.prepared_at : patch.preparedAt,
      }
      // SQLite cannot express "worktree ⇒ path/base/branch" across ALTER'd
      // columns, so the module API refuses the partial state instead of guessing.
      if (next.isolation === 'worktree' && (next.worktreePath === null || next.baseCommit === null || next.branch === null)) {
        throw new TaskError('invalid-task', 'worktree isolation needs worktreePath, baseCommit and branch')
      }
      if (next.prepareState !== 'none' && next.isolation !== 'worktree') {
        throw new TaskError('invalid-task', 'prepare state is only meaningful for worktree isolation')
      }
      // 15 §10.5: merge progress is a separate post-terminal dimension with its
      // own allowlist; `none → merged` (skipping `pending`) is not a legal edge.
      if (next.mergeState !== current.merge_state) {
        assertMergeTransition(current.merge_state, next.mergeState)
      }
      if (next.mergeState !== 'none' && next.isolation !== 'worktree') {
        throw new TaskError('invalid-task', 'merge state is only meaningful for worktree isolation')
      }
      updateIsolation.run(
        next.isolation,
        next.worktreePath,
        next.baseCommit,
        next.branch,
        next.mergeState,
        next.prepareState,
        next.preparedAt,
        taskId,
      )
      return toTask(selectTask.get(taskId) as TaskRow)
    },

    acquireResourceLocks(input) {
      const task = selectTask.get(input.taskId) as TaskRow | undefined
      if (task === undefined) throw new TaskError('not-found', `task ${input.taskId} not found`)
      const ttlSec = checkLockTtl(input.ttlSec)
      const keys = normalizeResourceKeys(input.keys)
      const at = input.now ?? new Date()
      const nowIso = at.toISOString()
      const expiresAt = new Date(at.getTime() + ttlSec * 1_000).toISOString()

      const run = db.transaction((): AcquireResourceLocksResult => {
        // 15 §10.4: 失租即释放。Sweep before reading so an expired row never
        // blocks a new holder, even if nobody called release on it.
        releaseExpiredLocks.run(nowIso, nowIso)
        const conflicts: ResourceLockConflict[] = []
        for (const key of keys) {
          const row = selectLiveLock.get(key) as ResourceLockRow | undefined
          // Same task re-acquiring is idempotent: a resumed attempt (or a new
          // worker that took over the lease) must not conflict with itself.
          if (row !== undefined && row.task_id !== input.taskId) {
            conflicts.push({ key, taskId: row.task_id, leaseExpiresAt: row.lease_expires_at })
          }
        }
        if (conflicts.length > 0) return { acquired: [], conflicts, expiresAt }

        const acquired: ResourceLock[] = []
        for (const key of keys) {
          const row = selectLiveLock.get(key) as ResourceLockRow | undefined
          if (row !== undefined) {
            extendLock.run(expiresAt, row.id)
            acquired.push(toResourceLock(selectLock.get(row.id) as ResourceLockRow))
            continue
          }
          const id = uuidv7()
          insertLock.run(id, key, input.taskId, input.owner ?? null, expiresAt, nowIso)
          acquired.push(toResourceLock(selectLock.get(id) as ResourceLockRow))
        }
        return { acquired, conflicts: [], expiresAt }
      })
      return run.immediate()
    },

    heartbeatResourceLocks(input) {
      const ttlSec = checkLockTtl(input.ttlSec)
      const ids = checkLockIds(input.lockIds)
      const at = input.now ?? new Date()
      const nowIso = at.toISOString()
      const expiresAt = new Date(at.getTime() + ttlSec * 1_000).toISOString()

      const run = db.transaction((): HeartbeatResourceLocksResult => {
        releaseExpiredLocks.run(nowIso, nowIso)
        const liveIds: string[] = []
        for (const id of ids) {
          const row = selectLock.get(id) as ResourceLockRow | undefined
          if (row === undefined || row.released_at !== null) continue
          extendLock.run(expiresAt, id)
          liveIds.push(id)
        }
        return { extended: liveIds.length, liveIds, expiresAt }
      })
      return run.immediate()
    },

    releaseResourceLocks(lockIds, at) {
      if (!Array.isArray(lockIds) || lockIds.length === 0) return 0
      const stamp = (at ?? new Date()).toISOString()
      let released = 0
      const run = db.transaction(() => {
        for (const id of lockIds) released += releaseLock.run(stamp, id).changes
      })
      run.immediate()
      return released
    },

    releaseTaskResourceLocks(taskId, at) {
      return releaseTaskLocks.run((at ?? new Date()).toISOString(), taskId).changes
    },

    listResourceLocks(filter) {
      const nowIso = (filter?.now ?? new Date()).toISOString()
      const rows = filter?.includeReleased === true
        ? filter.taskId === undefined
          ? listLocksAll.all()
          : listTaskLocksAll.all(filter.taskId)
        : filter?.taskId === undefined
          ? listLocksLive.all(nowIso)
          : listTaskLocksLive.all(filter.taskId, nowIso)
      return (rows as ResourceLockRow[]).map(toResourceLock)
    },

    close() {
      db.close()
    },
  }
}
